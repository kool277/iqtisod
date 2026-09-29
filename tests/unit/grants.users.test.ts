import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { decodeStoredRecord } from '../../src/db/envelope'
import { readSchemaVersion, migrate } from '../../src/db/migrations'
import { SqlDatabase } from '../../src/db/sqlite'
import { AuthError, ForbiddenError, ValidationError } from '../../src/domain/errors'
import type { OpenVault } from '../../src/domain/types'
import { LIMITS } from '../../src/lib/limits'
import { base32Decode, importTotpKey, totpAt } from '../../src/lib/totp'
import { sealVault, unlockVault } from '../../src/services/auth.service'
import { backupFileText, parseBackup } from '../../src/services/backup.service'
import { exportPlainDatabase } from '../../src/services/export.service'
import { createInvite, issueReset, listGrants, redeemGrant } from '../../src/services/grant.service'
import { beginTotpSetup, enableTotp, hasSignInCheck } from '../../src/services/totp.service'
import { createUser, deleteUser, listUsers, resetUserPassword } from '../../src/services/user.service'
import {
  INVITEE,
  MANAGER,
  MEMBER,
  NEW_PASSWORD,
  OWNER,
  auditActions,
  auditRows,
  buildAccessHousehold,
  expectNoSecretsStored,
  grantRowOf,
  lastAudit,
  openAs,
  userId,
  type Household,
} from '../support/access'
import { fixtureByPath } from '../support/fixtures'
import { closeTracked, contains, track, utf8 } from '../support/safes'

const TEMP_PASSWORD = 'Granite lighthouse ember 64'

let household: Household

beforeAll(async () => {
  household = await buildAccessHousehold()
  closeTracked()
})

afterEach(closeTracked)

async function withMemberTotp(): Promise<{ record: Awaited<ReturnType<typeof sealVault>>; secret: string; recovery: string[] }> {
  const member = await openAs(household.record, MEMBER)
  const setup = beginTotpSetup(MEMBER.email)
  const now = Date.now()
  const recovery = await enableTotp(member, MEMBER.password, setup, await totpAt(await importTotpKey(base32Decode(setup.secret)), now), now)
  return { record: await sealVault(member), secret: setup.secret, recovery }
}

function redeem(...args: Parameters<typeof redeemGrant>): Promise<OpenVault> {
  return redeemGrant(...args).then(track)
}

describe('createUser with an open invite', () => {
  it('replaces the invite for the same email and leaves others alone', async () => {
    const admin = await openAs(household.record, OWNER)
    const invite = await createInvite(admin, { email: INVITEE.email, roleName: 'Manager', groupId: household.groupId, validity: '24h' })
    const other = await createInvite(admin, { email: 'other@maple.test', roleName: 'Viewer', groupId: household.groupId, validity: '24h' })

    await expect(createUser(admin, { email: INVITEE.email, password: 'aaaaaaaaaaaa', roleName: 'Viewer', groupId: household.groupId })).rejects.toMatchObject({
      code: 'PASSWORD_COMMON',
    })
    expect(grantRowOf(admin.db, invite.id)).toMatchObject({ ended_at: null })

    const before = auditRows(admin.db).length
    await createUser(admin, { email: INVITEE.email.toUpperCase(), password: TEMP_PASSWORD, roleName: 'Viewer', groupId: household.groupId })
    const created = userId(admin.db, INVITEE.email)
    expect(grantRowOf(admin.db, invite.id)).toMatchObject({ ended_reason: 'REPLACED', ended_by: admin.user.id })
    expect(auditRows(admin.db).slice(before)).toEqual([
      { actorId: admin.user.id, action: 'INVITE_REVOKED', entityType: 'grant', entityId: invite.id, details: { email: INVITEE.email, reason: 'REPLACED' } },
      { actorId: admin.user.id, action: 'USER_CREATED', entityType: 'user', entityId: created, details: { email: INVITEE.email, role: 'Viewer', groupId: household.groupId } },
    ])
    expect(admin.grants.map((grant) => grant.id)).toEqual([other.id])
    expect(listGrants(admin).map((grant) => grant.id)).toEqual([other.id])
    expectNoSecretsStored(admin.db, [invite.code, other.code, TEMP_PASSWORD])

    const record = await sealVault(admin)
    await expect(redeem(record, { kind: 'INVITE', email: INVITEE.email, code: invite.code, password: INVITEE.password })).rejects.toMatchObject({
      code: 'INVITE_INVALID',
    })
    const newcomer = await openAs(record, INVITEE, TEMP_PASSWORD)
    expect(newcomer.user).toMatchObject({ roleName: 'Viewer', mustChangePassword: true })
    expect(newcomer.grants.map((grant) => grant.id)).toEqual([other.id])
  })
})

