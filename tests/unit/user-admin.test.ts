import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { assertKnownSchema, readSchemaVersion } from '../../src/db/migrations'
import type { VaultRecord } from '../../src/db/envelope'
import { AuthError, ForbiddenError } from '../../src/domain/errors'
import type { OpenVault, TransactionInput } from '../../src/domain/types'
import { LIMITS } from '../../src/lib/limits'
import { Permission, canUser, seesMembers } from '../../src/rbac'
import { listAudit } from '../../src/services/audit.service'
import { sealVault, unlockVault } from '../../src/services/auth.service'
import { createTransaction, listCategories } from '../../src/services/finance.service'
import { createInvite, issueReset, listGrants, redeemGrant, revokeGrant } from '../../src/services/grant.service'
import { createGroup, listGroups } from '../../src/services/group.service'
import { loadGroupSummaries } from '../../src/services/group-summary.service'
import { noteSignIn, parseProfile, readProfile, writeProfile, SIGN_IN_RESOLUTION_MS } from '../../src/services/user-profile'
import {
  bulkUpdateUsers,
  createUser,
  deleteUser,
  getUserDetail,
  listUsers,
  reactivateUser,
  requirePasswordChange,
  resetUserPassword,
  suspendUser,
  updateUser,
  usersOverview,
} from '../../src/services/user.service'
import {
  INVITEE,
  MANAGER,
  MEMBER,
  NEW_PASSWORD,
  OWNER,
  auditActions,
  auditRows,
  buildAccessHousehold,
  lastAudit,
  openAs,
  settlePassword,
  thrownCode,
  type Household,
} from '../support/access'
import { closeTracked, track } from '../support/safes'

const DEPUTY = { email: 'deputy@maple.test', password: 'Walnut cabinet rhythm 23' }
const RANGE = { start: '2000-01-01', end: '2100-12-31' }

let household: Household

beforeAll(async () => {
  household = await buildAccessHousehold()
  closeTracked()
})

afterEach(closeTracked)

async function code(fn: () => unknown): Promise<string> {
  try {
    await fn()
    return 'OK'
  } catch (error) {
    return (error as { code?: string }).code ?? String(error)
  }
}

function owner(record: VaultRecord = household.record): Promise<OpenVault> {
  return openAs(record, OWNER)
}

function padWraps(vault: OpenVault, total: number): void {
  const template = vault.wraps[0]
  for (let index = vault.wraps.length; index < total; index += 1) {
    vault.wraps.push({ ...template, userId: crypto.randomUUID(), email: `stand-in-${index}@limit.test` })
  }
}

/** The household's Manager with three records in the shared group: USD 100 in, USD 30 out, EUR 5 out. */
async function managerWithRecords(): Promise<VaultRecord> {
  const manager = settlePassword(await openAs(household.record, MANAGER))
  const categories = listCategories(manager)
  const income = categories.find((category) => category.type === 'INCOME')!.id
  const expense = categories.find((category) => category.type === 'EXPENSE')!.id
  const base: Omit<TransactionInput, 'type' | 'amount' | 'currency' | 'categoryId'> = { groupId: household.groupId, date: '2026-09-10', notes: '', receiptData: null }
  createTransaction(manager, { ...base, type: 'INCOME', amount: '100', currency: 'USD', categoryId: income })
  createTransaction(manager, { ...base, type: 'EXPENSE', amount: '30', currency: 'USD', categoryId: expense })
  createTransaction(manager, { ...base, type: 'EXPENSE', amount: '5', currency: 'EUR', categoryId: expense })
  return sealVault(manager)
}

function totals(vault: OpenVault) {
  return loadGroupSummaries(vault, RANGE).total
}

