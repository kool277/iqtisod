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
} from '../crypto/crypto.service'
import { auditHead } from '../db/audit-chain'
import { assertKnownSchema, migrate, readSchemaVersion, type MigrationResult } from '../db/migrations'
import { seedCategories, seedRoles, syncRolePermissions } from '../db/seed'
import { getSetting, setSetting } from '../db/settings'
import { SqlDatabase, type SqlValue } from '../db/sqlite'
import { newUserWrap, unwrapUserDek } from '../crypto/user-wrap'
import { grantsFromRecord, recordFromSession, wrapsFromRecord, type VaultRecord } from '../db/storage'
import { SCHEMA_VERSION } from '../db/versions'
import { AuthError, ValidationError } from '../domain/errors'
import { isCurrency, type GrantWrap, type OpenVault, type SessionUser, type UserWrap } from '../domain/types'
import { assertEmail, normalizeEmail } from '../lib/email'
import { LIMITS } from '../lib/limits'
import { assertNewPassword } from '../lib/password-policy'
import { APP_VERSION } from '../lib/version'
import { writeAudit } from './audit.service'
import { observeClock } from '../lib/device-clock'
import { recordClock, sweepGrants } from './grant-store'
import { userStatus } from './user-profile'

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
  return userFromRow(
    db.queryOne(
      `SELECT u.id, u.email, u.role_id, u.group_id, u.must_change_password, r.name AS role_name, r.permissions
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.email = ?`,
      [email],
    ),
  )
}

function loadUserById(db: SqlDatabase, id: string): SessionUser | null {
  return userFromRow(
    db.queryOne(
      `SELECT u.id, u.email, u.role_id, u.group_id, u.must_change_password, r.name AS role_name, r.permissions
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.id = ?`,
      [id],
    ),
  )
}

function userFromRow(row: Record<string, SqlValue> | null): SessionUser | null {
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

async function seal(db: SqlDatabase, dek: CryptoKey, wraps: UserWrap[], grants: GrantWrap[], createdAt: string | null): Promise<VaultRecord> {
  const now = Date.now()
  observeClock(now)
  if (readSchemaVersion(db) >= 4) recordClock(db, now)
  const exported = db.export()
  let sealed: Awaited<ReturnType<typeof encryptDatabase>>
  try {
    sealed = await encryptDatabase(exported, dek)
  } finally {
    exported.fill(0)
  }
  return recordFromSession({
    wraps,
    grants,
    iv: sealed.iv,
    ciphertext: sealed.cipherText,
    schemaVersion: readSchemaVersion(db),
    createdAt,
    updatedAt: new Date().toISOString(),
    audit: auditHead(db),
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
    const wrap = await newUserWrap(dek, key, { userId, email, kdf, salt })
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
  const next = await newUserWrap(dek, key, { userId, email: wrap.email, kdf, salt })
  await unwrapUserDek(next, key)
  db.withTransaction(() => {
    db.exec('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?', [verifier, bytesToBase64(salt), userId])
    if (kdfChanged) writeAudit(db, userId, 'CREDENTIALS_UPGRADED', 'user', userId, { from: wrap.kdf, to: kdf })
  })
  Object.assign(wrap, next)
}

/**
 * The plain-text wrap labels are not authenticated on older wraps, so the wrap must belong to the user row it names,
 * and that row's salt and check value must be the ones this password produced. Otherwise a member who relabels their
 * own wrap would be signed in as someone else and overwrite that person's credentials.
 */
function assertWrapOwner(db: SqlDatabase, wrap: UserWrap, email: string, verifier: string): SessionUser {
  const user = loadUserById(db, wrap.userId)
  if (!user || user.email !== email || wrap.email.toLowerCase() !== email) throw new AuthError()
  const row = db.queryOne('SELECT password_hash, salt FROM users WHERE id = ?', [user.id])
  if (!row || String(row.salt) !== bytesToBase64(wrap.salt)) throw new AuthError()
  const stored = String(row.password_hash ?? '')
  // Empty until the first sign-in after migration 3; anything else must be this password's check value.
  if (stored !== '' && stored !== verifier) throw new AuthError()
  return user
}

export function decryptRecordBody(record: VaultRecord, dek: CryptoKey): Promise<Uint8Array> {
  return decryptDatabase(record.body.ciphertext, dek, new Uint8Array(record.body.iv))
}

/** Checks the schema is one this app wrote, then migrates. The caller owns the returned handle. */
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
    vaultName: getSetting(db, 'vault_name') ?? 'Jaybi',
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
    dek = await unwrapUserDek(wrap, derived.key)
    plain = await decryptRecordBody(record, dek)
  } catch {
    throw new AuthError()
  }
  let opened: Awaited<ReturnType<typeof openRecordDatabase>>
  try {
    opened = await openRecordDatabase(plain)
  } finally {
    plain.fill(0)
  }
  const { db, migration } = opened
  try {
    const user = assertWrapOwner(db, wrap, normalized, verifier)
    // Suspension removes the password copy; this also refuses a copy put back from an older envelope.
    if (userStatus(db, user.id) !== 'ACTIVE') throw new AuthError()
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
    await unwrapUserDek(wrap, await deriveKey(password, wrap.salt, wrap.kdf))
  } catch {
    throw new AuthError()
  }
}

export async function sealVault(vault: OpenVault): Promise<VaultRecord> {
  return seal(vault.db, vault.dek, vault.wraps, vault.grants, vault.createdAt)
}

export { loadUser }
