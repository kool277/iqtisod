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
import { assertKnownSchema, migrate, readSchemaVersion, type MigrationResult } from '../db/migrations'
import { seedCategories, seedRoles, syncRolePermissions } from '../db/seed'
import { getSetting, setSetting } from '../db/settings'
import { SqlDatabase } from '../db/sqlite'
import { grantsFromRecord, recordFromSession, wrapsFromRecord, type VaultRecord } from '../db/storage'
import { SCHEMA_VERSION } from '../db/versions'
import { AuthError, ValidationError } from '../domain/errors'
import { isCurrency, type GrantWrap, type OpenVault, type SessionUser, type UserWrap } from '../domain/types'
import { assertEmail, normalizeEmail } from '../lib/email'
import { LIMITS } from '../lib/limits'
import { assertNewPassword } from '../lib/password-policy'
import { APP_VERSION } from '../lib/version'
import { writeAudit } from './audit.service'
import { CLOCK_KEY, sweepGrants } from './grant-store'

export { assertEmail, normalizeEmail }

export type SetupInput = {
  email: string
  password: string
  displayName: string
  currency: string
}

export function assertDisplayName(value: string): string {
  const name = value.trim()
  if (!name) throw new ValidationError('REQUIRED')
  if (name.length > LIMITS.nameChars) throw new ValidationError('TOO_LONG')
  return name
}

/** Spends the same PBKDF2 work as a real attempt so unknown addresses are not faster to reject. */
export async function spendPasswordWork(password: string): Promise<void> {
  try {
    await deriveKeyAndVerifier(password, randomBytes(SALT_BYTES), CURRENT_KDF)
  } catch {
    // Timing only.
  }
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

function recordClock(db: SqlDatabase, now: string): void {
  const previous = getSetting(db, CLOCK_KEY)
  if (!previous || previous < now) setSetting(db, CLOCK_KEY, now)
}

async function seal(db: SqlDatabase, dek: CryptoKey, wraps: UserWrap[], grants: GrantWrap[], createdAt: string | null): Promise<VaultRecord> {
  if (readSchemaVersion(db) >= 4) recordClock(db, new Date().toISOString())
  const exported = db.export()
  const sealed = await encryptDatabase(exported, dek)
  return recordFromSession({
    wraps,
    grants,
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
  const displayName = assertDisplayName(input.displayName)
  await assertNewPassword(input.password, { email, vaultName: displayName })
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
    const record = await seal(db, dek, [wrap], [], createdAt)
    return {
      vault: {
        db,
        dek,
        wraps: [wrap],
        grants: [],
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
  const kdfChanged = kdfNeedsUpgrade(wrap.kdf)
  const { key, verifier } = await deriveKeyAndVerifier(password, salt, kdf)
  const wrapped = await wrapDek(dek, key)
  await unwrapDek(wrapped.cipherText, key, wrapped.iv)
  db.withTransaction(() => {
    db.exec('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?', [verifier, bytesToBase64(salt), userId])
    if (kdfChanged) writeAudit(db, userId, 'CREDENTIALS_UPGRADED', 'user', userId, { from: wrap.kdf, to: kdf })
  })
  wrap.kdf = kdf
  wrap.salt = salt
  wrap.iv = wrapped.iv
  wrap.wrappedDek = wrapped.cipherText
}

export function decryptRecordBody(record: VaultRecord, dek: CryptoKey): Promise<Uint8Array> {
  return decryptDatabase(record.body.ciphertext, dek, new Uint8Array(record.body.iv))
}

/** Checks the schema is one Moliya wrote, then migrates. The caller owns the returned handle. */
export async function openRecordDatabase(plain: Uint8Array): Promise<{ db: SqlDatabase; migration: MigrationResult }> {
  const db = await SqlDatabase.openBytes(plain)
  try {
    await assertKnownSchema(db)
    const migration = migrate(db, { appVersion: APP_VERSION })
    if (migration.applied.length > 0) await assertKnownSchema(db, SCHEMA_VERSION)
    syncRolePermissions(db)
    return { db, migration }
  } catch (error) {
    db.close()
    throw error
  }
}

export function recordMigration(db: SqlDatabase, actorId: string, migration: MigrationResult): void {
  if (migration.applied.length === 0) return
  writeAudit(db, actorId, 'SCHEMA_MIGRATED', 'vault', 'primary', {
    from: migration.from,
    to: migration.to,
    appVersion: APP_VERSION,
  })
}

/** Builds the session and ends grants that expired or lost their envelope wrap. */
export function buildOpenVault(
  record: VaultRecord,
  parts: { db: SqlDatabase; dek: CryptoKey; wraps: UserWrap[]; user: SessionUser; needsSave: boolean },
  now = new Date(),
): OpenVault {
  const { db } = parts
  const currency = getSetting(db, 'currency')
  const vault: OpenVault = {
    db,
    dek: parts.dek,
    wraps: parts.wraps,
    grants: grantsFromRecord(record),
    user: parts.user,
    currency: currency && isCurrency(currency) ? currency : 'USD',
    vaultName: getSetting(db, 'vault_name') ?? 'Moliya',
    createdAt: record.createdAt ?? getSetting(db, 'vault_created_at'),
    lastBackupAt: getSetting(db, 'last_backup_at'),
    needsSave: parts.needsSave,
  }
  if (sweepGrants(vault, now) > 0) vault.needsSave = true
  return vault
}

export async function unlockVault(record: VaultRecord, email: string, password: string, now = new Date()): Promise<OpenVault> {
  const normalized = normalizeEmail(email)
  const wraps = wrapsFromRecord(record)
  const wrap = wraps.find((item) => item.email.toLowerCase() === normalized)
  if (!wrap) {
    await spendPasswordWork(password)
    throw new AuthError()
  }
  let dek: CryptoKey
  let plain: Uint8Array
  let verifier: string
  try {
    const derived = await deriveKeyAndVerifier(password, wrap.salt, wrap.kdf)
    verifier = derived.verifier
    dek = await unwrapDek(wrap.wrappedDek, derived.key, wrap.iv)
    plain = await decryptRecordBody(record, dek)
  } catch {
    throw new AuthError()
  }
  const { db, migration } = await openRecordDatabase(plain)
  try {
    const user = loadUser(db, normalized)
    if (!user) throw new AuthError()
    recordMigration(db, user.id, migration)
    // A legacy hash was the raw KEK for this salt, so re-salting makes any copy of it useless.
    const strengthen = kdfNeedsUpgrade(wrap.kdf) || db.queryValue('SELECT password_hash FROM users WHERE id = ?', [user.id]) !== verifier
    if (strengthen) await strengthenWrap(db, dek, wrap, password, user.id)
    return buildOpenVault(record, { db, dek, wraps, user, needsSave: migration.applied.length > 0 || strengthen }, now)
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
  return seal(vault.db, vault.dek, vault.wraps, vault.grants, vault.createdAt)
}

export { loadUser }
