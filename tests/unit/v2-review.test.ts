import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openChunkedBody } from '../../src/db/chunks'
import type { KeysRecord, LegacyRecord } from '../../src/db/envelope'
import { readVault, writeVault } from '../../src/db/storage'
import { KEYS_RECORD_VERSION } from '../../src/db/versions'
import type { OpenVault } from '../../src/domain/types'
import { createVault, sealVault, unlockVault } from '../../src/services/auth.service'
import { createInvite, redeemGrant } from '../../src/services/grant.service'
import { listGroups } from '../../src/services/group.service'
import { createUser, suspendUser, updateUser } from '../../src/services/user.service'
import { commitSealed, confirmKeysSession, rosterSeen } from '../../src/services/v2/session'
import { upgradeToKeys } from '../../src/services/v2/upgrade'
import { createKeysVault } from '../../src/services/v2/vault'
import { checkKeysBackup } from '../../src/services/v2/restore'
import { resetSuiteDetectionForTests } from '../../src/crypto/suite'
import { memoryStorage } from '../support/memory-storage'

// The smallest Argon2id the readers accept, so the derivations here stay quick.
vi.mock('../../src/crypto/kdf', async (load) => {
  const actual = await load<typeof import('../../src/crypto/kdf')>()
  return { ...actual, ARGON2_DEFAULT: { name: 'Argon2id', m: 19_456, t: 2, p: 1, len: 32, v: 19 } }
})

const FOUNDER = { email: 'founder@review.test', password: 'founder-review-password-1' }
const SECOND = { email: 'second@review.test', password: 'second-review-password-1' }
const MEMBER = { email: 'member@review.test', password: 'member-review-password-1' }

const open: OpenVault[] = []
function track<T extends OpenVault>(vault: T): T {
  open.push(vault)
  return vault
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
})

