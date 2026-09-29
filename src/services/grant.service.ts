import { deriveGrantKeys, grantAad, unwrapGrantDek, wrapDekForGrant } from '../crypto/access-crypto'
import { CURRENT_KDF, SALT_BYTES, deriveKeyAndVerifier, randomBytes, wrapDek } from '../crypto/crypto.service'
import { bytesToBase64, cloneBytes } from '../crypto/encoding'
import { getSetting } from '../db/settings'
import type { SqlDatabase } from '../db/sqlite'
import { wrapsFromRecord, type VaultRecord } from '../db/storage'
import { ForbiddenError, ValidationError, isUniqueViolation } from '../domain/errors'
import { isRoleName, type GrantWrap, type OpenVault, type RoleName, type UserWrap } from '../domain/types'
import { generateAccessCode, normalizeAccessCode } from '../lib/access-code'
import { assertEmail, normalizeEmail } from '../lib/email'
import { LIMITS } from '../lib/limits'
import { assertNewPassword, assertPasswordLength } from '../lib/password-policy'
import { Permission, canUser } from '../rbac'
import { writeAudit } from './audit.service'
import { buildOpenVault, decryptRecordBody, loadUser, openRecordDatabase, recordMigration, spendPasswordWork } from './auth.service'
import {
  CLOCK_KEY,
  CLOCK_TOLERANCE_MS,
  dropEnvelopeGrant,
  endGrant,
  grantAuditAction,
  grantRow,
  openGrantRows,
  type GrantRow,
} from './grant-store'
import { dropTotp } from './totp.service'
import { checkUserGroup, roleIdByName } from './user.service'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

export const GRANT_VALIDITY = {
  '15m': 15 * MINUTE,
  '1h': HOUR,
  '24h': 24 * HOUR,
  '72h': 72 * HOUR,
  '7d': 7 * 24 * HOUR,
} as const

export type GrantValidity = keyof typeof GRANT_VALIDITY
export const DEFAULT_GRANT_VALIDITY: GrantValidity = '24h'

export function isGrantValidity(value: string): value is GrantValidity {
  return Object.hasOwn(GRANT_VALIDITY, value)
}

/** Returned once to the issuing admin; the code is never stored or logged. */
export type IssuedGrant = { id: string; kind: GrantRow['kind']; email: string; code: string; expiresAt: string }

export type GrantSummary = {
  id: string
  kind: GrantRow['kind']
  email: string
  roleName: string | null
  groupName: string | null
  createdAt: string
  expiresAt: string
  expired: boolean
  stopOldPassword: boolean
}

export type RedeemInput = { kind: GrantRow['kind']; email: string; code: string; password: string }

function assertManager(vault: OpenVault): void {
  if (!canUser(vault.user, Permission.MANAGE_USERS)) throw new ForbiddenError()
}

function assertClock(db: SqlDatabase, now: Date): void {
  const highWater = getSetting(db, CLOCK_KEY)
  if (highWater && now.getTime() < Date.parse(highWater) - CLOCK_TOLERANCE_MS) throw new ValidationError('CLOCK_BEHIND')
}

function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return diff === 0
}

async function mintGrant(dek: CryptoKey, kind: GrantRow['kind'], email: string): Promise<{ code: string; wrap: GrantWrap; verifier: string }> {
  const id = crypto.randomUUID()
  const access = generateAccessCode()
  const salt = randomBytes(SALT_BYTES)
  const kdf = { ...CURRENT_KDF }
  const { kek, verifier } = await deriveGrantKeys(access.canonical, salt, kdf)
  const wrapped = await wrapDekForGrant(dek, kek, grantAad(id, kind, email))
  return { code: access.display, verifier, wrap: { id, kind, email, kdf, salt, iv: wrapped.iv, wrappedDek: wrapped.cipherText } }
}

function expiryFor(now: Date, validity: GrantValidity): string {
  return new Date(now.getTime() + GRANT_VALIDITY[validity]).toISOString()
}

