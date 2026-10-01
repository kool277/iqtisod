import { bytesToBase64 } from '../crypto/encoding'
import { CURRENT_KDF, SALT_BYTES, WRAP_AAD_V1, deriveKeyAndVerifier, kdfNeedsUpgrade, randomBytes } from '../crypto/crypto.service'
import { newUserWrap } from '../crypto/user-wrap'
import type { SqlValue } from '../db/sqlite'
import { ForbiddenError, ValidationError, isUniqueViolation } from '../domain/errors'
import { isRoleName, type AuditEntry, type OpenVault, type RoleName, type VaultUser } from '../domain/types'
import { LIMITS } from '../lib/limits'
import { assertNewPassword } from '../lib/password-policy'
import { Permission, canUser, seesAllGroups, seesMembers } from '../rbac'
import { assertEmail, normalizeEmail } from './auth.service'
import { mapAuditRow } from './audit-log'
import { writeAudit } from './audit.service'
import { scope } from './finance.service'
import { commitReset, finishReset, prepareReset, type GrantValidity, type IssuedGrant } from './grant.service'
import { committedWraps, dropEnvelopeGrant, endGrant, grantAuditAction, openGrantRows, type GrantRow } from './grant-store'
import { dropTotp } from './totp.service'
import { dropProfile, readProfile, readProfiles, writeProfile, type UserProfile, type UserStatus } from './user-profile'
import { checkUserGroup, roleIdByName } from './user-rules'

export { checkUserGroup, roleIdByName }
export type { UserStatus }

export type NewUserInput = {
  email: string
  password: string
  roleName: RoleName
  groupId: number | null
  displayName?: string
}

export type UserEdit = {
  roleName: RoleName
  groupId: number | null
  /** Left unchanged when undefined. */
  displayName?: string
  email?: string
}

export type BulkChange = { roleName?: RoleName; groupId?: number | null }

/** What happens to the records of someone being deleted. Without records the person is simply removed. */
export type DeleteOptions = {
  records?: 'REASSIGN' | 'KEEP'
  reassignTo?: string
  /** When given it must be the person's email: the screen asks for it to be typed. */
  confirmEmail?: string
}

export const BULK_LIMIT = LIMITS.wraps

function assertManager(vault: OpenVault): void {
  if (!canUser(vault.user, Permission.MANAGE_USERS)) throw new ForbiddenError()
}

type UserRow = { id: string; email: string; roleName: string; groupId: number | null; mustChange: boolean }

function userRow(vault: OpenVault, userId: string): UserRow {
  const row = vault.db.queryOne(
    `SELECT u.id, u.email, r.name AS role_name, u.group_id, u.must_change_password FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
    [userId],
  )
  if (!row) throw new ValidationError('REQUIRED')
  return {
    id: String(row.id),
    email: String(row.email),
    roleName: String(row.role_name),
    groupId: row.group_id == null ? null : Number(row.group_id),
    mustChange: Number(row.must_change_password) === 1,
  }
}

/** Admins who can still sign in: a suspended or former Admin does not keep the vault manageable. */
function activeAdminIds(vault: OpenVault): Set<string> {
  const profiles = readProfiles(vault.db)
  const ids = vault.db
    .query(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'Admin'`)
    .map((row) => String(row.id))
    .filter((id) => (profiles.get(id)?.status ?? 'ACTIVE') === 'ACTIVE')
  return new Set(ids)
}

function assertNotLastAdmin(vault: OpenVault, leaving: readonly string[]): void {
  const active = activeAdminIds(vault)
  if (!leaving.some((id) => active.has(id))) return
  if ([...active].every((id) => leaving.includes(id))) throw new ValidationError('LAST_ADMIN')
}

function assertEditable(vault: OpenVault, userId: string): UserProfile {
  const profile = readProfile(vault.db, userId)
  if (profile.status === 'FORMER') throw new ValidationError('USER_FORMER')
  return profile
}

