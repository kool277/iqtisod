import { deriveGrantKeys, grantAad, unwrapGrantDek, wrapDekForGrant } from '../crypto/access-crypto'
import { CURRENT_KDF, SALT_BYTES, deriveKeyAndVerifier, randomBytes } from '../crypto/crypto.service'
import { bytesToBase64, cloneBytes } from '../crypto/encoding'
import { newUserWrap } from '../crypto/user-wrap'
import { getSetting, setSetting } from '../db/settings'
import type { SqlDatabase } from '../db/sqlite'
import { wrapsFromRecord, type VaultRecord } from '../db/storage'
import { ForbiddenError, ValidationError, isUniqueViolation } from '../domain/errors'
import { isRoleName, type GrantWrap, type OpenVault, type RoleName } from '../domain/types'
import { generateAccessCode, normalizeAccessCode } from '../lib/access-code'
import { assertEmail, normalizeEmail } from '../lib/email'
import { LIMITS } from '../lib/limits'
import { assertNewPassword, assertPasswordLength } from '../lib/password-policy'
import { Permission, canUser } from '../rbac'
import { writeAudit } from './audit.service'
import { buildOpenVault, decryptRecordBody, loadUser, openRecordDatabase, recordMigration, spendPasswordWork, verifyOwnPassword } from './auth.service'
import { deviceClockFloor, observeClock, resetDeviceClock } from '../lib/device-clock'
import {
  CLOCK_KEY,
  CLOCK_TOLERANCE_MS,
  clockFloor,
  committedWraps,
  dropEnvelopeGrant,
  endGrant,
  grantAuditAction,
  grantRow,
  openGrantRows,
  type GrantRow,
} from './grant-store'
import { dropTotp } from './totp.service'
import { userStatus } from './user-profile'
import { checkUserGroup, roleIdByName } from './user-rules'

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
  const floor = clockFloor(db)
  if (floor !== null && now.getTime() < floor - CLOCK_TOLERANCE_MS) throw new ValidationError('CLOCK_BEHIND')
}

function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return diff === 0
}