describe('listing and reading people', () => {
  it('shows profile, status, access and record counts to people managers', async () => {
    const admin = await owner(await managerWithRecords())
    const userId = await createUser(admin, { email: 'nodira@maple.test', password: 'Pebble lantern orchard 64', roleName: 'Viewer', groupId: household.groupId, displayName: '  Nodira  ' })
    const people = listUsers(admin)
    expect(people.find((person) => person.id === userId)).toMatchObject({ displayName: 'Nodira', status: 'ACTIVE', access: 'PASSWORD', mustChange: true, records: 0 })
    expect(people.find((person) => person.id === household.managerId)).toMatchObject({ records: 3, roleName: 'Manager' })
    const detail = getUserDetail(admin, household.managerId)
    expect(detail.records.count).toBe(3)
    expect(detail.records.currencies).toEqual([
      { currency: 'USD', incomeMinor: 10_000n, expenseMinor: 3_000n, count: 2 },
      { currency: 'EUR', incomeMinor: 0n, expenseMinor: 500n, count: 1 },
    ])
    expect(detail.activity?.map((entry) => entry.action)).toContain('TRANSACTION_CREATED')
    expect(detail.activity?.every((entry) => entry.actorId === household.managerId)).toBe(true)
  })

  it('lets a Manager read their own group read-only, without sign-in details or the audit log', async () => {
    const admin = await owner()
    const groupId = createOtherGroup(admin)
    await createUser(admin, { email: 'elsewhere@maple.test', password: 'Distant harbour beacon 12', roleName: 'Viewer', groupId })
    writeProfile(admin.db, household.memberId, { lastSignInAt: '2026-09-30T10:00:00.000Z' })
    const manager = settlePassword(await openAs(await sealVault(admin), MANAGER))
    expect(seesMembers(manager.user)).toBe(true)
    const people = listUsers(manager)
    expect(people.map((person) => person.email).sort()).toEqual([MEMBER.email, MANAGER.email])
    const member = people.find((person) => person.email === MEMBER.email)!
    expect(member).toMatchObject({ lastSignInAt: null, mustChange: false, signInCheck: false, access: 'UNKNOWN', legacyWrap: false })
    const detail = getUserDetail(manager, household.memberId)
    expect(detail.activity).toBeNull()
    expect(detail.openCode).toBeNull()
    const other = listUsers(admin).find((person) => person.email === 'elsewhere@maple.test')!
    expect(thrownCode(() => getUserDetail(manager, other.id))).toBe('REQUIRED')
    expect(() => usersOverview(manager)).toThrow(ForbiddenError)
  })

  it('refuses the people pages to Viewers', async () => {
    const viewer = settlePassword(await openAs(household.record, MEMBER))
    expect(seesMembers(viewer.user)).toBe(false)
    expect(() => getUserDetail(viewer, household.managerId)).toThrow(ForbiddenError)
    expect(() => usersOverview(viewer)).toThrow(ForbiddenError)
  })
})

function createOtherGroup(admin: OpenVault, name = 'Field team'): number {
  createGroup(admin, name)
  return listGroups(admin).find((group) => group.name === name)!.id
}

describe('RBAC', () => {
  it('refuses every people-management write to Managers, Viewers, and an Admin with a pending password change', async () => {
    const admin = await owner()
    await createUser(admin, { email: DEPUTY.email, password: DEPUTY.password, roleName: 'Admin', groupId: null })
    const record = await sealVault(admin)
    const sessions = [settlePassword(await openAs(record, MANAGER)), settlePassword(await openAs(record, MEMBER)), await openAs(record, DEPUTY)]
    expect(sessions[2].user.mustChangePassword).toBe(true)
    for (const vault of sessions) {
      const target = household.memberId === vault.user.id ? household.managerId : household.memberId
      expect(await code(() => createUser(vault, { email: 'x@maple.test', password: 'Saffron window kettle 40', roleName: 'Viewer', groupId: household.groupId }))).toBe('FORBIDDEN')
      expect(thrownCode(() => updateUser(vault, target, { roleName: 'Viewer', groupId: household.groupId, displayName: 'X' }))).toBe('FORBIDDEN')
      expect(thrownCode(() => bulkUpdateUsers(vault, [target], { roleName: 'Viewer' }))).toBe('FORBIDDEN')
      expect(thrownCode(() => requirePasswordChange(vault, target))).toBe('FORBIDDEN')
      expect(thrownCode(() => suspendUser(vault, target))).toBe('FORBIDDEN')
      expect(await code(() => reactivateUser(vault, target, { validity: '1h' }))).toBe('FORBIDDEN')
      expect(thrownCode(() => deleteUser(vault, target))).toBe('FORBIDDEN')
      expect(await code(() => resetUserPassword(vault, target, NEW_PASSWORD))).toBe('FORBIDDEN')
      expect(() => usersOverview(vault)).toThrow(ForbiddenError)
    }
  })
})