export async function createInvite(
  vault: OpenVault,
  input: { email: string; roleName: RoleName; groupId: number | null; validity: GrantValidity },
  now = new Date(),
): Promise<IssuedGrant> {
  assertManager(vault)
  if (!isRoleName(input.roleName)) throw new ValidationError('ROLE')
  if (!isGrantValidity(input.validity)) throw new ValidationError('REQUIRED')
  const email = normalizeEmail(input.email)
  assertEmail(email)
  if (vault.db.queryValue('SELECT 1 FROM users WHERE email = ?', [email]) != null) throw new ValidationError('DUPLICATE_EMAIL')
  const open = openGrantRows(vault.db)
  if (open.some((grant) => grant.email === email)) throw new ValidationError('GRANT_OPEN')
  if (open.filter((grant) => grant.kind === 'INVITE').length >= LIMITS.openInvites) throw new ValidationError('INVITE_LIMIT')
  if (vault.grants.length >= LIMITS.grants) throw new ValidationError('INVITE_LIMIT')
  const groupId = checkUserGroup(vault, input.groupId, input.roleName)
  const roleId = roleIdByName(vault, input.roleName)
  assertClock(vault.db, now)
  const { code, wrap, verifier } = await mintGrant(vault.dek, 'INVITE', email)
  const createdAt = now.toISOString()
  const expiresAt = expiryFor(now, input.validity)
  try {
    vault.db.withTransaction(() => {
      vault.db.exec(
        `INSERT INTO access_grants (id, kind, email, user_id, role_id, group_id, code_verifier, stop_old_password, created_by, created_at, expires_at)
         VALUES (?, 'INVITE', ?, NULL, ?, ?, ?, 0, ?, ?, ?)`,
        [wrap.id, email, roleId, groupId, verifier, vault.user.id, createdAt, expiresAt],
      )
      writeAudit(vault.db, vault.user.id, 'INVITE_CREATED', 'grant', wrap.id, { email, role: input.roleName, groupId, expiresAt })
    })
  } catch (error) {
    if (isUniqueViolation(error)) throw new ValidationError('GRANT_OPEN')
    throw error
  }
  vault.grants.push(wrap)
  return { id: wrap.id, kind: 'INVITE', email, code, expiresAt }
}

