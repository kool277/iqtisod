import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CURRENT_KDF } from '../../src/crypto/crypto.service'
import { decodeStoredRecord, type VaultRecord } from '../../src/db/envelope'
import { AuthError, ForbiddenError } from '../../src/domain/errors'
import type { GrantWrap, OpenVault } from '../../src/domain/types'
import { generateAccessCode, normalizeAccessCode } from '../../src/lib/access-code'
import { base32Decode, importTotpKey, totpAt } from '../../src/lib/totp'
import { permissionsForRole } from '../../src/rbac'
import { sealVault, unlockVault } from '../../src/services/auth.service'
import { backupFileText, parseBackup } from '../../src/services/backup.service'
import {
  DEFAULT_GRANT_VALIDITY,
  GRANT_VALIDITY,
  createInvite,
  isGrantValidity,
  issueReset,
  listGrants,
  redeemGrant,
  revokeGrant,
  type GrantValidity,
  type IssuedGrant,
} from '../../src/services/grant.service'
import { endGrant, sweepGrants } from '../../src/services/grant-store'
import { createGroup, deleteGroup, listGroups } from '../../src/services/group.service'
import { beginTotpSetup, enableTotp, hasSignInCheck } from '../../src/services/totp.service'
import { listUsers } from '../../src/services/user.service'
import {
  HOUR,
  INVITEE,
  MANAGER,
  MEMBER,
  MINUTE,
  NEW_PASSWORD,
  OWNER,
  VAULT_NAME,
  auditActions,
  auditRows,
  buildAccessHousehold,
  expectNoSecretsStored,
  grantRowOf,
  lastAudit,
  openAs,
  thrownCode,
  type Household,
} from '../support/access'
import { closeTracked, track } from '../support/safes'