describe('editing people', () => {
  it('changes display name and email, relabels the password copy, and audits both', async () => {
    const admin = await owner()
    updateUser(admin, household.memberId, { roleName: 'Viewer', groupId: household.groupId, displayName: 'Malika', email: '  Malika@Maple.test ' })
    expect(admin.wraps.find((wrap) => wrap.userId === household.memberId)?.email).toBe('malika@maple.test')
    expect(listUsers(admin).find((person) => person.id === household.memberId)).toMatchObject({ email: 'malika@maple.test', displayName: 'Malika' })
    expect(readProfile(admin.db, household.memberId).updatedAt).not.toBeNull()
    expect(lastAudit(admin.db, 'USER_UPDATED')?.details).toMatchObject({ email: 'malika@maple.test', previousEmail: MEMBER.email, displayName: 'Malika' })
    const record = await sealVault(admin)
    await expect(unlockVault(record, MEMBER.email, MEMBER.password)).rejects.toBeInstanceOf(AuthError)
    const member = track(await unlockVault(record, 'malika@maple.test', MEMBER.password))
    expect(member.user.id).toBe(household.memberId)
  })

  it('keeps emails unique across people and open invitations, and refuses while the person has an open code', async () => {
    const admin = await owner()
    const edit = (email: string) => updateUser(admin, household.memberId, { roleName: 'Viewer', groupId: household.groupId, email })
    expect(thrownCode(() => edit(MANAGER.email.toUpperCase()))).toBe('DUPLICATE_EMAIL')
    expect(thrownCode(() => edit('not-an-email'))).toBe('EMAIL')
    await createInvite(admin, { email: INVITEE.email, roleName: 'Viewer', groupId: household.groupId, validity: '24h' })
    expect(thrownCode(() => edit(INVITEE.email))).toBe('GRANT_OPEN')
    await issueReset(admin, household.memberId, { validity: '1h', stopOldPassword: false })
    expect(thrownCode(() => edit('fresh@maple.test'))).toBe('USER_CODE_OPEN')
    expect(thrownCode(() => updateUser(admin, household.memberId, { roleName: 'Viewer', groupId: household.groupId, displayName: 'x'.repeat(LIMITS.nameChars + 1) }))).toBe('TOO_LONG')
    expect(listUsers(admin).find((person) => person.id === household.memberId)?.email).toBe(MEMBER.email)
  })

  it('changes role and group for several people at once, auditing each, all or nothing', async () => {
    const admin = await owner()
    const field = createOtherGroup(admin)
    const before = auditRows(admin.db).length
    expect(bulkUpdateUsers(admin, [household.managerId, household.memberId], { groupId: field })).toBe(2)
    const updates = auditRows(admin.db).slice(before).filter((row) => row.action === 'USER_UPDATED')
    expect(updates.map((row) => row.entityId).sort()).toEqual([household.managerId, household.memberId].sort())
    expect(updates.every((row) => (row.details as { bulk?: boolean }).bulk === true)).toBe(true)
    expect(bulkUpdateUsers(admin, [household.managerId, household.memberId], { roleName: 'Manager' })).toBe(1)
    expect(listUsers(admin).filter((person) => person.groupId === field).map((person) => person.roleName)).toEqual(['Manager', 'Manager'])

    writeProfile(admin.db, household.memberId, { status: 'FORMER' })
    expect(thrownCode(() => bulkUpdateUsers(admin, [household.managerId, household.memberId], { roleName: 'Viewer' }))).toBe('USER_FORMER')
    expect(listUsers(admin).find((person) => person.id === household.managerId)?.roleName).toBe('Manager')
    expect(thrownCode(() => bulkUpdateUsers(admin, [household.managerId], {}))).toBe('REQUIRED')
    expect(thrownCode(() => bulkUpdateUsers(admin, [], { roleName: 'Viewer' }))).toBe('REQUIRED')
    expect(thrownCode(() => bulkUpdateUsers(admin, [household.managerId], { roleName: 'Viewer', groupId: 99_999 }))).toBe('GROUP')
  })

  it('forces a password change, after which the person can do nothing until they choose one', async () => {
    const admin = await owner()
    const member = settlePassword(await openAs(household.record, MEMBER))
    const record = await sealVault(member)
    const again = await owner(record)
    requirePasswordChange(again, household.memberId)
    requirePasswordChange(again, household.memberId)
    expect(auditActions(again.db).filter((action) => action === 'USER_MUST_CHANGE_PASSWORD')).toHaveLength(1)
    expect(thrownCode(() => requirePasswordChange(again, again.user.id))).toBe('USE_ACCOUNT')
    const forced = await openAs(await sealVault(again), MEMBER)
    expect(forced.user.mustChangePassword).toBe(true)
    expect(canUser(forced.user, Permission.READ_TRANSACTIONS)).toBe(false)
    expect(admin.user.mustChangePassword).toBe(false)
  })
})