async function mintGrant(dek: CryptoKey, kind: GrantRow['kind'], email: string, expiresAt: string): Promise<{ code: string; wrap: GrantWrap; verifier: string }> {
  const id = crypto.randomUUID()
  const access = generateAccessCode()
  const salt = randomBytes(SALT_BYTES)
  const kdf = { ...CURRENT_KDF }
  const { kek, verifier } = await deriveGrantKeys(access.canonical, salt, kdf)
  const wrapped = await wrapDekForGrant(dek, kek, grantAad(id, kind, email, expiresAt))
  return { code: access.display, verifier, wrap: { id, kind, email, kdf, salt, iv: wrapped.iv, wrappedDek: wrapped.cipherText, expiresAt } }
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
  // Each accepted invite or stopped-password reset adds a wrap, and the envelope decoder refuses more than LIMITS.wraps.
  if (committedWraps(vault) >= LIMITS.wraps) throw new ValidationError('MEMBER_LIMIT')
  const groupId = checkUserGroup(vault, input.groupId, input.roleName)
  const roleId = roleIdByName(vault, input.roleName)
  assertClock(vault.db, now)
  const createdAt = now.toISOString()
  const expiresAt = expiryFor(now, input.validity)
  const { code, wrap, verifier } = await mintGrant(vault.dek, 'INVITE', email, expiresAt)
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

export type PreparedReset = {
  userId: string
  email: string
  open: GrantRow[]
  createdAt: string
  expiresAt: string
  stop: boolean
  code: string
  wrap: GrantWrap
  verifier: string
}

/** Checks and mints a reset code. A suspended person gets one only through reactivation, a former member never. */
export async function prepareReset(
  vault: OpenVault,
  userId: string,
  input: { validity: GrantValidity; stopOldPassword: boolean },
  now: Date,
  reactivating = false,
): Promise<PreparedReset> {
  assertManager(vault)
  if (userId === vault.user.id) throw new ValidationError('USE_ACCOUNT')
  if (!isGrantValidity(input.validity)) throw new ValidationError('REQUIRED')
  const email = vault.db.queryValue('SELECT email FROM users WHERE id = ?', [userId])
  if (email == null) throw new ValidationError('REQUIRED')
  const status = userStatus(vault.db, userId)
  if (status === 'FORMER') throw new ValidationError('USER_FORMER')
  if (status === 'SUSPENDED' && !reactivating) throw new ValidationError('USER_SUSPENDED')
  const target = String(email)
  const open = openGrantRows(vault.db).filter((grant) => grant.email === target)
  if (vault.grants.length - open.length >= LIMITS.grants) throw new ValidationError('INVITE_LIMIT')
  // Someone with no password copy and no open reset takes a new slot once the code is used.
  const holdsSlot = vault.wraps.some((item) => item.userId === userId) || open.some((grant) => grant.kind === 'RESET' && grant.userId === userId)
  if (!holdsSlot && committedWraps(vault) >= LIMITS.wraps) throw new ValidationError('MEMBER_LIMIT')
  assertClock(vault.db, now)
  const createdAt = now.toISOString()
  const expiresAt = expiryFor(now, input.validity)
  const { code, wrap, verifier } = await mintGrant(vault.dek, 'RESET', target, expiresAt)
  return { userId, email: target, open, createdAt, expiresAt, stop: input.stopOldPassword, code, wrap, verifier }
}

/** Runs inside the caller's transaction. */
export function commitReset(vault: OpenVault, reset: PreparedReset): void {
  for (const grant of reset.open) {
    endGrant(vault.db, grant.id, 'REPLACED', vault.user.id, reset.createdAt)
    writeAudit(vault.db, vault.user.id, grantAuditAction(grant.kind, 'REVOKED'), 'grant', grant.id, { email: reset.email, reason: 'REPLACED' })
  }
  vault.db.exec(
    `INSERT INTO access_grants (id, kind, email, user_id, role_id, group_id, code_verifier, stop_old_password, created_by, created_at, expires_at)
     VALUES (?, 'RESET', ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
    [reset.wrap.id, reset.email, reset.userId, reset.verifier, reset.stop ? 1 : 0, vault.user.id, reset.createdAt, reset.expiresAt],
  )
  writeAudit(vault.db, vault.user.id, 'RESET_ISSUED', 'grant', reset.wrap.id, {
    email: reset.email,
    userId: reset.userId,
    expiresAt: reset.expiresAt,
    stopOldPassword: reset.stop,
  })
}

/** Updates the envelope once the transaction has committed. */
export function finishReset(vault: OpenVault, reset: PreparedReset): IssuedGrant {
  for (const grant of reset.open) dropEnvelopeGrant(vault, grant.id)
  vault.grants.push(reset.wrap)
  if (reset.stop) vault.wraps = vault.wraps.filter((item) => item.userId !== reset.userId)
  return { id: reset.wrap.id, kind: 'RESET', email: reset.email, code: reset.code, expiresAt: reset.expiresAt }
}

export async function issueReset(
  vault: OpenVault,
  userId: string,
  input: { validity: GrantValidity; stopOldPassword: boolean },
  now = new Date(),
): Promise<IssuedGrant> {
  const reset = await prepareReset(vault, userId, input, now)
  vault.db.withTransaction(() => commitReset(vault, reset))
  return finishReset(vault, reset)
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

export type ClockFloor = { vault: string | null; device: string | null }

export function readClockFloor(vault: OpenVault): ClockFloor {
  assertManager(vault)
  const device = deviceClockFloor()
  return { vault: getSetting(vault.db, CLOCK_KEY), device: device === null ? null : new Date(device).toISOString() }
}

/** Lowers both clock marks to now after a wrong far-future clock. Needs the Admin's password and is audited. */
export async function resetClockFloor(vault: OpenVault, password: string, now = new Date()): Promise<void> {
  assertManager(vault)
  await verifyOwnPassword(vault, password)
  const before = readClockFloor(vault)
  const to = now.toISOString()
  vault.db.withTransaction(() => {
    setSetting(vault.db, CLOCK_KEY, to)
    writeAudit(vault.db, vault.user.id, 'CLOCK_FLOOR_RESET', 'vault', 'primary', { vaultFrom: before.vault, deviceFrom: before.device, to })
  })
  resetDeviceClock(now.getTime())
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
  if (!grant || grant.kdf.name !== 'PBKDF2') {
    await spendPasswordWork(canonical)
    throw invalid()
  }
  const grantKdf = grant.kdf
  // Every attempt is a clock reading: a later attempt with the clock turned back is then refused.
  const deviceFloor = deviceClockFloor()
  observeClock(now.getTime())
  if (deviceFloor !== null && now.getTime() < deviceFloor - CLOCK_TOLERANCE_MS) throw new ValidationError('CLOCK_BEHIND')
  if (grant.expiresAt !== undefined && grant.expiresAt <= new Date(Math.max(now.getTime(), deviceFloor ?? 0)).toISOString()) {
    throw new ValidationError('INVITE_EXPIRED')
  }
  let dek: CryptoKey
  let verifier: string
  let plain: Uint8Array
  try {
    const keys = await deriveGrantKeys(canonical, cloneBytes(grant.salt), grantKdf)
    verifier = keys.verifier
    dek = await unwrapGrantDek(grant.wrappedDek, keys.kek, cloneBytes(grant.iv), grantAad(grant.id, grant.kind, grant.email, grant.expiresAt))
    plain = await decryptRecordBody(record, dek)
  } catch {
    throw invalid()
  }
  let opened: Awaited<ReturnType<typeof openRecordDatabase>>
  try {
    opened = await openRecordDatabase(plain)
  } finally {
    plain.fill(0)
  }
  const { db, migration } = opened
  try {
    const row = grantRow(db, grant.id)
    if (!row || row.endedAt || row.kind !== grant.kind || row.email !== email || !sameHex(row.codeVerifier, verifier)) throw invalid()
    if (grant.expiresAt !== undefined && grant.expiresAt !== row.expiresAt) throw invalid()
    assertClock(db, now)
    const at = now.toISOString()
    if (row.expiresAt <= new Date(Math.max(now.getTime(), clockFloor(db) ?? 0)).toISOString()) throw new ValidationError('INVITE_EXPIRED')
    await assertNewPassword(input.password, { email, vaultName: getSetting(db, 'vault_name') ?? undefined })

    const salt = randomBytes(SALT_BYTES)
    const kdf = { ...CURRENT_KDF }
    const derived = await deriveKeyAndVerifier(input.password, salt, kdf)
    const wraps = wrapsFromRecord(record)
    const addsWrap = row.kind === 'INVITE' || !wraps.some((item) => item.userId === row.userId)
    if (addsWrap && wraps.length >= LIMITS.wraps) throw new ValidationError('MEMBER_LIMIT')
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
      if (userStatus(db, String(target.id)) !== 'ACTIVE') throw invalid()
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
    const wrap = await newUserWrap(dek, derived.key, { userId, email, kdf, salt })
    const index = wraps.findIndex((item) => item.userId === userId)
    if (index >= 0) wraps[index] = wrap
    else wraps.push(wrap)
    return buildOpenVault(record, { db, dek, wraps, user, needsSave: true }, now)
  } catch (error) {
    db.close()
    throw error
  }
}