describe('resetUserPassword', () => {
  it('clears the sign-in check, ends open reset codes and restores a stopped wrap', async () => {
    const { record: withTotp, secret, recovery } = await withMemberTotp()
    const admin = await openAs(withTotp, OWNER)
    const invite = await createInvite(admin, { email: INVITEE.email, roleName: 'Viewer', groupId: household.groupId, validity: '24h' })
    const reset = await issueReset(admin, household.memberId, { validity: '24h', stopOldPassword: true })
    expect(admin.wraps.some((wrap) => wrap.userId === household.memberId)).toBe(false)

    await expect(resetUserPassword(admin, admin.user.id, TEMP_PASSWORD)).rejects.toMatchObject({ code: 'USE_ACCOUNT' })
    const manager = await openAs(withTotp, MANAGER)
    await expect(resetUserPassword(manager, household.memberId, TEMP_PASSWORD)).rejects.toBeInstanceOf(ForbiddenError)

    const before = auditRows(admin.db).length
    await resetUserPassword(admin, household.memberId, TEMP_PASSWORD)
    expect(auditRows(admin.db).slice(before)).toEqual([
      { actorId: admin.user.id, action: 'USER_PASSWORD_RESET', entityType: 'user', entityId: household.memberId, details: { email: MEMBER.email } },
      { actorId: admin.user.id, action: 'TOTP_CLEARED', entityType: 'user', entityId: household.memberId, details: { reason: 'PASSWORD_RESET' } },
      { actorId: admin.user.id, action: 'RESET_REVOKED', entityType: 'grant', entityId: reset.id, details: { email: MEMBER.email, reason: 'REPLACED' } },
    ])
    expect(hasSignInCheck(admin.db, household.memberId)).toBe(false)
    expect(grantRowOf(admin.db, reset.id)).toMatchObject({ ended_reason: 'REPLACED', ended_by: admin.user.id })
    expect(grantRowOf(admin.db, invite.id)).toMatchObject({ ended_at: null })
    expect(admin.grants.map((grant) => grant.id)).toEqual([invite.id])
    expect(admin.wraps.filter((wrap) => wrap.userId === household.memberId)).toHaveLength(1)
    expect(Number(admin.db.queryValue('SELECT must_change_password FROM users WHERE id = ?', [household.memberId]))).toBe(1)
    expectNoSecretsStored(admin.db, [secret, ...recovery, reset.code, invite.code, TEMP_PASSWORD, MEMBER.password])

    const record = await sealVault(admin)
    await expect(unlockVault(record, MEMBER.email, MEMBER.password)).rejects.toBeInstanceOf(AuthError)
    const member = await openAs(record, MEMBER, TEMP_PASSWORD)
    expect(member.user.mustChangePassword).toBe(true)
    expect(hasSignInCheck(member.db, member.user.id)).toBe(false)
    await expect(redeem(record, { kind: 'RESET', email: MEMBER.email, code: reset.code, password: NEW_PASSWORD })).rejects.toMatchObject({
      code: 'INVITE_INVALID',
    })
  })
})