describe('the last Admin', () => {
  it('cannot be demoted, suspended, or deleted, and a suspended Admin does not count', async () => {
    const admin = await owner()
    expect(thrownCode(() => updateUser(admin, admin.user.id, { roleName: 'Manager', groupId: household.groupId }))).toBe('LAST_ADMIN')
    expect(thrownCode(() => bulkUpdateUsers(admin, [admin.user.id, household.memberId], { roleName: 'Viewer', groupId: household.groupId }))).toBe('LAST_ADMIN')
    expect(thrownCode(() => deleteUser(admin, admin.user.id))).toBe('SELF')
    expect(thrownCode(() => suspendUser(admin, admin.user.id))).toBe('SELF')

    const deputyId = await createUser(admin, { email: DEPUTY.email, password: DEPUTY.password, roleName: 'Admin', groupId: null })
    const deputy = settlePassword(await openAs(await sealVault(admin), DEPUTY))
    // Two active Admins: either may step down, but not both at once.
    expect(thrownCode(() => bulkUpdateUsers(deputy, [deputy.user.id, admin.user.id], { roleName: 'Manager', groupId: household.groupId }))).toBe('LAST_ADMIN')
    suspendUser(deputy, admin.user.id)
    expect(thrownCode(() => updateUser(deputy, deputyId, { roleName: 'Viewer', groupId: household.groupId }))).toBe('LAST_ADMIN')
    // Demoting the suspended Admin is fine; the active one stays.
    updateUser(deputy, admin.user.id, { roleName: 'Viewer', groupId: household.groupId })
    expect(listUsers(deputy).find((person) => person.id === admin.user.id)).toMatchObject({ roleName: 'Viewer', status: 'SUSPENDED' })
  })
})