afterEach(async () => {
  vi.restoreAllMocks()
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
  await writeVault(record, { expectedStamp: stamp })
  commitSealed(vault, record)
  return record.updatedAt
}

async function stored(): Promise<KeysRecord> {
  const loaded = await readVault()
  if (!loaded || loaded.record.version !== KEYS_RECORD_VERSION) throw new Error('no version 3 record stored')
  return loaded.record
}

async function founded() {
  const created = await createKeysVault({ ...FOUNDER, displayName: 'Review Household', currency: 'USD' })
  track(created.vault)
  await writeVault(created.record, { expectedStamp: null })
  commitSealed(created.vault, created.record)
  confirmKeysSession(created.vault)
  return { founder: created.vault, at: created.record.updatedAt }
}

/** The founder plus a member who redeemed an invite with `role`, folded into the roster by the founder's save. */
async function household(role: 'Admin' | 'Viewer', person = role === 'Admin' ? SECOND : MEMBER) {
  let { founder, at } = await founded()
  const [group] = listGroups(founder)
  const invite = await createInvite(founder, { email: person.email, roleName: role, groupId: role === 'Admin' ? null : group.id, validity: '24h' })
  at = await save(founder, at)
  const member = track(await redeemGrant(await stored(), { kind: 'INVITE', email: person.email, code: invite.code, password: person.password }))
  at = await save(member, at)
  const signedIn = track(await unlockVault(await stored(), FOUNDER.email, FOUNDER.password))
  confirmKeysSession(signedIn)
  at = await save(signedIn, at)
  return { founder: signedIn, at, memberId: invite.id, group }
}

describe('found in review', () => {
  it('an admin who steps down signs that change into the roster, so everyone can still sign in', async () => {
    const { founder, at, group } = await household('Admin')
    const before = (await stored()).keys.roster.version
    updateUser(founder, founder.user.id, { roleName: 'Manager', groupId: group.id })
    expect(founder.user.roleName).toBe('Manager')
    await save(founder, at)
    const after = await stored()
    expect(after.keys.roster.version).toBe(before + 1)
    const second = track(await unlockVault(after, SECOND.email, SECOND.password))
    expect(second.user.roleName).toBe('Admin')
    const stepped = track(await unlockVault(after, FOUNDER.email, FOUNDER.password))
    expect(stepped.user.roleName).toBe('Manager')
    // As a Manager they no longer sign roster versions.
    await save(stepped, after.updatedAt)
    expect((await stored()).keys.roster.version).toBe(after.keys.roster.version)
  })

  it('after the upgrade, the only admin with keys cannot step down, however many admins wait for an invite', async () => {
    const created = await createVault({ ...FOUNDER, displayName: 'Old Review Household', currency: 'USD' })
    const v1 = track(created.vault)
    await createUser(v1, { email: SECOND.email, password: SECOND.password, roleName: 'Admin', groupId: null })
    const sealed = (await sealVault(v1)) as LegacyRecord
    await writeVault(sealed, { expectedStamp: null })
    const { vault } = await upgradeToKeys(v1, FOUNDER.password)
    const [group] = listGroups(vault)
    expect(() => updateUser(vault, vault.user.id, { roleName: 'Manager', groupId: group.id })).toThrow('LAST_ADMIN')
  })

  it('a roster version this browser saves raises its rollback mark, so the older copy is caught', async () => {
    const { founder, at, memberId } = await household('Viewer')
    const beforeRemoval = await stored()
    suspendUser(founder, memberId)
    await save(founder, at)
    const removed = await stored()
    expect(removed.keys.roster.version).toBeGreaterThan(beforeRemoval.keys.roster.version)
    expect(rosterSeen(removed.keys.vaultId)).toBe(removed.keys.roster.version)
    // Only an admin of the copy is offered to open it anyway.
    await expect(unlockVault(beforeRemoval, MEMBER.email, MEMBER.password)).rejects.toMatchObject({ code: 'KEYS_ROSTER_ROLLBACK', admin: false })
  })

  it('a full seal that overlaps a save signing a roster version names only what its own image holds', async () => {
    const { founder, memberId, group } = await household('Viewer')
    const real = crypto.subtle.encrypt.bind(crypto.subtle)
    let gate: Promise<void> | null = null
    let release!: () => void
    vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (...args: Parameters<SubtleCrypto['encrypt']>) => {
      const wait = gate
      if (wait) await wait
      return real(...args)
    })
    gate = new Promise<void>((resolve) => (release = resolve))
    // Like a backup sealed from the open vault after a failed save.
    const exporting = sealVault(founder, { full: true })
    await new Promise((resolve) => setTimeout(resolve, 50))
    gate = null
    // Meanwhile the admin changes a member's role and an autosave signs a new roster version.
    updateUser(founder, memberId, { roleName: 'Manager', groupId: group.id })
    const autosave = (await sealVault(founder)) as KeysRecord
    release()
    const exported = (await exporting) as KeysRecord
    expect(autosave.keys.roster.version).toBe(exported.keys.roster.version + 1)
    const { db } = await openChunkedBody(exported.body, founder.dek, { vaultId: exported.keys.vaultId, epoch: exported.keys.epoch })
    try {
      expect(Number(db.queryValue('SELECT MAX(version) FROM roster_versions'))).toBe(exported.keys.roster.version)
    } finally {
      db.close()
    }
    // Both records open: each header names the roster its own image holds.
    track(await unlockVault(exported, FOUNDER.email, FOUNDER.password))
    track(await unlockVault(autosave, FOUNDER.email, FOUNDER.password))
  })

  it('a browser without X25519 or Ed25519 says so when signing in, redeeming or checking a backup, instead of a wrong password', async () => {
    const { founder, at } = await founded()
    const [group] = listGroups(founder)
    const invite = await createInvite(founder, { email: MEMBER.email, roleName: 'Viewer', groupId: group.id, validity: '24h' })
    await save(founder, at)
    const record = await stored()
    const subtle = globalThis.crypto.subtle
    const importKey = subtle.importKey.bind(subtle)
    const generateKey = subtle.generateKey.bind(subtle)
    const missing = (algorithm: unknown) => ['X25519', 'Ed25519'].includes(typeof algorithm === 'string' ? algorithm : String((algorithm as { name?: unknown }).name))
    const refuse = () => Promise.reject(new DOMException('Unrecognized name', 'NotSupportedError'))
    vi.spyOn(subtle, 'importKey').mockImplementation(((...args: Parameters<SubtleCrypto['importKey']>) =>
      missing(args[2]) ? refuse() : importKey(...args)) as SubtleCrypto['importKey'])
    vi.spyOn(subtle, 'generateKey').mockImplementation(((...args: Parameters<SubtleCrypto['generateKey']>) =>
      missing(args[0]) ? refuse() : generateKey(...args)) as SubtleCrypto['generateKey'])
    resetSuiteDetectionForTests()
    try {
      const unsupported = { code: 'V2_UNSUPPORTED_BROWSER' }
      await expect(unlockVault(record, FOUNDER.email, FOUNDER.password)).rejects.toMatchObject(unsupported)
      await expect(redeemGrant(record, { kind: 'INVITE', email: MEMBER.email, code: invite.code, password: MEMBER.password })).rejects.toMatchObject(unsupported)
      await expect(checkKeysBackup(record, FOUNDER.email, FOUNDER.password)).rejects.toMatchObject(unsupported)
    } finally {
      vi.restoreAllMocks()
      resetSuiteDetectionForTests()
    }
  })
})