const CODE_PATTERN = /^(?:[0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{3}[0-9A-HJKMNP-TV-Z*~$=U]$/

let household: Household

beforeAll(async () => {
  household = await buildAccessHousehold()
  closeTracked()
})

afterEach(closeTracked)

function roleIdOf(vault: OpenVault, name: string): number {
  return Number(vault.db.queryValue('SELECT id FROM roles WHERE name = ?', [name]))
}

function fakeGrant(index: number): GrantWrap {
  return {
    id: `fake-${index}`,
    kind: 'INVITE',
    email: `fake${index}@maple.test`,
    kdf: { ...CURRENT_KDF },
    salt: new Uint8Array(16),
    iv: new Uint8Array(12),
    wrappedDek: new ArrayBuffer(48),
  }
}

function insertOpenInvites(vault: OpenVault, count: number): void {
  const createdAt = new Date().toISOString()
  const expiresAt = new Date(Date.now() + HOUR).toISOString()
  for (let index = 0; index < count; index += 1) {
    vault.db.exec(
      `INSERT INTO access_grants (id, kind, email, role_id, code_verifier, created_at, expires_at)
       VALUES (?, 'INVITE', ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), `filler${index}@maple.test`, roleIdOf(vault, 'Viewer'), '0'.repeat(64), createdAt, expiresAt],
    )
  }
}

function redeem(record: VaultRecord, input: Parameters<typeof redeemGrant>[1], now?: Date): Promise<OpenVault> {
  return redeemGrant(record, input, now).then(track)
}

describe('createInvite', () => {
  it('issues a one-time code, stores only a verifier, and audits without the code', async () => {
    const admin = await openAs(household.record, OWNER)
    const now = new Date()
    const issued = await createInvite(admin, { email: '  Dilnoza.Rahimova@Maple.TEST ', roleName: 'Manager', groupId: household.groupId, validity: '72h' }, now)

    expect(issued).toEqual({ id: expect.any(String), kind: 'INVITE', email: INVITEE.email, code: expect.any(String), expiresAt: new Date(now.getTime() + 72 * HOUR).toISOString() })
    expect(issued.code).toMatch(CODE_PATTERN)
    expect(normalizeAccessCode(issued.code)).toBe(issued.code.replace(/-/g, ''))
    expect(grantRowOf(admin.db, issued.id)).toMatchObject({
      kind: 'INVITE',
      email: INVITEE.email,
      user_id: null,
      role_id: roleIdOf(admin, 'Manager'),
      group_id: household.groupId,
      stop_old_password: 0,
      created_by: admin.user.id,
      created_at: now.toISOString(),
      expires_at: issued.expiresAt,
      ended_at: null,
      ended_reason: null,
      ended_by: null,
    })
    expect(String(grantRowOf(admin.db, issued.id)!.code_verifier)).toMatch(/^[0-9a-f]{64}$/)
    expect(admin.grants.map((grant) => ({ id: grant.id, kind: grant.kind, email: grant.email }))).toEqual([{ id: issued.id, kind: 'INVITE', email: INVITEE.email }])
    expect(admin.grants[0].kdf).toEqual(CURRENT_KDF)
    expect(lastAudit(admin.db, 'INVITE_CREATED')).toEqual({
      actorId: admin.user.id,
      action: 'INVITE_CREATED',
      entityType: 'grant',
      entityId: issued.id,
      details: { email: INVITEE.email, role: 'Manager', groupId: household.groupId, expiresAt: issued.expiresAt },
    })
    expectNoSecretsStored(admin.db, [issued.code])

    const record = await sealVault(admin)
    expect((record.grants ?? []).map((grant) => grant.id)).toEqual([issued.id])
    const text = backupFileText(record)
    expect(text.includes(issued.code)).toBe(false)
    expect(text.includes(issued.code.replace(/-/g, ''))).toBe(false)
  })

  it('supports every validity and defaults to 24 hours', async () => {
    expect(DEFAULT_GRANT_VALIDITY).toBe('24h')
    expect(Object.keys(GRANT_VALIDITY)).toEqual(['15m', '1h', '24h', '72h', '7d'])
    expect(isGrantValidity('2d')).toBe(false)
    expect(isGrantValidity('toString')).toBe(false)
    const admin = await openAs(household.record, OWNER)
    const now = new Date()
    const expected: Record<GrantValidity, number> = { '15m': 15 * MINUTE, '1h': HOUR, '24h': 24 * HOUR, '72h': 72 * HOUR, '7d': 168 * HOUR }
    for (const [index, validity] of (Object.keys(expected) as GrantValidity[]).entries()) {
      const issued = await createInvite(admin, { email: `valid${index}@maple.test`, roleName: 'Viewer', groupId: household.groupId, validity }, now)
      expect(Date.parse(issued.expiresAt) - now.getTime(), validity).toBe(expected[validity])
    }
    await expect(
      createInvite(admin, { email: 'bogus@maple.test', roleName: 'Viewer', groupId: household.groupId, validity: 'forever' as GrantValidity }),
    ).rejects.toMatchObject({ code: 'REQUIRED' })
  })

  it('refuses existing users, open codes, bad roles or groups, bad emails and a clock behind the vault', async () => {
    const admin = await openAs(household.record, OWNER)
    const base = { roleName: 'Viewer' as const, groupId: household.groupId, validity: '1h' as const }
    await expect(createInvite(admin, { ...base, email: 'KEEPER@maple.test' })).rejects.toMatchObject({ code: 'DUPLICATE_EMAIL' })
    await expect(createInvite(admin, { ...base, email: MEMBER.email })).rejects.toMatchObject({ code: 'DUPLICATE_EMAIL' })
    await createInvite(admin, { ...base, email: INVITEE.email })
    await expect(createInvite(admin, { ...base, email: INVITEE.email.toUpperCase() })).rejects.toMatchObject({ code: 'GRANT_OPEN' })
    await expect(createInvite(admin, { ...base, email: 'nogroup@maple.test', groupId: null })).rejects.toMatchObject({ code: 'GROUP' })
    await expect(createInvite(admin, { ...base, email: 'nogroup@maple.test', roleName: 'Manager', groupId: null })).rejects.toMatchObject({ code: 'GROUP' })
    await expect(createInvite(admin, { ...base, email: 'ghost@maple.test', groupId: 9999 })).rejects.toMatchObject({ code: 'GROUP' })
    await expect(createInvite(admin, { ...base, email: 'owner2@maple.test', roleName: 'Owner' as 'Admin' })).rejects.toMatchObject({ code: 'ROLE' })
    await expect(createInvite(admin, { ...base, email: 'not-an-email' })).rejects.toMatchObject({ code: 'EMAIL' })
    await expect(createInvite(admin, { ...base, email: 'late@maple.test' }, new Date(Date.now() - 10 * MINUTE))).rejects.toMatchObject({
      code: 'CLOCK_BEHIND',
    })
    expect(admin.grants).toHaveLength(1)
    expect(Number(admin.db.queryValue('SELECT COUNT(*) FROM access_grants'))).toBe(1)
    expect(auditActions(admin.db).filter((action) => action === 'INVITE_CREATED')).toHaveLength(1)

    const coAdmin = await createInvite(admin, { ...base, email: 'co-admin@maple.test', roleName: 'Admin', groupId: null })
    expect(grantRowOf(admin.db, coAdmin.id)).toMatchObject({ role_id: roleIdOf(admin, 'Admin'), group_id: null })
  })

  it('is limited to managers of users', async () => {
    for (const who of [MANAGER, MEMBER]) {
      const vault = await openAs(household.record, who)
      await expect(createInvite(vault, { email: 'x@maple.test', roleName: 'Viewer', groupId: household.groupId, validity: '1h' })).rejects.toBeInstanceOf(
        ForbiddenError,
      )
      expect(() => listGrants(vault)).toThrow(ForbiddenError)
      expect(() => revokeGrant(vault, 'anything')).toThrow(ForbiddenError)
      await expect(issueReset(vault, household.memberId, { validity: '1h', stopOldPassword: false })).rejects.toBeInstanceOf(ForbiddenError)
    }
  })

  it('caps open invites at 20 and envelope grants at 64', async () => {
    const admin = await openAs(household.record, OWNER)
    const base = { roleName: 'Viewer' as const, groupId: household.groupId, validity: '1h' as const }
    insertOpenInvites(admin, 19)
    await createInvite(admin, { ...base, email: 'twentieth@maple.test' })
    await expect(createInvite(admin, { ...base, email: 'twenty-first@maple.test' })).rejects.toMatchObject({ code: 'INVITE_LIMIT' })

    const other = await openAs(household.record, OWNER)
    other.grants.push(...Array.from({ length: 64 }, (_, index) => fakeGrant(index)))
    await expect(createInvite(other, { ...base, email: 'full@maple.test' })).rejects.toMatchObject({ code: 'INVITE_LIMIT' })
    await expect(issueReset(other, household.memberId, { validity: '1h', stopOldPassword: false })).rejects.toMatchObject({ code: 'INVITE_LIMIT' })
    other.grants.pop()
    const reset = await issueReset(other, household.memberId, { validity: '1h', stopOldPassword: false })
    expect(other.grants.at(-1)!.id).toBe(reset.id)
  })
})

describe('issueReset', () => {
  it('issues a reset code for a member, keeping the old password until it is used', async () => {
    const admin = await openAs(household.record, OWNER)
    const now = new Date()
    const reset = await issueReset(admin, household.memberId, { validity: '1h', stopOldPassword: false }, now)
    expect(reset).toEqual({ id: expect.any(String), kind: 'RESET', email: MEMBER.email, code: expect.stringMatching(CODE_PATTERN), expiresAt: new Date(now.getTime() + HOUR).toISOString() })
    expect(grantRowOf(admin.db, reset.id)).toMatchObject({ kind: 'RESET', email: MEMBER.email, user_id: household.memberId, role_id: null, group_id: null, stop_old_password: 0 })
    expect(lastAudit(admin.db, 'RESET_ISSUED')).toEqual({
      actorId: admin.user.id,
      action: 'RESET_ISSUED',
      entityType: 'grant',
      entityId: reset.id,
      details: { email: MEMBER.email, userId: household.memberId, expiresAt: reset.expiresAt, stopOldPassword: false },
    })
    expect(admin.wraps.some((wrap) => wrap.userId === household.memberId)).toBe(true)
    expectNoSecretsStored(admin.db, [reset.code])
    const record = await sealVault(admin)
    await expect(openAs(record, MEMBER)).resolves.toMatchObject({ user: { id: household.memberId } })
  })

  it('replaces the open code for the same person', async () => {
    const admin = await openAs(household.record, OWNER)
    const first = await issueReset(admin, household.memberId, { validity: '1h', stopOldPassword: false })
    const second = await issueReset(admin, household.memberId, { validity: '24h', stopOldPassword: false })
    expect(grantRowOf(admin.db, first.id)).toMatchObject({ ended_reason: 'REPLACED', ended_by: admin.user.id, ended_at: expect.any(String) })
    expect(grantRowOf(admin.db, second.id)).toMatchObject({ ended_at: null })
    expect(lastAudit(admin.db, 'RESET_REVOKED')).toMatchObject({ actorId: admin.user.id, entityId: first.id, details: { email: MEMBER.email, reason: 'REPLACED' } })
    expect(admin.grants.map((grant) => grant.id)).toEqual([second.id])
    expect(listGrants(admin).map((grant) => grant.id)).toEqual([second.id])
    expectNoSecretsStored(admin.db, [first.code, second.code])

    const record = await sealVault(admin)
    await expect(redeem(record, { kind: 'RESET', email: MEMBER.email, code: first.code, password: NEW_PASSWORD })).rejects.toMatchObject({ code: 'INVITE_INVALID' })
  })

  it('stops the old password at once when asked', async () => {
    const admin = await openAs(household.record, OWNER)
    const reset = await issueReset(admin, household.memberId, { validity: '1h', stopOldPassword: true })
    expect(admin.wraps.some((wrap) => wrap.userId === household.memberId)).toBe(false)
    expect(grantRowOf(admin.db, reset.id)).toMatchObject({ stop_old_password: 1 })
    expect(listGrants(admin)).toEqual([expect.objectContaining({ id: reset.id, kind: 'RESET', stopOldPassword: true, roleName: null, groupName: null })])
    const record = await sealVault(admin)
    expect(record.wraps.some((wrap) => wrap.email === MEMBER.email)).toBe(false)
    await expect(unlockVault(record, MEMBER.email, MEMBER.password)).rejects.toBeInstanceOf(AuthError)
    await expect(openAs(record, MANAGER)).resolves.toBeTruthy()
  })

  it('refuses the admin themself, unknown users, bad validity and a clock behind the vault', async () => {
    const admin = await openAs(household.record, OWNER)
    await expect(issueReset(admin, admin.user.id, { validity: '1h', stopOldPassword: false })).rejects.toMatchObject({ code: 'USE_ACCOUNT' })
    await expect(issueReset(admin, 'no-such-user', { validity: '1h', stopOldPassword: false })).rejects.toMatchObject({ code: 'REQUIRED' })
    await expect(issueReset(admin, household.memberId, { validity: '1y' as GrantValidity, stopOldPassword: false })).rejects.toMatchObject({ code: 'REQUIRED' })
    await expect(issueReset(admin, household.memberId, { validity: '1h', stopOldPassword: true }, new Date(Date.now() - 10 * MINUTE))).rejects.toMatchObject({
      code: 'CLOCK_BEHIND',
    })
    expect(admin.wraps.some((wrap) => wrap.userId === household.memberId)).toBe(true)
    expect(admin.grants).toEqual([])
    expect(Number(admin.db.queryValue('SELECT COUNT(*) FROM access_grants'))).toBe(0)
  })
})

describe('listGrants and revokeGrant', () => {
  it('lists only open grants, newest first, with role, group and expiry', async () => {
    const admin = await openAs(household.record, OWNER)
    const now = Date.now()
    const invite = await createInvite(admin, { email: INVITEE.email, roleName: 'Manager', groupId: household.groupId, validity: '15m' }, new Date(now))
    const reset = await issueReset(admin, household.memberId, { validity: '7d', stopOldPassword: false }, new Date(now + 1000))
    const revoked = await createInvite(admin, { email: 'gone@maple.test', roleName: 'Viewer', groupId: household.groupId, validity: '1h' }, new Date(now + 2000))
    revokeGrant(admin, revoked.id)

    expect(listGrants(admin, new Date(now + 3000))).toEqual([
      { id: reset.id, kind: 'RESET', email: MEMBER.email, roleName: null, groupName: null, createdAt: new Date(now + 1000).toISOString(), expiresAt: reset.expiresAt, expired: false, stopOldPassword: false },
      { id: invite.id, kind: 'INVITE', email: INVITEE.email, roleName: 'Manager', groupName: VAULT_NAME, createdAt: new Date(now).toISOString(), expiresAt: invite.expiresAt, expired: false, stopOldPassword: false },
    ])
    expect(listGrants(admin, new Date(now + 15 * MINUTE)).map((grant) => [grant.kind, grant.expired])).toEqual([
      ['RESET', false],
      ['INVITE', true],
    ])
  })

  it('revokes invites and resets with the matching audit action', async () => {
    const admin = await openAs(household.record, OWNER)
    const invite = await createInvite(admin, { email: INVITEE.email, roleName: 'Viewer', groupId: household.groupId, validity: '1h' })
    const reset = await issueReset(admin, household.memberId, { validity: '1h', stopOldPassword: false })
    revokeGrant(admin, invite.id)
    revokeGrant(admin, reset.id)
    expect(grantRowOf(admin.db, invite.id)).toMatchObject({ ended_reason: 'REVOKED', ended_by: admin.user.id })
    expect(grantRowOf(admin.db, reset.id)).toMatchObject({ ended_reason: 'REVOKED', ended_by: admin.user.id })
    expect(lastAudit(admin.db, 'INVITE_REVOKED')).toMatchObject({ actorId: admin.user.id, entityId: invite.id, details: { email: INVITEE.email } })
    expect(lastAudit(admin.db, 'RESET_REVOKED')).toMatchObject({ actorId: admin.user.id, entityId: reset.id, details: { email: MEMBER.email } })
    expect(admin.grants).toEqual([])
    expect(listGrants(admin)).toEqual([])
    expect(thrownCode(() => revokeGrant(admin, invite.id))).toBe('REQUIRED')
    expect(thrownCode(() => revokeGrant(admin, 'no-such-grant'))).toBe('REQUIRED')
    expectNoSecretsStored(admin.db, [invite.code, reset.code])

    const record = await sealVault(admin)
    expect(record.grants ?? []).toEqual([])
    await expect(redeem(record, { kind: 'INVITE', email: INVITEE.email, code: invite.code, password: INVITEE.password })).rejects.toMatchObject({
      code: 'INVITE_INVALID',
    })
  })
})

describe('redeemGrant', () => {
  let pending: VaultRecord
  let invite: IssuedGrant
  let reset: IssuedGrant

  beforeAll(async () => {
    const admin = await openAs(household.record, OWNER)
    invite = await createInvite(admin, { email: INVITEE.email, roleName: 'Manager', groupId: household.groupId, validity: '1h' })
    reset = await issueReset(admin, household.memberId, { validity: '1h', stopOldPassword: false })
    pending = await sealVault(admin)
    closeTracked()
  })

  it('creates the invited member with their role and group, and ends the invite', async () => {
    const code = invite.code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l')
    const member = await redeem(pending, { kind: 'INVITE', email: ' Dilnoza.RAHIMOVA@maple.test ', code, password: INVITEE.password })
    expect(member.user).toMatchObject({ email: INVITEE.email, roleName: 'Manager', groupId: household.groupId, mustChangePassword: false })
    expect(member.user.permissions).toEqual(permissionsForRole('Manager'))
    expect(member.needsSave).toBe(true)
    expect(member.grants.map((grant) => grant.id)).toEqual([reset.id])
    expect(member.wraps.map((wrap) => wrap.email).sort()).toEqual([INVITEE.email, MANAGER.email, MEMBER.email, OWNER.email].sort())
    expect(grantRowOf(member.db, invite.id)).toMatchObject({ ended_reason: 'USED', ended_by: member.user.id })
    expect(Number(member.db.queryValue('SELECT must_change_password FROM users WHERE id = ?', [member.user.id]))).toBe(0)
    expect(lastAudit(member.db, 'INVITE_ACCEPTED')).toEqual({
      actorId: member.user.id,
      action: 'INVITE_ACCEPTED',
      entityType: 'grant',
      entityId: invite.id,
      details: { email: INVITEE.email, role: 'Manager', groupId: household.groupId },
    })
    expectNoSecretsStored(member.db, [invite.code, reset.code, INVITEE.password])

    const saved = await sealVault(member)
    expect((saved.grants ?? []).map((grant) => grant.id)).toEqual([reset.id])
    const again = await openAs(saved, INVITEE)
    expect(again.user.id).toBe(member.user.id)
    const admin = await openAs(saved, OWNER)
    expect(listGrants(admin).map((grant) => grant.id)).toEqual([reset.id])
    expect(listUsers(admin).find((user) => user.email === INVITEE.email)).toMatchObject({ roleName: 'Manager', signInCheck: false })
    await expect(redeem(saved, { kind: 'INVITE', email: INVITEE.email, code: invite.code, password: NEW_PASSWORD })).rejects.toMatchObject({ code: 'INVITE_INVALID' })
  })

  it('resets a member password with a reset code', async () => {
    const member = await redeem(pending, { kind: 'RESET', email: MEMBER.email, code: reset.code, password: NEW_PASSWORD })
    expect(member.user).toMatchObject({ id: household.memberId, email: MEMBER.email, roleName: 'Viewer', mustChangePassword: false })
    expect(member.grants.map((grant) => grant.id)).toEqual([invite.id])
    expect(grantRowOf(member.db, reset.id)).toMatchObject({ ended_reason: 'USED', ended_by: household.memberId })
    expect(lastAudit(member.db, 'RESET_COMPLETED')).toEqual({
      actorId: household.memberId,
      action: 'RESET_COMPLETED',
      entityType: 'grant',
      entityId: reset.id,
      details: { email: MEMBER.email },
    })
    expect(auditActions(member.db)).not.toContain('TOTP_CLEARED')
    expectNoSecretsStored(member.db, [invite.code, reset.code, NEW_PASSWORD])
    const saved = await sealVault(member)
    await expect(unlockVault(saved, MEMBER.email, MEMBER.password)).rejects.toBeInstanceOf(AuthError)
    await expect(openAs(saved, MEMBER, NEW_PASSWORD)).resolves.toMatchObject({ user: { id: household.memberId } })
  })

  it('redeems from a backup file and from the stored record encoding', async () => {
    const restored = parseBackup(backupFileText(pending)).record
    expect((restored.grants ?? []).map((grant) => [grant.id, grant.kind, grant.email])).toEqual([
      [invite.id, 'INVITE', INVITEE.email],
      [reset.id, 'RESET', MEMBER.email],
    ])
    const member = await redeem(restored, { kind: 'INVITE', email: INVITEE.email, code: invite.code, password: INVITEE.password })
    expect(member.user.email).toBe(INVITEE.email)
    const decoded = decodeStoredRecord(pending).record
    await expect(redeem(decoded, { kind: 'RESET', email: MEMBER.email, code: reset.code, password: NEW_PASSWORD })).resolves.toMatchObject({
      user: { id: household.memberId },
    })
  })

  it('rejects unknown, mismatched and malformed codes without saying which part was wrong', async () => {
    const password = NEW_PASSWORD
    const cases: [Parameters<typeof redeemGrant>[1], string][] = [
      [{ kind: 'INVITE', email: 'stranger@maple.test', code: invite.code, password }, 'INVITE_INVALID'],
      [{ kind: 'INVITE', email: INVITEE.email, code: generateAccessCode().display, password }, 'INVITE_INVALID'],
      [{ kind: 'INVITE', email: INVITEE.email, code: reset.code, password }, 'INVITE_INVALID'],
      [{ kind: 'RESET', email: INVITEE.email, code: invite.code, password }, 'INVITE_INVALID'],
      [{ kind: 'INVITE', email: MEMBER.email, code: reset.code, password }, 'INVITE_INVALID'],
      [{ kind: 'RESET', email: MANAGER.email, code: reset.code, password }, 'INVITE_INVALID'],
      [{ kind: 'INVITE', email: INVITEE.email, code: 'ABCD-EFGH', password }, 'INVITE_CODE'],
      [{ kind: 'INVITE', email: INVITEE.email, code: `${invite.code[0] === 'A' ? 'B' : 'A'}${invite.code.slice(1)}`, password }, 'INVITE_CODE'],
      [{ kind: 'INVITE', email: 'not-an-email', code: invite.code, password }, 'EMAIL'],
      [{ kind: 'INVITE', email: 'stranger@maple.test', code: invite.code, password: 'short' }, 'PASSWORD_SHORT'],
    ]
    for (const [input, code] of cases) {
      await expect(redeem(pending, input), JSON.stringify(input)).rejects.toMatchObject({ code })
    }
  })

  it('rejects expired codes and a clock behind the vault', async () => {
    const input = { kind: 'INVITE' as const, email: INVITEE.email, code: invite.code, password: INVITEE.password }
    await expect(redeem(pending, input, new Date(invite.expiresAt))).rejects.toMatchObject({ code: 'INVITE_EXPIRED' })
    await expect(redeem(pending, input, new Date(Date.parse(invite.expiresAt) + 7 * 24 * HOUR))).rejects.toMatchObject({ code: 'INVITE_EXPIRED' })
    await expect(redeem(pending, input, new Date(Date.now() - 10 * MINUTE))).rejects.toMatchObject({ code: 'CLOCK_BEHIND' })
    await expect(redeem(pending, { ...input, password: 'qwertyuiopasdfgh' }, new Date(Date.now() - 4 * MINUTE))).rejects.toMatchObject({ code: 'PASSWORD_COMMON' })
  })

  it('applies the password policy with the member email and vault name as context', async () => {
    const base = { kind: 'INVITE' as const, email: INVITEE.email, code: invite.code }
    await expect(redeem(pending, { ...base, password: 'aaaaaaaaaaaaaaaa' })).rejects.toMatchObject({ code: 'PASSWORD_COMMON' })
    await expect(redeem(pending, { ...base, password: 'Dilnoza.Rahimova!7' })).rejects.toMatchObject({ code: 'PASSWORD_CONTEXT' })
    await expect(redeem(pending, { ...base, password: 'MapleHouse#2026' })).rejects.toMatchObject({ code: 'PASSWORD_CONTEXT' })
    await expect(redeem(pending, { kind: 'RESET', email: MEMBER.email, code: reset.code, password: 'member-maple-1' })).rejects.toMatchObject({
      code: 'PASSWORD_CONTEXT',
    })
  })

  it('refuses a revoked grant even if its wrap is still in the envelope', async () => {
    const admin = await openAs(pending, OWNER)
    const wrap = admin.grants.find((grant) => grant.id === invite.id)!
    revokeGrant(admin, invite.id)
    admin.grants.push(wrap)
    const tampered = await sealVault(admin)
    expect((tampered.grants ?? []).map((grant) => grant.id)).toContain(invite.id)
    await expect(redeem(tampered, { kind: 'INVITE', email: INVITEE.email, code: invite.code, password: INVITEE.password })).rejects.toMatchObject({
      code: 'INVITE_INVALID',
    })
    const reopened = await openAs(tampered, OWNER)
    expect(reopened.grants.map((grant) => grant.id)).toEqual([reset.id])
    expect(reopened.needsSave).toBe(true)
  })

  it('binds each wrap to its id, kind and email', async () => {
    const moved = { ...pending, grants: pending.grants!.map((grant) => (grant.id === invite.id ? { ...grant, email: 'intruder@maple.test' } : grant)) }
    await expect(redeem(moved, { kind: 'INVITE', email: 'intruder@maple.test', code: invite.code, password: INVITEE.password })).rejects.toMatchObject({
      code: 'INVITE_INVALID',
    })
    const relabelled = { ...pending, grants: pending.grants!.map((grant) => (grant.id === reset.id ? { ...grant, kind: 'INVITE' as const } : grant)) }
    await expect(redeem(relabelled, { kind: 'INVITE', email: MEMBER.email, code: reset.code, password: NEW_PASSWORD })).rejects.toMatchObject({
      code: 'INVITE_INVALID',
    })
  })

  it('refuses a Manager invite whose group was deleted', async () => {
    const admin = await openAs(household.record, OWNER)
    createGroup(admin, 'Annex')
    const annex = listGroups(admin).find((group) => group.name === 'Annex')!.id
    const orphan = await createInvite(admin, { email: 'annex@maple.test', roleName: 'Manager', groupId: annex, validity: '1h' })
    deleteGroup(admin, annex)
    expect(grantRowOf(admin.db, orphan.id)).toMatchObject({ group_id: null, ended_at: null })
    const record = await sealVault(admin)
    await expect(redeem(record, { kind: 'INVITE', email: 'annex@maple.test', code: orphan.code, password: INVITEE.password })).rejects.toMatchObject({
      code: 'GROUP',
    })
  })

  it('clears the sign-in check and restores access after a stop-old-password reset', async () => {
    const member = await openAs(household.record, MEMBER)
    const setup = beginTotpSetup(MEMBER.email)
    const now = Date.now()
    const recovery = await enableTotp(member, MEMBER.password, setup, await totpAt(await importTotpKey(base32Decode(setup.secret)), now), now)
    const withTotp = await sealVault(member)

    const admin = await openAs(withTotp, OWNER)
    const code = await issueReset(admin, household.memberId, { validity: '15m', stopOldPassword: true })
    const issued = await sealVault(admin)
    await expect(unlockVault(issued, MEMBER.email, MEMBER.password)).rejects.toBeInstanceOf(AuthError)

    const restored = await redeem(issued, { kind: 'RESET', email: MEMBER.email, code: code.code, password: NEW_PASSWORD })
    expect(hasSignInCheck(restored.db, household.memberId)).toBe(false)
    expect(Number(restored.db.queryValue('SELECT COUNT(*) FROM user_totp'))).toBe(0)
    const actions = auditActions(restored.db)
    expect(actions.slice(-2)).toEqual(['TOTP_CLEARED', 'RESET_COMPLETED'])
    expect(lastAudit(restored.db, 'TOTP_CLEARED')).toMatchObject({ actorId: household.memberId, entityId: household.memberId, details: { reason: 'PASSWORD_RESET' } })
    expect(restored.wraps.filter((wrap) => wrap.userId === household.memberId)).toHaveLength(1)
    expectNoSecretsStored(restored.db, [code.code, setup.secret, ...recovery, NEW_PASSWORD, MEMBER.password])

    const saved = await sealVault(restored)
    await expect(unlockVault(saved, MEMBER.email, MEMBER.password)).rejects.toBeInstanceOf(AuthError)
    await expect(openAs(saved, MEMBER, NEW_PASSWORD)).resolves.toMatchObject({ user: { id: household.memberId } })
  })
})

describe('sweepGrants', () => {
  it('ends expired grants on unlock with an actorless audit entry', async () => {
    const admin = await openAs(household.record, OWNER)
    const invite = await createInvite(admin, { email: INVITEE.email, roleName: 'Viewer', groupId: household.groupId, validity: '15m' })
    const reset = await issueReset(admin, household.memberId, { validity: '1h', stopOldPassword: false })
    const record = await sealVault(admin)

    const early = await unlockVault(record, OWNER.email, OWNER.password, new Date(Date.now() + 5 * MINUTE))
    track(early)
    expect(early.needsSave).toBe(false)
    expect(early.grants.map((grant) => grant.id).sort()).toEqual([invite.id, reset.id].sort())

    const late = track(await unlockVault(record, OWNER.email, OWNER.password, new Date(Date.parse(invite.expiresAt) + MINUTE)))
    expect(late.needsSave).toBe(true)
    expect(late.grants.map((grant) => grant.id)).toEqual([reset.id])
    expect(grantRowOf(late.db, invite.id)).toMatchObject({ ended_reason: 'EXPIRED', ended_by: null })
    expect(lastAudit(late.db, 'INVITE_EXPIRED')).toEqual({
      actorId: null,
      action: 'INVITE_EXPIRED',
      entityType: 'grant',
      entityId: invite.id,
      details: { kind: 'INVITE', email: INVITEE.email, expiresAt: invite.expiresAt },
    })
    expect(listGrants(late, new Date(Date.parse(invite.expiresAt) + MINUTE)).map((grant) => grant.id)).toEqual([reset.id])
    expect(sweepGrants(late, new Date(Date.parse(invite.expiresAt) + MINUTE))).toBe(0)

    const afterReset = track(await unlockVault(record, OWNER.email, OWNER.password, new Date(Date.parse(reset.expiresAt) + MINUTE)))
    expect(afterReset.grants).toEqual([])
    expect(lastAudit(afterReset.db, 'INVITE_EXPIRED')).toMatchObject({ actorId: null, entityId: reset.id, details: { kind: 'RESET', email: MEMBER.email } })
    expectNoSecretsStored(afterReset.db, [invite.code, reset.code])
  })

  it('ends open rows missing from the envelope and drops envelope wraps without an open row', async () => {
    const admin = await openAs(household.record, OWNER)
    const missing = await createInvite(admin, { email: INVITEE.email, roleName: 'Viewer', groupId: household.groupId, validity: '1h' })
    const stale = await createInvite(admin, { email: 'stale@maple.test', roleName: 'Viewer', groupId: household.groupId, validity: '1h' })
    const kept = await issueReset(admin, household.memberId, { validity: '1h', stopOldPassword: false })
    admin.grants = admin.grants.filter((grant) => grant.id !== missing.id)
    admin.db.withTransaction(() => {
      endGrant(admin.db, stale.id, 'REVOKED', admin.user.id, new Date().toISOString())
    })
    const before = auditRows(admin.db).length

    expect(sweepGrants(admin)).toBe(2)
    expect(admin.grants.map((grant) => grant.id)).toEqual([kept.id])
    expect(grantRowOf(admin.db, missing.id)).toMatchObject({ ended_reason: 'EXPIRED', ended_by: null })
    expect(grantRowOf(admin.db, stale.id)).toMatchObject({ ended_reason: 'REVOKED' })
    expect(auditRows(admin.db).slice(before)).toEqual([
      { actorId: null, action: 'INVITE_EXPIRED', entityType: 'grant', entityId: missing.id, details: { kind: 'INVITE', email: INVITEE.email, expiresAt: missing.expiresAt } },
    ])
    expect(sweepGrants(admin)).toBe(0)
  })
})