describe('suspending and reactivating', () => {
  it('removes the password copy and open codes, blocks sign-in even with the old copy put back, and reactivates with a reset code', async () => {
    const admin = await owner()
    const oldWrap = admin.wraps.find((wrap) => wrap.userId === household.memberId)!
    const pending = await issueReset(admin, household.memberId, { validity: '24h', stopOldPassword: false })
    suspendUser(admin, household.memberId)
    expect(admin.wraps.some((wrap) => wrap.userId === household.memberId)).toBe(false)
    expect(admin.grants.some((grant) => grant.id === pending.id)).toBe(false)
    expect(listGrants(admin)).toEqual([])
    expect(lastAudit(admin.db, 'USER_SUSPENDED')?.details).toMatchObject({ email: MEMBER.email, hadPassword: true, codesRevoked: 1 })
    expect(lastAudit(admin.db, 'RESET_REVOKED')?.details).toMatchObject({ reason: 'SUSPENDED' })
    expect(listUsers(admin).find((person) => person.id === household.memberId)).toMatchObject({ status: 'SUSPENDED', access: 'NONE' })
    expect(thrownCode(() => suspendUser(admin, household.memberId))).toBe('USER_SUSPENDED')
    expect(await code(() => issueReset(admin, household.memberId, { validity: '1h', stopOldPassword: false }))).toBe('USER_SUSPENDED')
    expect(await code(() => resetUserPassword(admin, household.memberId, NEW_PASSWORD))).toBe('USER_SUSPENDED')

    const suspended = await sealVault(admin)
    await expect(unlockVault(suspended, MEMBER.email, MEMBER.password)).rejects.toBeInstanceOf(AuthError)
    await expect(redeemGrant(suspended, { kind: 'RESET', email: MEMBER.email, code: pending.code, password: NEW_PASSWORD })).rejects.toMatchObject({ code: 'INVITE_INVALID' })
    // Someone who kept their old password copy and puts it back into the envelope is still refused.
    const restored = await owner(suspended)
    restored.wraps.push(oldWrap)
    await expect(unlockVault(await sealVault(restored), MEMBER.email, MEMBER.password)).rejects.toBeInstanceOf(AuthError)

    const again = await owner(suspended)
    const reset = await reactivateUser(again, household.memberId, { validity: '1h' })
    expect(lastAudit(again.db, 'USER_REACTIVATED')?.details).toMatchObject({ email: MEMBER.email, expiresAt: reset.expiresAt })
    expect(lastAudit(again.db, 'RESET_ISSUED')?.details).toMatchObject({ userId: household.memberId, stopOldPassword: true })
    expect(listUsers(again).find((person) => person.id === household.memberId)).toMatchObject({ status: 'ACTIVE', access: 'CODE' })
    expect(await code(() => reactivateUser(again, household.memberId, { validity: '1h' }))).toBe('NOT_SUSPENDED')
    const joined = track(await redeemGrant(await sealVault(again), { kind: 'RESET', email: MEMBER.email, code: reset.code, password: NEW_PASSWORD }))
    expect(joined.user.id).toBe(household.memberId)
    track(await unlockVault(await sealVault(joined), MEMBER.email, NEW_PASSWORD))
  })

  it('frees the member slot while suspended and checks the limit again on reactivation', async () => {
    const admin = await owner()
    suspendUser(admin, household.memberId)
    padWraps(admin, LIMITS.wraps)
    expect(usersOverview(admin)).toMatchObject({ slotsUsed: LIMITS.wraps, slotsReserved: 0, suspended: 1 })
    expect(await code(() => reactivateUser(admin, household.memberId, { validity: '1h' }))).toBe('MEMBER_LIMIT')
    expect(readProfile(admin.db, household.memberId).status).toBe('SUSPENDED')
    expect(await code(() => issueReset(admin, household.managerId, { validity: '1h', stopOldPassword: true }))).toBe('OK')
  })

  it('reserves a slot for a reset given to someone without a password copy', async () => {
    const admin = await owner()
    const reset = await issueReset(admin, household.memberId, { validity: '1h', stopOldPassword: true })
    revokeGrant(admin, reset.id)
    expect(listUsers(admin).find((person) => person.id === household.memberId)?.access).toBe('NONE')
    expect(usersOverview(admin).noAccess).toBe(1)
    padWraps(admin, LIMITS.wraps)
    expect(await code(() => issueReset(admin, household.memberId, { validity: '1h', stopOldPassword: false }))).toBe('MEMBER_LIMIT')
  })

  it('counts a suspended Admin as a member but not as active', async () => {
    const admin = await owner()
    await createUser(admin, { email: DEPUTY.email, password: DEPUTY.password, roleName: 'Admin', groupId: null })
    const deputy = settlePassword(await openAs(await sealVault(admin), DEPUTY))
    suspendUser(deputy, admin.user.id)
    expect(usersOverview(deputy)).toMatchObject({ members: 4, active: 3, suspended: 1 })
    expect(usersOverview(deputy).byRole.find((entry) => entry.role === 'Admin')?.count).toBe(2)
    expect(thrownCode(() => deleteUser(deputy, admin.user.id))).toBeUndefined()
  })
})