export async function issueReset(
  vault: OpenVault,
  userId: string,
  input: { validity: GrantValidity; stopOldPassword: boolean },
  now = new Date(),
): Promise<IssuedGrant> {
  assertManager(vault)
  if (userId === vault.user.id) throw new ValidationError('USE_ACCOUNT')
  if (!isGrantValidity(input.validity)) throw new ValidationError('REQUIRED')
  const email = vault.db.queryValue('SELECT email FROM users WHERE id = ?', [userId])
  if (email == null) throw new ValidationError('REQUIRED')
  const target = String(email)
  const open = openGrantRows(vault.db).filter((grant) => grant.email === target)
  if (vault.grants.length - open.length >= LIMITS.grants) throw new ValidationError('INVITE_LIMIT')
  assertClock(vault.db, now)
  const { code, wrap, verifier } = await mintGrant(vault.dek, 'RESET', target)
  const createdAt = now.toISOString()
  const expiresAt = expiryFor(now, input.validity)
  const stop = input.stopOldPassword
  vault.db.withTransaction(() => {
    for (const grant of open) {
      endGrant(vault.db, grant.id, 'REPLACED', vault.user.id, createdAt)
      writeAudit(vault.db, vault.user.id, grantAuditAction(grant.kind, 'REVOKED'), 'grant', grant.id, { email: target, reason: 'REPLACED' })
    }
    vault.db.exec(
      `INSERT INTO access_grants (id, kind, email, user_id, role_id, group_id, code_verifier, stop_old_password, created_by, created_at, expires_at)
       VALUES (?, 'RESET', ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
      [wrap.id, target, userId, verifier, stop ? 1 : 0, vault.user.id, createdAt, expiresAt],
    )
    writeAudit(vault.db, vault.user.id, 'RESET_ISSUED', 'grant', wrap.id, { email: target, userId, expiresAt, stopOldPassword: stop })
  })
  for (const grant of open) dropEnvelopeGrant(vault, grant.id)
  vault.grants.push(wrap)
  if (stop) vault.wraps = vault.wraps.filter((item) => item.userId !== userId)
  return { id: wrap.id, kind: 'RESET', email: target, code, expiresAt }
}

export function revokeGrant(vault: OpenVault, id: string, now = new Date()): void {
  assertManager(vault)
  const row = grantRow(vault.db, id)
  if (!row || row.endedAt) throw new ValidationError('REQUIRED')
  vault.db.withTransaction(() => {
    endGrant(vault.db, id, 'REVOKED', vault.user.id, now.toISOString())
    writeAudit(vault.db, vault.user.id, grantAuditAction(row.kind, 'REVOKED'), 'grant', id, { email: row.email })
  })
  dropEnvelopeGrant(vault, id)
}

export function listGrants(vault: OpenVault, now = new Date()): GrantSummary[] {
  assertManager(vault)
  const at = now.toISOString()
  return vault.db
    .query(
      `SELECT a.id, a.kind, a.email, a.created_at, a.expires_at, a.stop_old_password, r.name AS role_name, g.name AS group_name
       FROM access_grants a
       LEFT JOIN roles r ON r.id = a.role_id
       LEFT JOIN groups g ON g.id = a.group_id
       WHERE a.ended_at IS NULL
       ORDER BY a.created_at DESC`,
    )
    .map((row) => ({
      id: String(row.id),
      kind: row.kind === 'RESET' ? 'RESET' : 'INVITE',
      email: String(row.email),
      roleName: row.role_name == null ? null : String(row.role_name),
      groupName: row.group_name == null ? null : String(row.group_name),
      createdAt: String(row.created_at),
      expiresAt: String(row.expires_at),
      expired: String(row.expires_at) <= at,
      stopOldPassword: Number(row.stop_old_password) === 1,
    }))
}

function invalid(): ValidationError {
  return new ValidationError('INVITE_INVALID')
}

/** Opens the vault with a one-time code, sets the member's password and ends the grant. The caller must save right away. */
export async function redeemGrant(record: VaultRecord, input: RedeemInput, now = new Date()): Promise<OpenVault> {
  const email = normalizeEmail(input.email)
  assertEmail(email)
  const canonical = normalizeAccessCode(input.code)
  assertPasswordLength(input.password)
  const grant = (record.grants ?? []).find((item) => item.kind === input.kind && item.email === email)
  if (!grant) {
    await spendPasswordWork(canonical)
    throw invalid()
  }
  let dek: CryptoKey
  let verifier: string
  let plain: Uint8Array
  try {
    const keys = await deriveGrantKeys(canonical, cloneBytes(grant.salt), grant.kdf)
    verifier = keys.verifier
    dek = await unwrapGrantDek(grant.wrappedDek, keys.kek, cloneBytes(grant.iv), grantAad(grant.id, grant.kind, grant.email))
    plain = await decryptRecordBody(record, dek)
  } catch {
    throw invalid()
  }
  const { db, migration } = await openRecordDatabase(plain)
  try {
    const row = grantRow(db, grant.id)
    if (!row || row.endedAt || row.kind !== grant.kind || row.email !== email || !sameHex(row.codeVerifier, verifier)) throw invalid()
    assertClock(db, now)
    const at = now.toISOString()
    if (row.expiresAt <= at) throw new ValidationError('INVITE_EXPIRED')
    await assertNewPassword(input.password, { email, vaultName: getSetting(db, 'vault_name') ?? undefined })

    const salt = randomBytes(SALT_BYTES)
    const kdf = { ...CURRENT_KDF }
    const derived = await deriveKeyAndVerifier(input.password, salt, kdf)
    const wrapped = await wrapDek(dek, derived.key)
    const wraps = wrapsFromRecord(record)
    let userId: string
    if (row.kind === 'INVITE') {
      if (db.queryValue('SELECT 1 FROM users WHERE email = ?', [email]) != null) throw new ValidationError('DUPLICATE_EMAIL')
      const roleName = db.queryValue('SELECT name FROM roles WHERE id = ?', [row.roleId])
      if (roleName == null || !isRoleName(String(roleName))) throw new ValidationError('ROLE')
      if (String(roleName) !== 'Admin' && row.groupId == null) throw new ValidationError('GROUP')
      userId = crypto.randomUUID()
      const newUserId = userId
      db.withTransaction(() => {
        db.exec(
          `INSERT INTO users (id, email, password_hash, salt, role_id, group_id, must_change_password, password_changed_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
          [newUserId, email, derived.verifier, bytesToBase64(salt), row.roleId, row.groupId, at],
        )
        endGrant(db, row.id, 'USED', newUserId, at)
        writeAudit(db, newUserId, 'INVITE_ACCEPTED', 'grant', row.id, { email, role: String(roleName), groupId: row.groupId })
      })
    } else {
      const target = db.queryOne('SELECT id, email FROM users WHERE id = ?', [row.userId])
      if (!target || String(target.email) !== email) throw invalid()
      userId = String(target.id)
      const resetUserId = userId
      db.withTransaction(() => {
        db.exec('UPDATE users SET password_hash = ?, salt = ?, must_change_password = 0, password_changed_at = ? WHERE id = ?', [
          derived.verifier,
          bytesToBase64(salt),
          at,
          resetUserId,
        ])
        dropTotp(db, resetUserId, resetUserId, 'PASSWORD_RESET')
        endGrant(db, row.id, 'USED', resetUserId, at)
        writeAudit(db, resetUserId, 'RESET_COMPLETED', 'grant', row.id, { email })
      })
    }
    const user = loadUser(db, email)
    if (!user) throw invalid()
    recordMigration(db, user.id, migration)
    const wrap: UserWrap = { userId, email, kdf, salt, iv: wrapped.iv, wrappedDek: wrapped.cipherText }
    const index = wraps.findIndex((item) => item.userId === userId)
    if (index >= 0) wraps[index] = wrap
    else wraps.push(wrap)
    return buildOpenVault(record, { db, dek, wraps, user, needsSave: true }, now)
  } catch (error) {
    db.close()
    throw error
  }
}