function cleanName(value: string): string | null {
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (name.length > LIMITS.nameChars) throw new ValidationError('TOO_LONG')
  return name || null
}

function refreshSession(vault: OpenVault, roleName: RoleName, groupId: number | null): void {
  vault.user.roleName = roleName
  vault.user.roleId = roleIdByName(vault, roleName)
  vault.user.groupId = groupId
  const permissions = vault.db.queryValue('SELECT permissions FROM roles WHERE name = ?', [roleName])
  try {
    const parsed = JSON.parse(String(permissions)) as unknown
    vault.user.permissions = Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    vault.user.permissions = []
  }
}

function access(vault: OpenVault, userId: string, open: readonly GrantRow[]): VaultUser['access'] {
  if (vault.wraps.some((wrap) => wrap.userId === userId)) return 'PASSWORD'
  return open.some((grant) => grant.kind === 'RESET' && grant.userId === userId) ? 'CODE' : 'NONE'
}

function legacyWrap(vault: OpenVault, userId: string): boolean {
  const wrap = vault.wraps.find((item) => item.userId === userId)
  return wrap !== undefined && (wrap.aad !== WRAP_AAD_V1 || kdfNeedsUpgrade(wrap.kdf))
}

function recordCounts(vault: OpenVault): Map<string, number> {
  if (!canUser(vault.user, Permission.READ_TRANSACTIONS) && !canUser(vault.user, Permission.READ_DASHBOARD)) return new Map()
  const group = scope(vault.user)
  const rows = vault.db.query(`SELECT t.user_id, COUNT(*) AS count FROM transactions t WHERE ${group.sql} GROUP BY t.user_id`, group.params)
  return new Map(rows.map((row) => [String(row.user_id), Number(row.count)]))
}

export function listUsers(vault: OpenVault): VaultUser[] {
  if (!canUser(vault.user, Permission.MANAGE_USERS) && !canUser(vault.user, Permission.READ_TRANSACTIONS)) {
    throw new ForbiddenError()
  }
  const all = seesAllGroups(vault.user)
  if (!all && vault.user.groupId == null) return []
  const manager = canUser(vault.user, Permission.MANAGE_USERS)
  // Only people managers learn who has a sign-in check, who must change a password, and when people last signed in.
  const check = manager ? 'EXISTS (SELECT 1 FROM user_totp t WHERE t.user_id = u.id)' : '0'
  const rows = vault.db.query(
    `SELECT u.id, u.email, r.name AS role_name, u.group_id, g.name AS group_name, u.created_at, u.must_change_password, ${check} AS sign_in_check
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN groups g ON g.id = u.group_id
     ${all ? '' : 'WHERE u.group_id = ?'}
     ORDER BY u.email`,
    all ? [] : [vault.user.groupId],
  )
  const profiles = readProfiles(vault.db)
  const counts = recordCounts(vault)
  const open = manager ? openGrantRows(vault.db) : []
  return rows.map((row) => toVaultUser(vault, row, profiles.get(String(row.id)), counts, open, manager))
}

function toVaultUser(
  vault: OpenVault,
  row: Record<string, SqlValue>,
  profile: UserProfile | undefined,
  counts: Map<string, number>,
  open: readonly GrantRow[],
  manager: boolean,
): VaultUser {
  const id = String(row.id)
  return {
    id,
    email: String(row.email),
    displayName: profile?.displayName ?? null,
    roleName: String(row.role_name),
    groupId: row.group_id == null ? null : Number(row.group_id),
    groupName: row.group_name == null ? null : String(row.group_name),
    createdAt: String(row.created_at),
    updatedAt: profile?.updatedAt ?? null,
    status: profile?.status ?? 'ACTIVE',
    records: counts.get(id) ?? 0,
    signInCheck: Number(row.sign_in_check) === 1,
    lastSignInAt: manager ? (profile?.lastSignInAt ?? null) : null,
    mustChange: manager && Number(row.must_change_password) === 1,
    access: manager ? access(vault, id, open) : 'UNKNOWN',
    legacyWrap: manager && legacyWrap(vault, id),
  }
}