describe('deleting people', () => {
  it('asks what happens to their records and checks the typed email', async () => {
    const admin = await owner(await managerWithRecords())
    expect(thrownCode(() => deleteUser(admin, household.managerId))).toBe('HAS_RECORDS')
    expect(thrownCode(() => deleteUser(admin, household.managerId, { records: 'KEEP', confirmEmail: 'someone@else.test' }))).toBe('CONFIRM_EMAIL')
    expect(thrownCode(() => deleteUser(admin, household.managerId, { records: 'REASSIGN' }))).toBe('REASSIGN_TARGET')
    expect(thrownCode(() => deleteUser(admin, household.managerId, { records: 'REASSIGN', reassignTo: household.managerId }))).toBe('REASSIGN_TARGET')
    expect(thrownCode(() => deleteUser(admin, household.managerId, { records: 'REASSIGN', reassignTo: 'nobody' }))).toBe('REASSIGN_TARGET')
    expect(thrownCode(() => deleteUser(admin, 'nobody'))).toBe('REQUIRED')
  })

  it('moves records to another person, keeping every total, and keeps the deleted person named in the audit log', async () => {
    const admin = await owner(await managerWithRecords())
    const before = totals(admin)
    deleteUser(admin, household.managerId, { records: 'REASSIGN', reassignTo: household.memberId, confirmEmail: MANAGER.email.toUpperCase() })
    expect(totals(admin)).toEqual(before)
    expect(Number(admin.db.queryValue('SELECT COUNT(*) FROM transactions WHERE user_id = ?', [household.memberId]))).toBe(3)
    expect(admin.db.queryValue('SELECT 1 FROM users WHERE id = ?', [household.managerId]) ?? null).toBeNull()
    expect(admin.wraps.some((wrap) => wrap.userId === household.managerId)).toBe(false)
    expect(lastAudit(admin.db, 'TRANSACTIONS_REASSIGNED')?.details).toMatchObject({ email: MANAGER.email, to: household.memberId, count: 3 })
    expect(lastAudit(admin.db, 'USER_DELETED')?.details).toMatchObject({ email: MANAGER.email, records: 'REASSIGNED', count: 3 })
    const authored = listAudit(admin, 500).filter((entry) => entry.actorId === household.managerId)
    expect(authored.length).toBeGreaterThan(0)
    expect(authored.every((entry) => entry.actorEmail === MANAGER.email)).toBe(true)
    expect(admin.db.query('PRAGMA foreign_key_check')).toEqual([])
    const record = await sealVault(admin)
    await expect(unlockVault(record, MANAGER.email, MANAGER.password)).rejects.toBeInstanceOf(AuthError)
    const reopened = await owner(record)
    expect(totals(reopened)).toEqual(before)
  })

  it('keeps records under a former member who cannot sign in or come back', async () => {
    const admin = await owner(await managerWithRecords())
    const before = totals(admin)
    await issueReset(admin, household.managerId, { validity: '1h', stopOldPassword: false })
    deleteUser(admin, household.managerId, { records: 'KEEP', confirmEmail: MANAGER.email })
    expect(totals(admin)).toEqual(before)
    expect(listUsers(admin).find((person) => person.id === household.managerId)).toMatchObject({ status: 'FORMER', access: 'NONE', records: 3 })
    expect(listGrants(admin)).toEqual([])
    expect(lastAudit(admin.db, 'USER_DELETED')?.details).toMatchObject({ email: MANAGER.email, records: 'KEPT', count: 3 })
    expect(usersOverview(admin)).toMatchObject({ members: 2, former: 1 })
    expect(thrownCode(() => updateUser(admin, household.managerId, { roleName: 'Viewer', groupId: household.groupId }))).toBe('USER_FORMER')
    expect(thrownCode(() => suspendUser(admin, household.managerId))).toBe('USER_FORMER')
    expect(await code(() => reactivateUser(admin, household.managerId, { validity: '1h' }))).toBe('NOT_SUSPENDED')
    expect(await code(() => issueReset(admin, household.managerId, { validity: '1h', stopOldPassword: false }))).toBe('USER_FORMER')
    expect(thrownCode(() => deleteUser(admin, household.managerId, { records: 'KEEP' }))).toBe('USER_FORMER')
    const record = await sealVault(admin)
    await expect(unlockVault(record, MANAGER.email, MANAGER.password)).rejects.toBeInstanceOf(AuthError)

    const later = await owner(record)
    deleteUser(later, household.managerId, { records: 'REASSIGN', reassignTo: later.user.id })
    expect(totals(later)).toEqual(before)
    expect(later.db.queryValue('SELECT 1 FROM users WHERE id = ?', [household.managerId]) ?? null).toBeNull()
  })

  it('refuses to move records to a former member', async () => {
    const admin = await owner(await managerWithRecords())
    deleteUser(admin, household.memberId)
    const deputyId = await createUser(admin, { email: DEPUTY.email, password: DEPUTY.password, roleName: 'Viewer', groupId: household.groupId })
    writeProfile(admin.db, deputyId, { status: 'FORMER' })
    expect(thrownCode(() => deleteUser(admin, household.managerId, { records: 'REASSIGN', reassignTo: deputyId }))).toBe('REASSIGN_TARGET')
  })
})

