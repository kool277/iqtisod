import { afterAll, describe, expect, it } from 'vitest'
import type { OpenVault } from '../../src/domain/types'
import { LIMITS } from '../../src/lib/limits'
import { sealVault, unlockVault } from '../../src/services/auth.service'
import { createInvite, issueReset, redeemGrant } from '../../src/services/grant.service'
import { createUser } from '../../src/services/user.service'
import { buildAccessHousehold, MEMBER, NEW_PASSWORD, OWNER } from '../support/access'
import { closeTracked, track } from '../support/safes'

afterAll(() => closeTracked())

const FILLER = 'Lemon tractor violet 55'

function padWraps(vault: OpenVault, total: number): void {
  const template = vault.wraps[0]
  for (let index = vault.wraps.length; index < total; index += 1) {
    vault.wraps.push({ ...template, userId: crypto.randomUUID(), email: `stand-in-${index}@limit.test` })
  }
}

async function code(fn: () => unknown): Promise<string> {
  try {
    await fn()
    return 'OK'
  } catch (error) {
    return (error as { code?: string }).code ?? String(error)
  }
}

describe('member limit with open resets', () => {
  it('a reset that stopped the old password keeps its slot reserved', async () => {
    const { record, groupId, memberId } = await buildAccessHousehold()
    const admin = track(await unlockVault(record, OWNER.email, OWNER.password))
    padWraps(admin, LIMITS.wraps)
    await issueReset(admin, memberId, { validity: '24h', stopOldPassword: true })
    expect(admin.wraps).toHaveLength(LIMITS.wraps - 1)
    expect(await code(() => createUser(admin, { email: 'filler@limit.test', password: FILLER, roleName: 'Viewer', groupId }))).toBe('MEMBER_LIMIT')
    expect(await code(() => createInvite(admin, { email: 'invitee@limit.test', roleName: 'Viewer', groupId, validity: '24h' }))).toBe('MEMBER_LIMIT')
  })

  it('redeeming a reset checks the limit, so the stored record never exceeds it', async () => {
    const { record, memberId } = await buildAccessHousehold()
    const admin = track(await unlockVault(record, OWNER.email, OWNER.password))
    const reset = await issueReset(admin, memberId, { validity: '24h', stopOldPassword: true })
    // An envelope filled by an older version that did not reserve the slot.
    padWraps(admin, LIMITS.wraps)
    const full = await sealVault(admin)
    expect(await code(() => redeemGrant(full, { kind: 'RESET', email: MEMBER.email, code: reset.code, password: NEW_PASSWORD }))).toBe('MEMBER_LIMIT')
  })

  it('a session over the limit cannot be sealed', async () => {
    const { record } = await buildAccessHousehold()
    const admin = track(await unlockVault(record, OWNER.email, OWNER.password))
    padWraps(admin, LIMITS.wraps + 1)
    expect(await code(() => sealVault(admin))).toBe('MEMBER_LIMIT')
  })
})