describe('deleteUser', () => {
  it('drops the deleted member\'s reset codes and sign-in check', async () => {
    const { record: withTotp, secret, recovery } = await withMemberTotp()
    const admin = await openAs(withTotp, OWNER)
    const reset = await issueReset(admin, household.memberId, { validity: '24h', stopOldPassword: false })
    const invite = await createInvite(admin, { email: INVITEE.email, roleName: 'Viewer', groupId: household.groupId, validity: '24h' })

    deleteUser(admin, household.memberId)
    expect(admin.grants.map((grant) => grant.id)).toEqual([invite.id])
    expect(admin.wraps.some((wrap) => wrap.userId === household.memberId)).toBe(false)
    expect(grantRowOf(admin.db, reset.id)).toBeNull()
    expect(Number(admin.db.queryValue('SELECT COUNT(*) FROM user_totp WHERE user_id = ?', [household.memberId]))).toBe(0)
    expect(listGrants(admin).map((grant) => grant.id)).toEqual([invite.id])
    expect(admin.db.query('PRAGMA foreign_key_check')).toEqual([])
    expectNoSecretsStored(admin.db, [secret, ...recovery, reset.code, invite.code, MEMBER.password])

    const record = await sealVault(admin)
    expect((record.grants ?? []).map((grant) => grant.id)).toEqual([invite.id])
    await expect(redeem(record, { kind: 'RESET', email: MEMBER.email, code: reset.code, password: NEW_PASSWORD })).rejects.toMatchObject({
      code: 'INVITE_INVALID',
    })
    const reopened = await openAs(record, OWNER)
    expect(reopened.needsSave).toBe(false)
    expect(listUsers(reopened).map((user) => user.email)).not.toContain(MEMBER.email)
  })

  it('keeps an invite valid after the admin who issued it is deleted', async () => {
    const admin = await openAs(household.record, OWNER)
    const second = { email: 'deputy@maple.test', password: 'Walnut cabinet rhythm 23' }
    await createUser(admin, { email: second.email, password: second.password, roleName: 'Admin', groupId: null })
    const deputy = await openAs(await sealVault(admin), second)
    const invite = await createInvite(deputy, { email: INVITEE.email, roleName: 'Viewer', groupId: household.groupId, validity: '24h' })
    const owner = await openAs(await sealVault(deputy), OWNER)

    deleteUser(owner, deputy.user.id)
    expect(grantRowOf(owner.db, invite.id)).toMatchObject({ created_by: null, ended_at: null })
    expect(owner.grants.map((grant) => grant.id)).toEqual([invite.id])
    const joined = await redeem(await sealVault(owner), { kind: 'INVITE', email: INVITEE.email, code: invite.code, password: INVITEE.password })
    expect(joined.user).toMatchObject({ email: INVITEE.email, roleName: 'Viewer' })
    expect(auditActions(joined.db).slice(-2)).toEqual(['USER_DELETED', 'INVITE_ACCEPTED'])
    expect(lastAudit(joined.db, 'INVITE_ACCEPTED')).toMatchObject({ actorId: joined.user.id, entityId: invite.id })
  })
})

describe('plaintext database export', () => {
  it('strips sign-in check secrets and grant verifiers from the copy only', async () => {
    const { record: withTotp } = await withMemberTotp()
    const admin = await openAs(withTotp, OWNER)
    const invite = await createInvite(admin, { email: INVITEE.email, roleName: 'Viewer', groupId: household.groupId, validity: '1h' })
    const verifier = String(grantRowOf(admin.db, invite.id)!.code_verifier)
    const ciphertext = String(admin.db.queryValue('SELECT secret_ciphertext FROM user_totp'))

    const bytes = await exportPlainDatabase(admin)
    expect(contains(bytes, utf8(verifier))).toBe(false)
    expect(contains(bytes, utf8(ciphertext.slice(0, 40)))).toBe(false)
    const copy = await SqlDatabase.openBytes(bytes)
    try {
      expect(copy.queryValue('SELECT COUNT(*) FROM user_totp')).toBe(0)
      expect(copy.query('SELECT email, code_verifier FROM access_grants').map((row) => ({ ...row }))).toEqual([{ email: INVITEE.email, code_verifier: '' }])
    } finally {
      copy.close()
    }
    expect(hasSignInCheck(admin.db, household.memberId)).toBe(true)
    expect(grantRowOf(admin.db, invite.id)!.code_verifier).toBe(verifier)
  })
})