describe('the overview', () => {
  it('counts people by role and group, sign-in checks, pending changes, open codes and members near the limit', async () => {
    const admin = await owner()
    const invite = await createInvite(admin, { email: INVITEE.email, roleName: 'Viewer', groupId: household.groupId, validity: '15m' })
    const overview = usersOverview(admin)
    expect(overview).toMatchObject({ members: 3, former: 0, suspended: 0, limit: LIMITS.wraps, slotsUsed: 3, slotsReserved: 1, active: 3, totpOn: 0, mustChange: 2, noGroup: 0 })
    expect(overview.byRole).toEqual([
      { role: 'Admin', count: 1 },
      { role: 'Manager', count: 1 },
      { role: 'Viewer', count: 1 },
    ])
    expect(overview.byGroup).toEqual([
      { groupId: household.groupId, name: listGroups(admin)[0].name, count: 2 },
      { groupId: null, name: null, count: 1 },
    ])
    expect(overview.openCodes).toEqual([{ id: invite.id, kind: 'INVITE', email: INVITEE.email, expiresAt: invite.expiresAt, expired: false }])
    expect(JSON.stringify(overview)).not.toContain(invite.code)
    expect(usersOverview(admin, new Date(Date.parse(invite.expiresAt) + 1)).openCodes[0].expired).toBe(true)
  })

  it('lists recent sign-ins and older password copies', async () => {
    const admin = await owner()
    writeProfile(admin.db, household.managerId, { lastSignInAt: new Date(Date.now() - 40 * 86_400_000).toISOString() })
    writeProfile(admin.db, household.memberId, { lastSignInAt: new Date().toISOString() })
    const memberWrap = admin.wraps.find((wrap) => wrap.userId === household.memberId)!
    const { aad: _aad, ...legacy } = memberWrap
    admin.wraps[admin.wraps.indexOf(memberWrap)] = legacy
    const overview = usersOverview(admin)
    expect(overview.recent.map((entry) => entry.id)).toEqual([household.memberId, household.managerId])
    expect(overview.activeLast30).toBe(1)
    expect(overview.legacyWraps).toBe(1)
    expect(listUsers(admin).find((person) => person.id === household.memberId)?.legacyWrap).toBe(true)
  })
})

describe('profiles', () => {
  it('note sign-ins at most every ten minutes', async () => {
    const admin = await owner()
    const now = new Date('2026-10-01T10:00:00.000Z')
    expect(noteSignIn(admin.db, household.memberId, now)).toBe(true)
    expect(noteSignIn(admin.db, household.memberId, new Date(now.getTime() + SIGN_IN_RESOLUTION_MS - 1))).toBe(false)
    expect(noteSignIn(admin.db, household.memberId, new Date(now.getTime() + SIGN_IN_RESOLUTION_MS))).toBe(true)
    expect(readProfile(admin.db, household.memberId).lastSignInAt).toBe(new Date(now.getTime() + SIGN_IN_RESOLUTION_MS).toISOString())
  })

  it('read damaged or hostile rows as an active person without a name', () => {
    const empty = { displayName: null, updatedAt: null, lastSignInAt: null, status: 'ACTIVE', statusAt: null }
    for (const text of [null, '', 'not json', '[]', '{"status":"ADMIN"}', '{"__proto__":{"status":"FORMER"}}', 'x'.repeat(2000)]) expect(parseProfile(text)).toEqual(empty)
    expect(parseProfile('{"displayName":"  Ali  ","lastSignInAt":"yesterday","status":"SUSPENDED"}')).toMatchObject({ displayName: 'Ali', lastSignInAt: null, status: 'SUSPENDED' })
  })

  it('leave the schema at version 4, so older versions still open the vault', async () => {
    const admin = await owner()
    updateUser(admin, household.memberId, { roleName: 'Viewer', groupId: household.groupId, displayName: 'Malika' })
    suspendUser(admin, household.managerId)
    expect(readSchemaVersion(admin.db)).toBe(4)
    await assertKnownSchema(admin.db, 4)
    const record = await sealVault(admin)
    expect(record.schemaVersion).toBe(4)
  })
})