export type CurrencyTotals = { currency: string; incomeMinor: bigint; expenseMinor: bigint; count: number }

export type UserDetail = {
  user: VaultUser
  /** Records this person entered within what the caller may see, per currency; amounts are never added across currencies. */
  records: { count: number; lastDate: string | null; currencies: CurrencyTotals[] }
  /** Audit entries this person made, newest first; null for anyone who may not read the audit log. */
  activity: AuditEntry[] | null
  /** The open invite or reset code for this person, for people managers only. */
  openCode: { kind: GrantRow['kind']; expiresAt: string; expired: boolean } | null
}

export const ACTIVITY_LIMIT = 50

/** A person's page. Managers see members of their own group read-only; anyone else in another group is not found. */
export function getUserDetail(vault: OpenVault, userId: string, now = new Date()): UserDetail {
  if (!seesMembers(vault.user)) throw new ForbiddenError()
  const user = listUsers(vault).find((person) => person.id === userId)
  if (!user) throw new ValidationError('REQUIRED')
  const group = scope(vault.user)
  const rows = vault.db.query(
    `SELECT t.currency, t.type, CAST(SUM(t.amount_minor) AS TEXT) AS total, COUNT(*) AS count, MAX(t.transaction_date) AS last_date
     FROM transactions t WHERE t.user_id = ? AND ${group.sql} GROUP BY t.currency, t.type`,
    [userId, ...group.params],
  )
  const byCurrency = new Map<string, CurrencyTotals>()
  let lastDate: string | null = null
  for (const row of rows) {
    const currency = String(row.currency)
    const current = byCurrency.get(currency) ?? { currency, incomeMinor: 0n, expenseMinor: 0n, count: 0 }
    const total = BigInt(String(row.total))
    if (row.type === 'INCOME') current.incomeMinor += total
    else current.expenseMinor += total
    current.count += Number(row.count)
    byCurrency.set(currency, current)
    const last = String(row.last_date)
    if (lastDate === null || last > lastDate) lastDate = last
  }
  const currencies = [...byCurrency.values()].sort((a, b) => (a.currency === vault.currency ? -1 : b.currency === vault.currency ? 1 : a.currency.localeCompare(b.currency)))
  const activity = canUser(vault.user, Permission.READ_AUDIT)
    ? vault.db
        .query(
          `SELECT a.id, a.actor_id, u.email AS actor_email, a.action, a.entity_type, a.entity_id, a.details, a.created_at
           FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
           WHERE a.actor_id = ? ORDER BY a.seq DESC LIMIT ?`,
          [userId, ACTIVITY_LIMIT],
        )
        .map(mapAuditRow)
    : null
  let openCode: UserDetail['openCode'] = null
  if (canUser(vault.user, Permission.MANAGE_USERS)) {
    const grant = openGrantRows(vault.db).find((item) => item.userId === userId || item.email === user.email)
    if (grant) openCode = { kind: grant.kind, expiresAt: grant.expiresAt, expired: grant.expiresAt <= now.toISOString() }
  }
  return { user, records: { count: currencies.reduce((sum, item) => sum + item.count, 0), lastDate, currencies }, activity, openCode }
}

export type UsersOverview = {
  /** Everyone except former members. */
  members: number
  former: number
  suspended: number
  limit: number
  /** Password copies in the envelope now. */
  slotsUsed: number
  /** Slots held for open invites and for resets that stopped the old password. */
  slotsReserved: number
  byRole: { role: RoleName; count: number }[]
  byGroup: { groupId: number | null; name: string | null; count: number }[]
  /** Active members with a sign-in check, out of `active`. */
  totpOn: number
  active: number
  mustChange: number
  /** Managers and Viewers without a group, who see nothing. */
  noGroup: number
  /** Active members who can neither sign in nor use a code. */
  noAccess: number
  legacyWraps: number
  openCodes: { id: string; kind: GrantRow['kind']; email: string; expiresAt: string; expired: boolean }[]
  recent: { id: string; email: string; displayName: string | null; lastSignInAt: string }[]
  /** Active members who signed in within the last 30 days. */
  activeLast30: number
}

