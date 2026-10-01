import { afterAll, describe, expect, it } from 'vitest'
import { WRAP_AAD_V1 } from '../../src/crypto/crypto.service'
import { decodeStoredRecord, encodeStoredRecord, parseBackupJson, toBackupJson, type VaultRecord } from '../../src/db/envelope'
import { AuthError, CorruptRecordError } from '../../src/domain/errors'
import { sealVault, unlockVault } from '../../src/services/auth.service'
import { buildAccessHousehold, MEMBER, OWNER } from '../support/access'
import { closeTracked, track } from '../support/safes'

afterAll(() => closeTracked())

function relabel(record: VaultRecord, change: (mine: VaultRecord['wraps'][number], target: VaultRecord['wraps'][number]) => void): VaultRecord {
  const tampered = structuredClone(record)
  const mine = tampered.wraps.find((wrap) => wrap.email === MEMBER.email)!
  const target = tampered.wraps.find((wrap) => wrap.email === OWNER.email)!
  change(mine, target)
  tampered.wraps = [mine, ...tampered.wraps.filter((wrap) => wrap !== mine && wrap !== target)]
  return tampered
}

describe('wrap labels are bound to their person', () => {
  it('new wraps carry the AAD flag', async () => {
    const { record } = await buildAccessHousehold()
    expect(record.wraps.every((wrap) => wrap.aad === WRAP_AAD_V1)).toBe(true)
  })

  it('a Viewer who relabels their wrap with the Admin email cannot sign in as the Admin', async () => {
    const { record } = await buildAccessHousehold()
    const tampered = relabel(record, (mine, target) => (mine.email = target.email))
    await expect(unlockVault(tampered, OWNER.email, MEMBER.password)).rejects.toBeInstanceOf(AuthError)
  })

  it('relabelling both userId and email fails for bound and for legacy (unbound) wraps', async () => {
    const { record } = await buildAccessHousehold()
    const bound = relabel(record, (mine, target) => {
      mine.email = target.email
      mine.userId = target.userId
    })
    await expect(unlockVault(bound, OWNER.email, MEMBER.password)).rejects.toBeInstanceOf(AuthError)

    // Without the flag the wrap no longer unwraps, so stripping it is not a way around the binding.
    const stripped = structuredClone(record)
    delete stripped.wraps.find((wrap) => wrap.email === MEMBER.email)!.aad
    await expect(unlockVault(stripped, MEMBER.email, MEMBER.password)).rejects.toBeInstanceOf(AuthError)
  })

  it('a legacy-style relabel is refused by the salt and check value, and the Admin keeps access', async () => {
    const { record } = await buildAccessHousehold()
    const admin = track(await unlockVault(record, OWNER.email, OWNER.password))
    const hashBefore = admin.db.queryValue('SELECT password_hash FROM users WHERE email = ?', [OWNER.email])
    const tampered = relabel(record, (mine, target) => {
      mine.email = target.email
      mine.userId = target.userId
      delete mine.aad
    })
    await expect(unlockVault(tampered, OWNER.email, MEMBER.password)).rejects.toBeInstanceOf(AuthError)
    const again = track(await unlockVault(record, OWNER.email, OWNER.password))
    expect(again.db.queryValue('SELECT password_hash FROM users WHERE email = ?', [OWNER.email])).toBe(hashBefore)
  })

  it('duplicate userId or email in wraps or grants is refused when reading', async () => {
    const { record } = await buildAccessHousehold()
    const stored = encodeStoredRecord(record)
    const dupEmail = { ...stored, wraps: [stored.wraps[0], { ...stored.wraps[1], email: stored.wraps[0].email.toUpperCase() }] }
    const dupUser = { ...stored, wraps: [stored.wraps[0], { ...stored.wraps[1], userId: stored.wraps[0].userId }] }
    expect(() => decodeStoredRecord(dupEmail)).toThrow(CorruptRecordError)
    expect(() => decodeStoredRecord(dupUser)).toThrow(CorruptRecordError)
    const backup = JSON.parse(JSON.stringify(toBackupJson(record, '2026-10-01T00:00:00.000Z'))) as Record<string, any>
    backup.wraps[1].email = backup.wraps[0].email
    expect(() => parseBackupJson(backup)).toThrow(expect.objectContaining({ code: 'BACKUP' }))
  })

  it('a session with duplicate wraps cannot be sealed', async () => {
    const { record } = await buildAccessHousehold()
    const admin = track(await unlockVault(record, OWNER.email, OWNER.password))
    admin.wraps.push({ ...admin.wraps[0], userId: crypto.randomUUID() })
    await expect(sealVault(admin)).rejects.toBeInstanceOf(CorruptRecordError)
  })
})
