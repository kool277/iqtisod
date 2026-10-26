import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KeysRecord } from '../../src/db/envelope'
import { readVault, readVaultRaw, stampOf, writeVault } from '../../src/db/storage'
import { KEYS_RECORD_VERSION, RECORD_VERSION } from '../../src/db/versions'
import type { OpenVault } from '../../src/domain/types'
import { sealVault, unlockVault } from '../../src/services/auth.service'
import { parseBackup } from '../../src/services/backup.service'
import { listTransactions, loadDashboard } from '../../src/services/finance.service'
import { issueReset, redeemGrant } from '../../src/services/grant.service'
import { getSafeStatus, listSafes, unlockSafes } from '../../src/services/safe.service'
import { listUsers } from '../../src/services/user.service'
import { checkVaultAudit } from '../../src/services/v2/audit-check'
import { commitSealed, confirmKeysSession, rotationOf, type KeysSession } from '../../src/services/v2/session'
import { upgradeToKeys } from '../../src/services/v2/upgrade'
import { readFixture, readManifest } from '../support/fixtures'
import { memoryStorage } from '../support/memory-storage'

vi.mock('../../src/crypto/kdf', async (load) => {
  const actual = await load<typeof import('../../src/crypto/kdf')>()
  return { ...actual, ARGON2_DEFAULT: { name: 'Argon2id', m: 19_456, t: 2, p: 1, len: 32, v: 19 } }
})

const ALL = { start: '0001-01-01', end: '9999-12-31' }
const open: OpenVault[] = []
const track = <T extends OpenVault>(vault: T): T => (open.push(vault), vault)

beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()))

afterEach(async () => {
  for (const vault of open.splice(0)) {
    try {
      vault.db.close()
    } catch {
      // Already closed.
    }
  }
  vi.unstubAllGlobals()
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('moliya')
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
  })
})

async function save(vault: OpenVault, stamp: string | null): Promise<string> {
  const record = await sealVault(vault)
  await writeVault(record, { expectedStamp: stamp, rotation: rotationOf(vault, record) })
  commitSealed(vault, record)
  return record.updatedAt
}

async function stored(): Promise<KeysRecord> {
  const loaded = await readVault()
  if (!loaded || loaded.record.version !== KEYS_RECORD_VERSION) throw new Error('no version 3 record stored')
  return loaded.record
}

async function signIn(person: { email: string; password: string }): Promise<OpenVault & { keys: KeysSession }> {
  const vault = track(await unlockVault(await stored(), person.email, person.password)) as OpenVault & { keys: KeysSession }
  confirmKeysSession(vault)
  return vault
}

const legacy = readManifest()
  .filter((entry) => entry.recordFormat < KEYS_RECORD_VERSION)
  .map(readFixture)

// Design 8.3: the founder upgrade on every vault 1.x ever wrote.
describe.each(legacy.map((fixture) => [fixture.path, fixture] as const))('founder upgrade of golden %s', (_path, fixture) => {
  it('keeps the ledger, lets every member back in with a new code, and its signatures check out', async () => {
    const admin = fixture.expected.users.find((user) => user.role === 'Admin')!
    await writeVault(parseBackup(fixture.text).record, { expectedStamp: null })
    const loaded = (await readVault())!
    const v1 = track(await unlockVault(loaded.record, admin.email, admin.password))
    let at = stampOf(loaded.raw)
    if (v1.needsSave || loaded.sourceVersion < RECORD_VERSION) {
      const sealed = await sealVault(v1)
      await writeVault(sealed, { expectedStamp: at, archive: { reason: 'upgrade', raw: loaded.raw } })
      at = sealed.updatedAt
    }
    const ledger = listTransactions(v1, ALL).length
    const totals = loadDashboard(v1, fixture.expected.totals.range, 'en')
    const raw = await readVaultRaw()
    const { vault, record } = await upgradeToKeys(v1, admin.password)
    track(vault)
    await writeVault(record, { expectedStamp: at, archive: { reason: 'upgrade', raw } })
    commitSealed(vault, record)
    confirmKeysSession(vault)
    at = record.updatedAt

    const founder = await signIn(admin)
    expect(listTransactions(founder, ALL)).toHaveLength(ledger)
    expect(loadDashboard(founder, fixture.expected.totals.range, 'en')).toEqual(totals)
    if (getSafeStatus(founder).initialized) {
      const { keyring } = await unlockSafes(founder, { kind: 'password', password: admin.password })
      expect((await listSafes(founder, keyring)).length).toBeGreaterThan(0)
    }
    expect([...(await checkVaultAudit(founder, { full: true }))!.problems.entries()]).toEqual([])
    at = await save(founder, at)

    for (const person of fixture.expected.users.filter((user) => user.email !== admin.email)) {
      const session = await signIn(admin)
      const target = listUsers(session).find((user) => user.email === person.email)
      if (target?.status !== 'ACTIVE') continue
      // Their 1.x password no longer opens the upgraded vault.
      await expect(unlockVault(await stored(), person.email, person.password)).rejects.toMatchObject({ code: 'BAD_CREDENTIALS' })
      const code = await issueReset(session, target.id, { validity: '24h', stopOldPassword: true })
      at = await save(session, at)
      // The same password where today's policy still takes it, which keeps their 1.x safes opening with it.
      let password = person.password
      let member: OpenVault
      try {
        member = track(await redeemGrant(await stored(), { kind: 'RESET', email: person.email, code: code.code, password }))
      } catch {
        password = `a brand new passphrase for the ${person.role}`
        member = track(await redeemGrant(await stored(), { kind: 'RESET', email: person.email, code: code.code, password }))
      }
      at = await save(member, at)
      const back = await signIn({ email: person.email, password })
      expect(back.user.roleName).toBe(person.role)
      if (getSafeStatus(back).initialized) {
        // A person whose 1.x safes were already waiting after a reset opens them with the password from before it.
        const previous = fixture.expected.safes?.owners.find((owner) => owner.email === person.email)?.previousPassword ?? person.password
        await expect(unlockSafes(back, { kind: 'previousPassword', previous, current: password })).resolves.toBeTruthy()
        at = await save(back, at)
      }
    }
    const final = await signIn(admin)
    at = await save(final, at)
    expect([...(await checkVaultAudit(final, { full: true }))!.problems.entries()]).toEqual([])
  })
})
