import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { getSetting } from '../../src/db/settings'
import { AuthError, ForbiddenError } from '../../src/domain/errors'
import { CLOCK_STEP_MAX_MS, deviceClockFloor, observeClock, resetDeviceClock } from '../../src/lib/device-clock'
import { sealVault, unlockVault } from '../../src/services/auth.service'
import { createInvite, issueReset, readClockFloor, redeemGrant, resetClockFloor } from '../../src/services/grant.service'
import { CLOCK_KEY, pruneExpiredGrants } from '../../src/services/grant-store'
import { buildAccessHousehold, INVITEE, MEMBER, MINUTE, OWNER, lastAudit } from '../support/access'
import { closeTracked, track } from '../support/safes'

afterEach(() => {
  vi.useRealTimers()
  closeTracked()
  resetDeviceClock()
})
afterAll(() => closeTracked())

async function code(fn: () => unknown): Promise<string> {
  try {
    await fn()
    return 'OK'
  } catch (error) {
    return (error as { code?: string }).code ?? String(error)
  }
}

describe('expired codes stay expired when the clock is turned back', () => {
  it('a later attempt makes a rolled-back attempt fail (pentest PoC: revived 15-minute Admin invite)', async () => {
    const { record } = await buildAccessHousehold()
    const issuedAt = new Date(Date.now() + 60 * MINUTE)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(issuedAt)
    const admin = track(await unlockVault(record, OWNER.email, OWNER.password, issuedAt))
    const invite = await createInvite(admin, { email: INVITEE.email, roleName: 'Admin', groupId: null, validity: '15m' }, issuedAt)
    const saved = await sealVault(admin)
    vi.useRealTimers()
    const input = { kind: 'INVITE' as const, email: INVITEE.email, code: invite.code, password: INVITEE.password }
    expect(await code(() => redeemGrant(saved, input, new Date(issuedAt.getTime() + 120 * MINUTE)))).toBe('INVITE_EXPIRED')
    expect(await code(() => redeemGrant(saved, input, new Date(issuedAt.getTime() + 5 * MINUTE)))).toBe('CLOCK_BEHIND')
  })

  it('a browser that has seen the real time refuses the rolled-back clock even on the first attempt', async () => {
    const { record } = await buildAccessHousehold()
    const admin = track(await unlockVault(record, OWNER.email, OWNER.password))
    const issued = await createInvite(admin, { email: INVITEE.email, roleName: 'Admin', groupId: null, validity: '15m' })
    const saved = await sealVault(admin)
    observeClock(Date.now() + 30 * MINUTE)
    const input = { kind: 'INVITE' as const, email: INVITEE.email, code: issued.code, password: INVITEE.password }
    expect(await code(() => redeemGrant(saved, input, new Date(Date.now() + 5 * MINUTE)))).toBe('CLOCK_BEHIND')
  })

  it('expired codes are removed from the stored record at load, without the key', async () => {
    const { record, memberId } = await buildAccessHousehold()
    const admin = track(await unlockVault(record, OWNER.email, OWNER.password))
    const invite = await createInvite(admin, { email: INVITEE.email, roleName: 'Admin', groupId: null, validity: '15m' })
    const reset = await issueReset(admin, memberId, { validity: '24h', stopOldPassword: false })
    const saved = await sealVault(admin)
    expect(saved.grants?.map((grant) => grant.expiresAt)).toEqual([invite.expiresAt, reset.expiresAt])
    expect(pruneExpiredGrants(saved, Date.now())).toBeNull()
    const pruned = pruneExpiredGrants(saved, Date.parse(invite.expiresAt))!
    expect(pruned.grants?.map((grant) => grant.id)).toEqual([reset.id])
    expect(pruned.body).toEqual(saved.body)
    expect(pruneExpiredGrants(saved, Date.parse(reset.expiresAt))!.grants).toBeUndefined()
    const input = { kind: 'INVITE' as const, email: INVITEE.email, code: invite.code, password: INVITEE.password }
    expect(await code(() => redeemGrant(pruned, input))).toBe('INVITE_INVALID')
  })

  it('the plain-text expiry is bound to the wrap: changing or removing it breaks the code', async () => {
    const { record, groupId } = await buildAccessHousehold()
    const admin = track(await unlockVault(record, OWNER.email, OWNER.password))
    const invite = await createInvite(admin, { email: INVITEE.email, roleName: 'Viewer', groupId, validity: '15m' })
    const saved = await sealVault(admin)
    const later = structuredClone(saved)
    later.grants![0].expiresAt = new Date(Date.parse(invite.expiresAt) + 7 * 24 * 60 * MINUTE).toISOString()
    const stripped = structuredClone(saved)
    delete stripped.grants![0].expiresAt
    const input = { kind: 'INVITE' as const, email: INVITEE.email, code: invite.code, password: INVITEE.password }
    expect(await code(() => redeemGrant(later, input))).toBe('INVITE_INVALID')
    expect(await code(() => redeemGrant(stripped, input))).toBe('INVITE_INVALID')
    expect(await code(() => redeemGrant(saved, input).then(track))).toBe('OK')
  })
})

describe('a far-future clock cannot block codes for long, and an Admin can reset it', () => {
  it('one save under a 2099 clock raises the marks by at most one step', async () => {
    const { record, memberId } = await buildAccessHousehold()
    const member = track(await unlockVault(record, MEMBER.email, MEMBER.password))
    const before = Date.now()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2099-01-01T00:00:00Z'))
    const poisoned = await sealVault(member)
    vi.useRealTimers()
    const admin = track(await unlockVault(poisoned, OWNER.email, OWNER.password))
    const vaultMark = Date.parse(getSetting(admin.db, CLOCK_KEY)!)
    expect(vaultMark).toBeLessThanOrEqual(before + CLOCK_STEP_MAX_MS + MINUTE)
    expect(deviceClockFloor()!).toBeLessThanOrEqual(before + CLOCK_STEP_MAX_MS + MINUTE)
    expect(await code(() => issueReset(admin, memberId, { validity: '24h', stopOldPassword: false }))).toBe('CLOCK_BEHIND')

    expect(await code(() => resetClockFloor(admin, MEMBER.password))).toBe(new AuthError().code)
    await resetClockFloor(admin, OWNER.password)
    expect(readClockFloor(admin).vault! <= new Date().toISOString()).toBe(true)
    expect(lastAudit(admin.db, 'CLOCK_FLOOR_RESET')).toMatchObject({ actorId: admin.user.id, entityType: 'vault' })
    expect(await code(() => issueReset(admin, memberId, { validity: '24h', stopOldPassword: false }))).toBe('OK')
  })

  it('only an Admin can read or reset the clock floor', async () => {
    const { record } = await buildAccessHousehold()
    const member = track(await unlockVault(record, MEMBER.email, MEMBER.password))
    await expect(resetClockFloor(member, MEMBER.password)).rejects.toBeInstanceOf(ForbiddenError)
    expect(() => readClockFloor(member)).toThrow(ForbiddenError)
  })
})
