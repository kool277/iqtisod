import { afterEach, describe, expect, it } from 'vitest'
import { ForbiddenError } from '../../src/domain/errors'
import type { OpenVault } from '../../src/domain/types'
import { Permission, canUser, seesAllGroups } from '../../src/rbac'
import { changeOwnPassword } from '../../src/services/account.service'
import { auditIntegrity } from '../../src/services/audit-log'
import { sealVault } from '../../src/services/auth.service'
import { listTransactions, scope } from '../../src/services/finance.service'
import { listGroups } from '../../src/services/group.service'
import { createUser, listUsers, resetUserPassword } from '../../src/services/user.service'
import { MANAGER, MEMBER, NEW_PASSWORD, OWNER, buildAccessHousehold, openAs, settlePassword } from '../support/access'
import { closeTracked } from '../support/safes'

const TEMP = 'Harbour pepper violet 23'
const RANGE = { start: '2000-01-01', end: '2100-12-31' }

afterEach(closeTracked)

async function forced(who: typeof OWNER | typeof MEMBER): Promise<OpenVault> {
  const household = await buildAccessHousehold()
  const resetter = await openAs(household.record, who === OWNER ? MANAGER : OWNER)
  if (who === OWNER) {
    // Only an Admin can reset; promote a second Admin to reset the owner.
    const admin = await openAs(household.record, OWNER)
    await createUser(admin, { email: 'second.admin@maple.test', password: 'Second admin lighthouse 9', roleName: 'Admin', groupId: null })
    const second = settlePassword(await openAs(await sealVault(admin), { email: 'second.admin@maple.test', password: 'Second admin lighthouse 9' }))
    await resetUserPassword(second, second.wraps.find((wrap) => wrap.email === OWNER.email)!.userId, TEMP)
    return openAs(await sealVault(second), OWNER, TEMP)
  }
  await resetUserPassword(resetter, resetter.wraps.find((wrap) => wrap.email === who.email)!.userId, TEMP)
  return openAs(await sealVault(resetter), who, TEMP)
}

describe('a pending forced password change', () => {
  it('refuses finance services until the password is changed', async () => {
    const vault = await forced(MEMBER)
    expect(vault.user.mustChangePassword).toBe(true)
    expect(() => listTransactions(vault, RANGE)).toThrow(ForbiddenError)
    expect(() => listUsers(vault)).toThrow(ForbiddenError)
    await changeOwnPassword(vault, TEMP, NEW_PASSWORD)
    expect(listTransactions(vault, RANGE)).toEqual([])
    expect(listUsers(vault).length).toBeGreaterThan(0)
  })

  it('refuses admin services until the password is changed', async () => {
    const vault = await forced(OWNER)
    expect(vault.user.mustChangePassword).toBe(true)
    expect(canUser(vault.user, Permission.MANAGE_USERS)).toBe(false)
    expect(() => listUsers(vault)).toThrow(ForbiddenError)
    expect(() => auditIntegrity(vault)).toThrow(ForbiddenError)
    await expect(createUser(vault, { email: 'late@maple.test', password: 'Late lantern harbour 5', roleName: 'Viewer', groupId: listGroups(vault)[0]?.id ?? null })).rejects.toThrow(ForbiddenError)
    await changeOwnPassword(vault, TEMP, NEW_PASSWORD)
    expect(canUser(vault.user, Permission.MANAGE_USERS)).toBe(true)
    expect(() => auditIntegrity(vault)).not.toThrow()
  })
})

describe('role checks come from permissions', () => {
  it('scopes to every group only with the group-management permission, whatever the role is called', () => {
    const admin = { roleName: 'Viewer', groupId: 7, permissions: [Permission.MANAGE_GROUPS, Permission.READ_TRANSACTIONS], mustChangePassword: false }
    const renamed = { roleName: 'Admin', groupId: 7, permissions: [Permission.READ_TRANSACTIONS], mustChangePassword: false }
    expect(seesAllGroups(admin)).toBe(true)
    expect(scope(admin as never).sql).toBe('1 = 1')
    expect(scope(renamed as never)).toEqual({ sql: 't.group_id = ?', params: [7] })
  })

  it('shows who has a sign-in check only to people managers', async () => {
    const household = await buildAccessHousehold()
    const manager = settlePassword(await openAs(household.record, MANAGER))
    const owner = await openAs(household.record, OWNER)
    for (const vault of [manager, owner]) {
      vault.db.exec(
        `INSERT INTO user_totp (user_id, enc_version, kdf, kdf_salt, secret_iv, secret_ciphertext, last_step, recovery_salt, recovery_hashes, created_at, rewrapped_at)
         VALUES (?, 1, 'x', 'x', 'x', 'x', 0, 'x', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        [household.memberId],
      )
    }
    const checkOf = (vault: OpenVault) => listUsers(vault).find((person) => person.email === MEMBER.email)?.signInCheck
    expect(checkOf(owner)).toBe(true)
    expect(checkOf(manager)).toBe(false)
  })
})