describe('member count limit', () => {
  it('never seals a record with more wraps than the decoder accepts', async () => {
    const admin = await openAs(household.record, OWNER)
    const own = admin.wraps.find((wrap) => wrap.userId === admin.user.id)!
    while (admin.wraps.length < LIMITS.wraps) {
      admin.wraps.push({ ...own, userId: crypto.randomUUID(), email: `ghost${admin.wraps.length}@maple.test` })
    }
    let joined: OpenVault
    try {
      const invite = await createInvite(admin, { email: INVITEE.email, roleName: 'Viewer', groupId: household.groupId, validity: '1h' })
      const full = await sealVault(admin)
      expect(decodeStoredRecord(full).record.wraps).toHaveLength(LIMITS.wraps)
      joined = await redeem(full, { kind: 'INVITE', email: INVITEE.email, code: invite.code, password: INVITEE.password })
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError)
      expect(error).toMatchObject({ code: 'MEMBER_LIMIT' })
      return
    }
    const sealed = await sealVault(joined)
    expect(() => decodeStoredRecord(sealed)).not.toThrow()
    expect(() => parseBackup(backupFileText(sealed))).not.toThrow()
  })
})

describe('schema 3 to 4 upgrade', () => {
  it('adds empty grant and sign-in check tables to a 1.2.0 vault', async () => {
    const fixture = fixtureByPath('v3/safes-household')
    const record = parseBackup(fixture.text).record
    expect(record.schemaVersion).toBe(3)
    expect(record.grants).toBeUndefined()
    const admin = fixture.expected.users.find((user) => user.role === 'Admin')!
    const vault = track(await unlockVault(record, admin.email, admin.password))

    expect(readSchemaVersion(vault.db)).toBe(4)
    expect(vault.needsSave).toBe(true)
    expect(lastAudit(vault.db, 'SCHEMA_MIGRATED')).toMatchObject({ actorId: vault.user.id, details: { from: 3, to: 4 } })
    const names = ['access_grants', 'idx_grants_expiry', 'idx_grants_open_email', 'user_totp']
    const schema = (db: SqlDatabase) =>
      db
        .query(`SELECT type, name, sql FROM sqlite_master WHERE name IN (${names.map(() => '?').join(', ')}) ORDER BY name`, names)
        .map((row) => `${row.type}:${row.name}:${String(row.sql).replace(/\s+/g, ' ')}`)
    const fresh = await SqlDatabase.openEmpty()
    try {
      migrate(fresh, { appVersion: 'test' })
      expect(schema(vault.db)).toHaveLength(4)
      expect(schema(vault.db)).toEqual(schema(fresh))
    } finally {
      fresh.close()
    }
    expect(vault.db.queryValue('SELECT COUNT(*) FROM access_grants')).toBe(0)
    expect(vault.db.queryValue('SELECT COUNT(*) FROM user_totp')).toBe(0)
    expect(vault.grants).toEqual([])
    expect(listGrants(vault)).toEqual([])
    const users = listUsers(vault)
    expect(users).toHaveLength(fixture.expected.users.length)
    expect(users.every((user) => user.signInCheck === false)).toBe(true)

    const sealed = await sealVault(vault)
    expect(sealed.schemaVersion).toBe(4)
    expect(sealed.grants ?? []).toEqual([])
    const invite = await createInvite(vault, { email: 'new@safes.test', roleName: 'Viewer', groupId: users.find((user) => user.groupId !== null)!.groupId, validity: '1h' })
    expect(listGrants(vault).map((grant) => grant.id)).toEqual([invite.id])
  })
})
