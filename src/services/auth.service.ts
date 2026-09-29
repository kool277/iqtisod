import { bytesToBase64 } from '../crypto/encoding'
import {
  CURRENT_KDF,
  SALT_BYTES,
  decryptDatabase,
  deriveKey,
  deriveKeyAndVerifier,
  encryptDatabase,
  generateDek,
  kdfNeedsUpgrade,
  randomBytes,
  unwrapDek,
  wrapDek,
} from '../crypto/crypto.service'
import { migrate, readSchemaVersion } from '../db/migrations'
import { seedCategories, seedRoles, syncRolePermissions } from '../db/seed'
import { getSetting, setSetting } from '../db/settings'
import { SqlDatabase } from '../db/sqlite'
import { recordFromSession, wrapsFromRecord, type VaultRecord } from '../db/storage'
import { AuthError, ValidationError } from '../domain/errors'
import { isCurrency, type OpenVault, type SessionUser, type UserWrap } from '../domain/types'
import { APP_VERSION } from '../lib/version'
import { writeAudit } from './audit.service'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type SetupInput = {
  email: string
  password: string
  displayName: string
  currency: string
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function assertEmail(email: string): void {
  if (!EMAIL_PATTERN.test(email)) throw new ValidationError('EMAIL')
}

export function assertPassword(password: string): void {
  if (password.length < 8) throw new ValidationError('PASSWORD_SHORT')
}

function loadUser(db: SqlDatabase, email: string): SessionUser | null {
  const row = db.queryOne(
    `SELECT u.id, u.email, u.role_id, u.group_id, u.must_change_password, r.name AS role_name, r.permissions
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.email = ?`,
    [email],
  )
  if (!row) return null
  let permissions: string[] = []
  try {
    const parsed = JSON.parse(String(row.permissions)) as unknown
    if (Array.isArray(parsed)) permissions = parsed.map(String)
  } catch {
    permissions = []
  }
  return {
    id: String(row.id),
    email: String(row.email),
    roleName: String(row.role_name),
    roleId: Number(row.role_id),
    groupId: row.group_id == null ? null : Number(row.group_id),
    permissions,
    mustChangePassword: Number(row.must_change_password) === 1,
  }
}

function roleId(db: SqlDatabase, name: string): number {
  const value = db.queryValue('SELECT id FROM roles WHERE name = ?', [name])
  if (value == null) throw new Error(`Missing role ${name}`)
  return Number(value)
}

async function seal(db: SqlDatabase, dek: CryptoKey, wraps: UserWrap[], createdAt: string | null): Promise<VaultRecord> {
  const exported = db.export()
  const sealed = await encryptDatabase(exported, dek)
  return recordFromSession({
    wraps,
    iv: sealed.iv,
    ciphertext: sealed.cipherText,
    schemaVersion: readSchemaVersion(db),
    createdAt,
    updatedAt: new Date().toISOString(),
  })
}

export async function createVault(input: SetupInput): Promise<{ vault: OpenVault; record: VaultRecord }> {
  const email = normalizeEmail(input.email)
  assertEmail(email)
  assertPassword(input.password)
  const displayName = input.displayName.trim()
  if (!displayName) throw new ValidationError('REQUIRED')
  if (!isCurrency(input.currency)) throw new ValidationError('CURRENCY')

  const db = await SqlDatabase.openEmpty()
  try {
    migrate(db, { appVersion: APP_VERSION })
    seedRoles(db)
    seedCategories(db)
    db.exec('INSERT INTO groups (name) VALUES (?)', [displayName])
    const userId = crypto.randomUUID()
    const salt = randomBytes(SALT_BYTES)
    const kdf = { ...CURRENT_KDF }
    const { key, verifier } = await deriveKeyAndVerifier(input.password, salt, kdf)
    const dek = await generateDek()
    const wrapped = await wrapDek(dek, key)
    const createdAt = new Date().toISOString()
    db.withTransaction(() => {
      db.exec(
        `INSERT INTO users (id, email, password_hash, salt, role_id, group_id)
         VALUES (?, ?, ?, ?, ?, NULL)`,
        [userId, email, verifier, bytesToBase64(salt), roleId(db, 'Admin')],
      )
      setSetting(db, 'currency', input.currency)
      setSetting(db, 'vault_name', displayName)
      setSetting(db, 'vault_created_at', createdAt)
      writeAudit(db, userId, 'VAULT_CREATED', 'vault', 'primary', { email, appVersion: APP_VERSION })
    })
    const wrap: UserWrap = { userId, email, kdf, salt, iv: wrapped.iv, wrappedDek: wrapped.cipherText }
    const user = loadUser(db, email)
    if (!user) throw new Error('Admin user was not created')
    const record = await seal(db, dek, [wrap], createdAt)
    return {
      vault: {
        db,
        dek,
        wraps: [wrap],
        user,
        currency: input.currency,
        vaultName: displayName,
        createdAt,
        lastBackupAt: null,
        needsSave: false,
      },
      record,
    }
  } catch (error) {
    db.close()
    throw error
  }
}

async function strengthenWrap(db: SqlDatabase, dek: CryptoKey, wrap: UserWrap, password: string, userId: string): Promise<void> {
  const salt = randomBytes(SALT_BYTES)
  const kdf = { ...CURRENT_KDF }
  const { key, verifier } = await deriveKeyAndVerifier(password, salt, kdf)
  const wrapped = await wrapDek(dek, key)
  await unwrapDek(wrapped.cipherText, key, wrapped.iv)
  db.withTransaction(() => {
    db.exec('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?', [verifier, bytesToBase64(salt), userId])
    writeAudit(db, userId, 'CREDENTIALS_UPGRADED', 'user', userId, { from: wrap.kdf, to: kdf })
  })
  wrap.kdf = kdf
  wrap.salt = salt
  wrap.iv = wrapped.iv
  wrap.wrappedDek = wrapped.cipherText
}

export async function unlockVault(record: VaultRecord, email: string, password: string): Promise<OpenVault> {
  const normalized = normalizeEmail(email)
  const wraps = wrapsFromRecord(record)
  const wrap = wraps.find((item) => item.email.toLowerCase() === normalized)
  if (!wrap) throw new AuthError()
  let dek: CryptoKey
  let plain: Uint8Array
  let verifier: string
  try {
    const derived = await deriveKeyAndVerifier(password, wrap.salt, wrap.kdf)
    verifier = derived.verifier
    dek = await unwrapDek(wrap.wrappedDek, derived.key, wrap.iv)
    plain = await decryptDatabase(record.body.ciphertext, dek, new Uint8Array(record.body.iv))
  } catch {
    throw new AuthError()
  }
  const db = await SqlDatabase.openBytes(plain)
  try {
    const migration = migrate(db, { appVersion: APP_VERSION })
    syncRolePermissions(db)
    const user = loadUser(db, normalized)
    if (!user) throw new AuthError()
    if (migration.applied.length > 0) {
      writeAudit(db, user.id, 'SCHEMA_MIGRATED', 'vault', 'primary', {
        from: migration.from,
        to: migration.to,
        appVersion: APP_VERSION,
      })
    }
    const strengthen = kdfNeedsUpgrade(wrap.kdf)
    let verifierUpgraded = false
    if (strengthen) {
      await strengthenWrap(db, dek, wrap, password, user.id)
    } else if (db.queryValue('SELECT password_hash FROM users WHERE id = ?', [user.id]) !== verifier) {
      db.exec('UPDATE users SET password_hash = ? WHERE id = ?', [verifier, user.id])
      verifierUpgraded = true
    }
    const currency = getSetting(db, 'currency')
    return {
      db,
      dek,
      wraps,
      user,
      currency: currency && isCurrency(currency) ? currency : 'USD',
      vaultName: getSetting(db, 'vault_name') ?? 'Moliya',
      createdAt: record.createdAt ?? getSetting(db, 'vault_created_at'),
      lastBackupAt: getSetting(db, 'last_backup_at'),
      needsSave: migration.applied.length > 0 || strengthen || verifierUpgraded,
    }
  } catch (error) {
    db.close()
    throw error
  }
}

export async function verifyOwnPassword(vault: OpenVault, password: string): Promise<void> {
  const wrap = vault.wraps.find((item) => item.userId === vault.user.id)
  if (!wrap) throw new AuthError()
  try {
    await unwrapDek(wrap.wrappedDek, await deriveKey(password, wrap.salt, wrap.kdf), wrap.iv)
  } catch {
    throw new AuthError()
  }
}

export async function sealVault(vault: OpenVault): Promise<VaultRecord> {
  return seal(vault.db, vault.dek, vault.wraps, vault.createdAt)
}

export { loadUser }
