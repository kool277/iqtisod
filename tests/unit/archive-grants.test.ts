import { describe, expect, it } from 'vitest'
import { encodeStoredRecord } from '../../src/db/envelope'
import { withoutGrants } from '../../src/db/storage'
import { sealVault, unlockVault } from '../../src/services/auth.service'
import { createInvite } from '../../src/services/grant.service'
import { buildAccessHousehold, INVITEE, OWNER } from '../support/access'
import { closeTracked, track } from '../support/safes'

describe('archives never keep one-time code wraps', () => {
  it('removes grants and leaves everything else as it was', async () => {
    const { record, groupId } = await buildAccessHousehold()
    const admin = track(await unlockVault(record, OWNER.email, OWNER.password))
    await createInvite(admin, { email: INVITEE.email, roleName: 'Viewer', groupId, validity: '24h' })
    const stored = encodeStoredRecord(await sealVault(admin))
    expect(stored.grants).toHaveLength(1)
    const archived = withoutGrants(stored) as Record<string, unknown>
    expect('grants' in archived).toBe(false)
    const { grants: _grants, ...rest } = stored
    expect(archived).toEqual(rest)
    expect(withoutGrants(rest)).toBe(rest)
    expect(withoutGrants(null)).toBeNull()
    closeTracked()
  })
})
