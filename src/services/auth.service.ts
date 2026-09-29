import { bytesToBase64 } from '../crypto/encoding'
import {
  SALT_BYTES,
  decryptDatabase,
  deriveKey,
  deriveKeyAndVerifier,
  encryptDatabase,
  generateDek,
  randomBytes,
  unwrapDek,
  wrapDek,
} from '../crypto/crypto.service'
import { applySchema } from '../db/schema'
import { seedCategories, seedRoles } from '../db/seed'
import { getSetting, setSetting } from '../db/settings'
import { SqlDatabase } from '../db/sqlite'
import { recordFromSession, wrapsFromRecord, type VaultRecord } from '../db/storage'
import { AuthError, ValidationError } from '../domain/errors'
import { isCurrency, type OpenVault, type SessionUser, type UserWrap } from '../domain/types'
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
    `SELECT u.id, u.email, u.role_id, u.group_id, r.name AS role_name, r.permissions
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
  }
}

function roleId(db: SqlDatabase, name: string): number {
  const value = db.queryValue('SELECT id FROM roles WHERE name = ?', [name])
  if (value == null) throw new Error(`Missing role ${name}`)
  return Number(value)
}

async function seal(db: SqlDatabase, dek: CryptoKey, wraps: UserWrap[]): Promise<VaultRecord> {
  const exported = db.export()
  const sealed = await encryptDatabase(exported, dek)
  return recordFromSession({
    wraps,
    iv: sealed.iv,
    ciphertext: sealed.cipherText,
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
    applySchema(db)
    seedRoles(db)
    seedCategories(db)
    db.exec('INSERT INTO groups (name) VALUES (?)', [displayName])
    const userId = crypto.randomUUID()
    const salt = randomBytes(SALT_BYTES)
    const { key, verifier } = await deriveKeyAndVerifier(input.password, salt)
    const dek = await generateDek()
    const wrapped = await wrapDek(dek, key)
    db.withTransaction(() => {
      db.exec(
        `INSERT INTO users (id, email, password_hash, salt, role_id, group_id)
         VALUES (?, ?, ?, ?, ?, NULL)`,
        [userId, email, verifier, bytesToBase64(salt), roleId(db, 'Admin')],
      )
      setSetting(db, 'currency', input.currency)
      setSetting(db, 'vault_name', displayName)
      writeAudit(db, userId, 'VAULT_CREATED', 'vault', 'primary', { email })
    })
    const wrap: UserWrap = {
      userId,
      email,
      salt,
      iv: wrapped.iv,
      wrappedDek: wrapped.cipherText,
    }
    const user = loadUser(db, email)
    if (!user) throw new Error('Admin user was not created')
    const record = await seal(db, dek, [wrap])
    return {
      vault: {
        db,
        dek,
        wraps: [wrap],
        user,
        currency: input.currency,
        vaultName: displayName,
      },
      record,
    }
  } catch (error) {
    db.close()
    throw error
  }
}

export async function unlockVault(record: VaultRecord, email: string, password: string): Promise<OpenVault> {
  const normalized = normalizeEmail(email)
  const stored = record.wraps.find((wrap) => wrap.email.toLowerCase() === normalized)
  if (!stored) throw new AuthError()
  try {
    const wraps = wrapsFromRecord(record)
    const wrap = wraps.find((item) => item.email.toLowerCase() === normalized)
    if (!wrap) throw new AuthError()
    const kek = await deriveKey(password, wrap.salt)
    const dek = await unwrapDek(wrap.wrappedDek, kek, wrap.iv)
    const plain = await decryptDatabase(record.payload.ciphertext, dek, new Uint8Array(record.payload.iv))
    const db = await SqlDatabase.openBytes(plain)
    const user = loadUser(db, normalized)
    if (!user) {
      db.close()
      throw new AuthError()
    }
    return {
      db,
      dek,
      wraps,
      user,
      currency: getSetting(db, 'currency') ?? 'USD',
      vaultName: getSetting(db, 'vault_name') ?? 'Moliya',
    }
  } catch (error) {
    if (error instanceof AuthError) throw error
    throw new AuthError()
  }
}

export async function sealVault(vault: OpenVault): Promise<VaultRecord> {
  return seal(vault.db, vault.dek, vault.wraps)
}

export { loadUser }