const ROLES: RoleName[] = ['Admin', 'Manager', 'Viewer']
const DAY = 24 * 60 * 60_000

export function usersOverview(vault: OpenVault, now = new Date()): UsersOverview {
  assertManager(vault)
  const people = listUsers(vault)
  const current = people.filter((person) => person.status !== 'FORMER')
  const active = current.filter((person) => person.status === 'ACTIVE')
  const groups = new Map<number | null, { groupId: number | null; name: string | null; count: number }>()
  for (const person of current) {
    const entry = groups.get(person.groupId) ?? { groupId: person.groupId, name: person.groupName, count: 0 }
    entry.count += 1
    groups.set(person.groupId, entry)
  }
  const at = now.toISOString()
  const since = new Date(now.getTime() - 30 * DAY).toISOString()
  const signedIn = active.filter((person): person is VaultUser & { lastSignInAt: string } => person.lastSignInAt !== null)
  return {
    members: current.length,
    former: people.length - current.length,
    suspended: current.length - active.length,
    limit: LIMITS.wraps,
    slotsUsed: vault.wraps.length,
    slotsReserved: committedWraps(vault) - vault.wraps.length,
    byRole: ROLES.map((role) => ({ role, count: current.filter((person) => person.roleName === role).length })),
    byGroup: [...groups.values()].sort((a, b) => b.count - a.count || (a.name ?? '').localeCompare(b.name ?? '')),
    totpOn: active.filter((person) => person.signInCheck).length,
    active: active.length,
    mustChange: active.filter((person) => person.mustChange).length,
    noGroup: current.filter((person) => person.roleName !== 'Admin' && person.groupId === null).length,
    noAccess: active.filter((person) => person.access === 'NONE').length,
    legacyWraps: current.filter((person) => person.legacyWrap).length,
    openCodes: openGrantRows(vault.db)
      .map((grant) => ({ id: grant.id, kind: grant.kind, email: grant.email, expiresAt: grant.expiresAt, expired: grant.expiresAt <= at }))
      .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt)),
    recent: signedIn
      .sort((a, b) => b.lastSignInAt.localeCompare(a.lastSignInAt))
      .slice(0, 5)
      .map((person) => ({ id: person.id, email: person.email, displayName: person.displayName, lastSignInAt: person.lastSignInAt })),
    activeLast30: signedIn.filter((person) => person.lastSignInAt >= since).length,
  }
}

export async function createUser(vault: OpenVault, input: NewUserInput): Promise<string> {
  assertManager(vault)
  if (!isRoleName(input.roleName)) throw new ValidationError('ROLE')
  const email = normalizeEmail(input.email)
  assertEmail(email)
  const displayName = input.displayName === undefined ? null : cleanName(input.displayName)
  await assertNewPassword(input.password, { email, vaultName: vault.vaultName })
  if (committedWraps(vault) >= LIMITS.wraps) throw new ValidationError('MEMBER_LIMIT')
  const groupId = checkUserGroup(vault, input.groupId, input.roleName)
  const salt = randomBytes(SALT_BYTES)
  const { key, verifier } = await deriveKeyAndVerifier(input.password, salt, CURRENT_KDF)
  const userId = crypto.randomUUID()
  const wrap = await newUserWrap(vault.dek, key, { userId, email, kdf: { ...CURRENT_KDF }, salt })
  const replaced = openGrantRows(vault.db).filter((grant) => grant.kind === 'INVITE' && grant.email === email)
  try {
    vault.db.withTransaction(() => {
      const at = new Date().toISOString()
      for (const grant of replaced) {
        endGrant(vault.db, grant.id, 'REPLACED', vault.user.id, at)
        writeAudit(vault.db, vault.user.id, 'INVITE_REVOKED', 'grant', grant.id, { email, reason: 'REPLACED' })
      }
      vault.db.exec(
        `INSERT INTO users (id, email, password_hash, salt, role_id, group_id, must_change_password, password_changed_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
        [userId, email, verifier, bytesToBase64(salt), roleIdByName(vault, input.roleName), groupId, at],
      )
      if (displayName) writeProfile(vault.db, userId, { displayName })
      writeAudit(vault.db, vault.user.id, 'USER_CREATED', 'user', userId, {
        email,
        role: input.roleName,
        groupId,
      })
    })
  } catch (error) {
    if (isUniqueViolation(error)) throw new ValidationError('DUPLICATE_EMAIL')
    throw error
  }
  for (const grant of replaced) dropEnvelopeGrant(vault, grant.id)
  const index = vault.wraps.findIndex((item) => item.userId === userId)
  if (index >= 0) vault.wraps[index] = wrap
  else vault.wraps.push(wrap)
  return userId
}

export async function resetUserPassword(vault: OpenVault, userId: string, password: string): Promise<void> {
  assertManager(vault)
  if (userId === vault.user.id) throw new ValidationError('USE_ACCOUNT')
  const existing = vault.db.queryOne('SELECT id, email FROM users WHERE id = ?', [userId])
  if (!existing) throw new ValidationError('REQUIRED')
  const status = assertEditable(vault, userId).status
  if (status === 'SUSPENDED') throw new ValidationError('USER_SUSPENDED')
  const email = String(existing.email)
  await assertNewPassword(password, { email, vaultName: vault.vaultName })
  const resets = openGrantRows(vault.db).filter((grant) => grant.kind === 'RESET' && grant.userId === userId)
  if (!vault.wraps.some((item) => item.userId === userId) && vault.wraps.length >= LIMITS.wraps) throw new ValidationError('MEMBER_LIMIT')
  const salt = randomBytes(SALT_BYTES)
  const { key, verifier } = await deriveKeyAndVerifier(password, salt, CURRENT_KDF)
  const wrap = await newUserWrap(vault.dek, key, { userId, email, kdf: { ...CURRENT_KDF }, salt })
  vault.db.withTransaction(() => {
    const at = new Date().toISOString()
    vault.db.exec('UPDATE users SET password_hash = ?, salt = ?, must_change_password = 1, password_changed_at = ? WHERE id = ?', [
      verifier,
      bytesToBase64(salt),
      at,
      userId,
    ])
    writeProfile(vault.db, userId, { updatedAt: at })
    writeAudit(vault.db, vault.user.id, 'USER_PASSWORD_RESET', 'user', userId, { email })
    dropTotp(vault.db, vault.user.id, userId, 'PASSWORD_RESET')
    for (const grant of resets) {
      endGrant(vault.db, grant.id, 'REPLACED', vault.user.id, at)
      writeAudit(vault.db, vault.user.id, 'RESET_REVOKED', 'grant', grant.id, { email, reason: 'REPLACED' })
    }
  })
  for (const grant of resets) dropEnvelopeGrant(vault, grant.id)
  const index = vault.wraps.findIndex((item) => item.userId === userId)
  if (index >= 0) vault.wraps[index] = wrap
  else vault.wraps.push(wrap)
}

/**
 * Changes role and group, and optionally the display name and email. A new email relabels the person's password copy;
 * the copy's encryption binds the person's id, not the email, so it keeps working.
 */
export function updateUser(vault: OpenVault, userId: string, input: UserEdit): void {
  assertManager(vault)
  if (!isRoleName(input.roleName)) throw new ValidationError('ROLE')
  const existing = userRow(vault, userId)
  const profile = assertEditable(vault, userId)
  if (existing.roleName === 'Admin' && input.roleName !== 'Admin') assertNotLastAdmin(vault, [userId])
  const groupId = checkUserGroup(vault, input.groupId, input.roleName)
  const displayName = input.displayName === undefined ? profile.displayName : cleanName(input.displayName)
  let email = existing.email
  if (input.email !== undefined && normalizeEmail(input.email) !== existing.email) {
    email = normalizeEmail(input.email)
    assertEmail(email)
    if (vault.db.queryValue('SELECT 1 FROM users WHERE email = ? AND id <> ?', [email, userId]) != null) throw new ValidationError('DUPLICATE_EMAIL')
    const open = openGrantRows(vault.db)
    if (open.some((grant) => grant.email === email)) throw new ValidationError('GRANT_OPEN')
    // An open code is bound to the old email in its encryption, so it has to be revoked or used first.
    if (open.some((grant) => grant.userId === userId || grant.email === existing.email)) throw new ValidationError('USER_CODE_OPEN')
  }
  const at = new Date().toISOString()
  try {
    vault.db.withTransaction(() => {
      vault.db.exec('UPDATE users SET role_id = ?, group_id = ?, email = ? WHERE id = ?', [roleIdByName(vault, input.roleName), groupId, email, userId])
      writeProfile(vault.db, userId, { displayName, updatedAt: at })
      writeAudit(vault.db, vault.user.id, 'USER_UPDATED', 'user', userId, {
        role: input.roleName,
        groupId,
        ...(email !== existing.email ? { email, previousEmail: existing.email } : {}),
        ...(displayName !== profile.displayName ? { displayName } : {}),
      })
    })
  } catch (error) {
    if (isUniqueViolation(error)) throw new ValidationError('DUPLICATE_EMAIL')
    throw error
  }
  if (email !== existing.email) {
    const index = vault.wraps.findIndex((wrap) => wrap.userId === userId)
    if (index >= 0) vault.wraps[index] = { ...vault.wraps[index], email }
    if (vault.user.id === userId) vault.user.email = email
  }
  if (vault.user.id === userId) refreshSession(vault, input.roleName, groupId)
}

/** Changes role, group, or both for several people at once: all or nothing, with one audit entry per person. */
export function bulkUpdateUsers(vault: OpenVault, userIds: readonly string[], change: BulkChange): number {
  assertManager(vault)
  if (change.roleName === undefined && change.groupId === undefined) throw new ValidationError('REQUIRED')
  if (change.roleName !== undefined && !isRoleName(change.roleName)) throw new ValidationError('ROLE')
  const ids = [...new Set(userIds)]
  if (ids.length === 0) throw new ValidationError('REQUIRED')
  if (ids.length > BULK_LIMIT) throw new ValidationError('TOO_LONG')
  const plans = ids.map((id) => {
    const row = userRow(vault, id)
    assertEditable(vault, id)
    const role = change.roleName ?? (isRoleName(row.roleName) ? row.roleName : 'Viewer')
    const wanted = change.groupId !== undefined ? change.groupId : row.groupId
    const groupId = checkUserGroup(vault, wanted, role)
    return { row, role, groupId, changed: role !== row.roleName || groupId !== row.groupId }
  })
  assertNotLastAdmin(
    vault,
    plans.filter((plan) => plan.row.roleName === 'Admin' && plan.role !== 'Admin').map((plan) => plan.row.id),
  )
  const changed = plans.filter((plan) => plan.changed)
  const at = new Date().toISOString()
  vault.db.withTransaction(() => {
    for (const plan of changed) {
      vault.db.exec('UPDATE users SET role_id = ?, group_id = ? WHERE id = ?', [roleIdByName(vault, plan.role), plan.groupId, plan.row.id])
      writeProfile(vault.db, plan.row.id, { updatedAt: at })
      writeAudit(vault.db, vault.user.id, 'USER_UPDATED', 'user', plan.row.id, { role: plan.role, groupId: plan.groupId, bulk: true })
    }
  })
  const self = changed.find((plan) => plan.row.id === vault.user.id)
  if (self) refreshSession(vault, self.role, self.groupId)
  return changed.length
}

/** Makes the person choose a new password at their next sign-in; until then every service refuses them. */
export function requirePasswordChange(vault: OpenVault, userId: string): void {
  assertManager(vault)
  if (userId === vault.user.id) throw new ValidationError('USE_ACCOUNT')
  const row = userRow(vault, userId)
  assertEditable(vault, userId)
  if (row.mustChange) return
  vault.db.withTransaction(() => {
    vault.db.exec('UPDATE users SET must_change_password = 1 WHERE id = ?', [userId])
    writeProfile(vault.db, userId, { updatedAt: new Date().toISOString() })
    writeAudit(vault.db, vault.user.id, 'USER_MUST_CHANGE_PASSWORD', 'user', userId, { email: row.email })
  })
}

function revokeCodesFor(vault: OpenVault, row: UserRow, reason: string, at: string): GrantRow[] {
  const grants = openGrantRows(vault.db).filter((grant) => grant.userId === row.id || grant.email === row.email)
  for (const grant of grants) {
    endGrant(vault.db, grant.id, 'REVOKED', vault.user.id, at)
    writeAudit(vault.db, vault.user.id, grantAuditAction(grant.kind, 'REVOKED'), 'grant', grant.id, { email: row.email, reason })
  }
  return grants
}

/**
 * Stops someone signing in without touching their data: their password copy leaves the envelope (like a reset that
 * stops the old password) and their open codes are revoked. The vault key does not change, so a copy of the vault
 * file saved before the suspension still opens with their old password.
 */
export function suspendUser(vault: OpenVault, userId: string, now = new Date()): void {
  assertManager(vault)
  if (userId === vault.user.id) throw new ValidationError('SELF')
  const row = userRow(vault, userId)
  const status = assertEditable(vault, userId).status
  if (status === 'SUSPENDED') throw new ValidationError('USER_SUSPENDED')
  if (row.roleName === 'Admin') assertNotLastAdmin(vault, [userId])
  const hadPassword = vault.wraps.some((wrap) => wrap.userId === userId)
  const at = now.toISOString()
  let revoked: GrantRow[] = []
  vault.db.withTransaction(() => {
    revoked = revokeCodesFor(vault, row, 'SUSPENDED', at)
    writeProfile(vault.db, userId, { status: 'SUSPENDED', statusAt: at, updatedAt: at })
    writeAudit(vault.db, vault.user.id, 'USER_SUSPENDED', 'user', userId, { email: row.email, hadPassword, codesRevoked: revoked.length })
  })
  for (const grant of revoked) dropEnvelopeGrant(vault, grant.id)
  vault.wraps = vault.wraps.filter((wrap) => wrap.userId !== userId)
}

/** Lifts a suspension by issuing a reset code; the person sets a new password with it. */
export async function reactivateUser(vault: OpenVault, userId: string, input: { validity: GrantValidity }, now = new Date()): Promise<IssuedGrant> {
  assertManager(vault)
  const row = userRow(vault, userId)
  if (readProfile(vault.db, userId).status !== 'SUSPENDED') throw new ValidationError('NOT_SUSPENDED')
  const reset = await prepareReset(vault, userId, { validity: input.validity, stopOldPassword: true }, now, true)
  vault.db.withTransaction(() => {
    if (readProfile(vault.db, userId).status !== 'SUSPENDED') throw new ValidationError('NOT_SUSPENDED')
    writeProfile(vault.db, userId, { status: 'ACTIVE', statusAt: reset.createdAt, updatedAt: reset.createdAt })
    writeAudit(vault.db, vault.user.id, 'USER_REACTIVATED', 'user', userId, { email: row.email, expiresAt: reset.expiresAt })
    commitReset(vault, reset)
  })
  return finishReset(vault, reset)
}

/**
 * Removes someone. Their records are either moved to another person or kept under them as a former member, whose
 * row stays (without a password copy, codes, sign-in check or private safes) so records and audit entries still name
 * them. Without records the person is removed entirely; their audit entries keep naming them through `USER_DELETED`.
 */
export function deleteUser(vault: OpenVault, userId: string, options: DeleteOptions = {}): void {
  assertManager(vault)
  if (vault.user.id === userId) throw new ValidationError('SELF')
  const row = userRow(vault, userId)
  if (options.confirmEmail !== undefined && normalizeEmail(options.confirmEmail) !== row.email) throw new ValidationError('CONFIRM_EMAIL')
  const status = readProfile(vault.db, userId).status
  if (row.roleName === 'Admin') assertNotLastAdmin(vault, [userId])
  const records = Number(vault.db.queryValue('SELECT COUNT(*) FROM transactions WHERE user_id = ?', [userId]) ?? 0)
  const mode = records === 0 ? 'NONE' : options.records
  if (mode === undefined) throw new ValidationError('HAS_RECORDS')
  if (mode === 'KEEP' && status === 'FORMER') throw new ValidationError('USER_FORMER')
  let target: UserRow | null = null
  if (mode === 'REASSIGN') {
    if (!options.reassignTo || options.reassignTo === userId) throw new ValidationError('REASSIGN_TARGET')
    target = vault.db.queryValue('SELECT 1 FROM users WHERE id = ?', [options.reassignTo]) == null ? null : userRow(vault, options.reassignTo)
    if (!target || readProfile(vault.db, target.id).status === 'FORMER') throw new ValidationError('REASSIGN_TARGET')
  }
  const grants = openGrantRows(vault.db).filter((grant) => grant.userId === userId || grant.email === row.email)
  const at = new Date().toISOString()
  vault.db.withTransaction(() => {
    if (mode === 'KEEP') {
      revokeCodesFor(vault, row, 'DELETED', at)
      dropTotp(vault.db, vault.user.id, userId, 'ADMIN')
      deletePrivateData(vault, userId)
      writeProfile(vault.db, userId, { status: 'FORMER', statusAt: at, updatedAt: at })
      writeAudit(vault.db, vault.user.id, 'USER_DELETED', 'user', userId, { email: row.email, records: 'KEPT', count: records })
      return
    }
    if (target) {
      vault.db.exec('UPDATE transactions SET user_id = ? WHERE user_id = ?', [target.id, userId])
      writeAudit(vault.db, vault.user.id, 'TRANSACTIONS_REASSIGNED', 'user', userId, { email: row.email, to: target.id, toEmail: target.email, count: records })
    }
    writeAudit(vault.db, vault.user.id, 'USER_DELETED', 'user', userId, {
      email: row.email,
      ...(target ? { records: 'REASSIGNED', count: records, to: target.id } : {}),
    })
    deletePrivateData(vault, userId)
    dropProfile(vault.db, userId)
    vault.db.exec('DELETE FROM users WHERE id = ?', [userId])
  })
  for (const grant of grants) dropEnvelopeGrant(vault, grant.id)
  vault.wraps = vault.wraps.filter((wrap) => wrap.userId !== userId)
}

function deletePrivateData(vault: OpenVault, userId: string): void {
  vault.db.exec('DELETE FROM safe_events WHERE owner_user_id = ?', [userId])
  vault.db.exec('DELETE FROM secure_items WHERE owner_user_id = ?', [userId])
  vault.db.exec('DELETE FROM safes WHERE owner_user_id = ?', [userId])
  vault.db.exec('DELETE FROM user_keys WHERE user_id = ?', [userId])
}
