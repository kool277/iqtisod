import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KeysRecord } from '../../src/db/envelope'
import { readVault, writeVault } from '../../src/db/storage'
import { KEYS_RECORD_VERSION } from '../../src/db/versions'
import { AuthError } from '../../src/domain/errors'
import type { OpenVault } from '../../src/domain/types'
import { sealVault, unlockVault } from '../../src/services/auth.service'
import { createInvite, issueReset, redeemGrant, revokeGrant } from '../../src/services/grant.service'
import { listGroups } from '../../src/services/group.service'
import { reactivateUser, suspendUser, updateUser } from '../../src/services/user.service'
import { userStatus } from '../../src/services/user-profile'
import { adoptionOf, checkKeysBackup, takeOutAgain } from '../../src/services/v2/restore'
import { commitSealed, confirmKeysSession, pinFounder, rosterSeen, rosterTailDocs, rotationOf } from '../../src/services/v2/session'
import { createKeysVault } from '../../src/services/v2/vault'
import { memoryStorage } from '../support/memory-storage'

// The smallest Argon2id the readers accept, so the derivations here stay quick.
vi.mock('../../src/crypto/kdf', async (load) => {
  const actual = await load<typeof import('../../src/crypto/kdf')>()
  return { ...actual, ARGON2_DEFAULT: { name: 'Argon2id', m: 19_456, t: 2, p: 1, len: 32, v: 19 } }
})

const FOUNDER = { email: 'founder@restore.test', password: 'founder-restore-password-1' }
const ALICE = { email: 'alice@restore.test', password: 'alice-restore-password-1' }
const BOB = { email: 'bob@restore.test', password: 'bob-restore-password-1' }
const CAROL = { email: 'carol@restore.test', password: 'carol-restore-password-1' }

const open: OpenVault[] = []
function track<T extends OpenVault>(vault: T): T {
  open.push(vault)
  return vault
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
})

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

/** Restores an older backup as the app does once its admin chose so: take out, seal anew, store, adopt. */
async function restoreOver(check: Awaited<ReturnType<typeof checkKeysBackup>>, stamp: string): Promise<KeysRecord> {
  takeOutAgain(check.vault, check.older!.removals ?? [])
  const restored = (await sealVault(check.vault)) as KeysRecord
  const adopt = adoptionOf(check.vault, restored)
  await writeVault(restored, { expectedStamp: stamp })
  adopt()
  return restored
}

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

async function signIn(person: { email: string; password: string }, record?: KeysRecord): Promise<OpenVault> {
  const vault = track(await unlockVault(record ?? (await stored()), person.email, person.password))
  confirmKeysSession(vault)
  return vault
}

/** The founder and Alice and Bob as Viewers, signed into the roster; the stored record then is the backup to restore. */
async function household() {
  const created = await createKeysVault({ ...FOUNDER, displayName: 'Restore Household', currency: 'USD' })
  track(created.vault)
  await writeVault(created.record, { expectedStamp: null })
  commitSealed(created.vault, created.record)
  confirmKeysSession(created.vault)
  let at = created.record.updatedAt
  const [group] = listGroups(created.vault)
  const ids: string[] = []
  for (const person of [ALICE, BOB]) {
    const founder = await signIn(FOUNDER)
    const invite = await createInvite(founder, { email: person.email, roleName: 'Viewer', groupId: group.id, validity: '24h' })
    at = await save(founder, at)
    const member = track(await redeemGrant(await stored(), { kind: 'INVITE', email: person.email, code: invite.code, password: person.password }))
    at = await save(member, at)
    ids.push(invite.id)
  }
  const founder = await signIn(FOUNDER)
  at = await save(founder, at)
  return { founder, at, alice: ids[0], bob: ids[1], group, backup: await stored() }
}

describe('restoring a backup with per-person keys', () => {
  it('signs in to a backup as current as the vault, with every check of a sign-in', async () => {
    const { backup } = await household()
    const check = await checkKeysBackup(backup, FOUNDER.email, FOUNDER.password)
    track(check.vault)
    expect(check.older).toBeNull()
  })

  it('refuses a backup the person cannot sign in to, so they are never locked out by it', async () => {
    const { backup } = await household()
    await expect(checkKeysBackup(backup, FOUNDER.email, 'not-the-password-at-all-1')).rejects.toMatchObject({ code: 'BACKUP_KEYS_PASSWORD' })
    await expect(checkKeysBackup(backup, 'nobody@restore.test', FOUNDER.password)).rejects.toMatchObject({ code: 'BACKUP_KEYS_PASSWORD' })
  })

  it('refuses a backup whose founder is not the one this browser pinned for that vault', async () => {
    const { backup } = await household()
    pinFounder(backup.keys.vaultId, Buffer.alloc(32, 9).toString('base64'))
    await expect(checkKeysBackup(backup, FOUNDER.email, FOUNDER.password)).rejects.toMatchObject({ code: 'KEYS_FOUNDER_MISMATCH' })
  })

  it('names who was removed since an older backup, and takes them out again with a new key', async () => {
    const { founder, at, alice, backup } = await household()
    suspendUser(founder, alice)
    await save(founder, at)
    const current = await stored()
    expect(rosterSeen(current.keys.vaultId)).toBe(current.keys.roster.version)

    const check = await checkKeysBackup(backup, FOUNDER.email, FOUNDER.password)
    track(check.vault)
    expect(check.older).toEqual({ seen: current.keys.roster.version, version: backup.keys.roster.version, removals: [{ id: alice, email: ALICE.email, invite: false }] })
    takeOutAgain(check.vault, check.older!.removals!)
    expect(userStatus(check.vault.db, alice)).toBe('SUSPENDED')
    const restored = (await sealVault(check.vault)) as KeysRecord
    expect(restored.keys.epoch).toBe(backup.keys.epoch + 1)
    expect(restored.keys.identities[alice]).toBeUndefined()
    const adopt = adoptionOf(check.vault, restored)
    await writeVault(restored, { expectedStamp: current.updatedAt })
    adopt()
    expect(rosterSeen(restored.keys.vaultId)).toBe(restored.keys.roster.version)
    // The restored copy opens as the vault now, for everyone but the person removed again.
    await signIn(FOUNDER)
    await signIn(BOB)
    await expect(unlockVault(await stored(), ALICE.email, ALICE.password)).rejects.toMatchObject({ code: 'BAD_CREDENTIALS' })
    const audit = check.vault.db.query("SELECT action FROM audit_logs WHERE action IN ('ROSTER_ROLLBACK_ACCEPTED', 'EPOCH_ROTATED')").map((row) => String(row.action))
    expect(audit).toEqual(['ROSTER_ROLLBACK_ACCEPTED', 'EPOCH_ROTATED'])
  })

  it('cannot tell who left when this browser kept no newer roster versions, or kept edited ones', async () => {
    const { founder, at, alice, backup } = await household()
    suspendUser(founder, alice)
    await save(founder, at)
    const key = `moliya.v2.rosterTail.${backup.keys.vaultId}`
    const kept = localStorage.getItem(key)!
    expect(rosterTailDocs(backup.keys.vaultId).length).toBeGreaterThan(0)

    localStorage.removeItem(key)
    const without = await checkKeysBackup(backup, FOUNDER.email, FOUNDER.password)
    track(without.vault)
    expect(without.older?.removals).toBeNull()

    // A kept version edited in any way no longer verifies, so it names nobody.
    const docs = JSON.parse(kept) as string[]
    const edited = docs.map((text, index) => (index === docs.length - 1 ? text.replace('"role":"Viewer"', '"role":"Manager"') : text))
    expect(edited).not.toEqual(docs)
    localStorage.setItem(key, JSON.stringify(edited))
    const tampered = await checkKeysBackup(backup, FOUNDER.email, FOUNDER.password)
    track(tampered.vault)
    expect(tampered.older?.removals).toBeNull()
  })

  it('takes out again an invite revoked since', async () => {
    const { founder, at, group } = await household()
    const invite = await createInvite(founder, { email: 'carol@restore.test', roleName: 'Viewer', groupId: group.id, validity: '24h' })
    const afterInvite = await save(founder, at)
    const backup = await stored()
    const admin = await signIn(FOUNDER)
    revokeGrant(admin, invite.id)
    await save(admin, afterInvite)
    const check = await checkKeysBackup(backup, FOUNDER.email, FOUNDER.password)
    track(check.vault)
    expect(check.older?.removals).toEqual([{ id: invite.id, email: 'carol@restore.test', invite: true }])
    takeOutAgain(check.vault, check.older!.removals!)
    expect(check.vault.grants).toEqual([])
    const restored = (await sealVault(check.vault)) as KeysRecord
    await expect(redeemGrant(restored, { kind: 'INVITE', email: 'carol@restore.test', code: invite.code, password: 'carol-restore-password-1' })).rejects.toMatchObject({ code: 'INVITE_INVALID' })
  })

  it('takes out again someone who had redeemed an invite in the backup, waiting to be signed in, and was removed since', async () => {
    const { founder, at: start, group } = await household()
    let at = start
    const invite = await createInvite(founder, { email: CAROL.email, roleName: 'Viewer', groupId: group.id, validity: '24h' })
    at = await save(founder, at)
    const carol = track(await redeemGrant(await stored(), { kind: 'INVITE', email: CAROL.email, code: invite.code, password: CAROL.password }))
    at = await save(carol, at)
    // Her binding waits for an admin's save: still invited in this backup's roster, but holding keys in it.
    const backup = await stored()
    expect(backup.keys.dekWraps[invite.id]).toBeDefined()
    const admin = await signIn(FOUNDER)
    at = await save(admin, at)
    suspendUser(admin, invite.id)
    at = await save(admin, at)

    const check = await checkKeysBackup(backup, FOUNDER.email, FOUNDER.password)
    track(check.vault)
    expect(check.older?.removals).toEqual([{ id: invite.id, email: CAROL.email, invite: false }])
    const restored = await restoreOver(check, at)
    expect(restored.keys.epoch).toBe(backup.keys.epoch + 1)
    expect(restored.keys.dekWraps[invite.id]).toBeUndefined()
    await expect(unlockVault(await stored(), CAROL.email, CAROL.password)).rejects.toBeInstanceOf(AuthError)
  })

  it('takes out again someone suspended and reactivated since: the old password the admin meant to stop stays stopped', async () => {
    const { founder, at: start, alice, backup } = await household()
    let at = start
    suspendUser(founder, alice)
    at = await save(founder, at)
    const admin = await signIn(FOUNDER)
    const reset = await reactivateUser(admin, alice, { validity: '24h' })
    at = await save(admin, at)
    const back = track(await redeemGrant(await stored(), { kind: 'RESET', email: ALICE.email, code: reset.code, password: 'alice-new-restore-password-2' }))
    at = await save(back, at)
    await signIn(FOUNDER).then((vault) => save(vault, at)).then((stamp) => (at = stamp))

    const check = await checkKeysBackup(backup, FOUNDER.email, FOUNDER.password)
    track(check.vault)
    // Active again now, but with other keys than in the backup.
    expect(check.older?.removals).toEqual([{ id: alice, email: ALICE.email, invite: false }])
    const restored = await restoreOver(check, at)
    expect(restored.keys.epoch).toBe(backup.keys.epoch + 1)
    await expect(unlockVault(await stored(), ALICE.email, ALICE.password)).rejects.toBeInstanceOf(AuthError)
  })

  it('takes out again someone given a new invite code since, whose ended keys must not come back', async () => {
    const { founder, at: start, alice, group, backup } = await household()
    let at = start
    // A new code ends Alice's keys without a new epoch; she comes back with new ones.
    const reset = await issueReset(founder, alice, { validity: '24h', stopOldPassword: true })
    at = await save(founder, at)
    const back = track(await redeemGrant(await stored(), { kind: 'RESET', email: ALICE.email, code: reset.code, password: 'alice-new-restore-password-2' }))
    at = await save(back, at)
    // An admin's save signs her new keys in, and another change moves this browser past the backup.
    const admin = await signIn(FOUNDER)
    await createInvite(admin, { email: CAROL.email, roleName: 'Viewer', groupId: group.id, validity: '24h' })
    at = await save(admin, at)

    const check = await checkKeysBackup(backup, FOUNDER.email, FOUNDER.password)
    track(check.vault)
    expect(check.older?.removals).toEqual([{ id: alice, email: ALICE.email, invite: false }])
    const restored = await restoreOver(check, at)
    expect(restored.keys.epoch).toBe(backup.keys.epoch + 1)
    await expect(unlockVault(await stored(), ALICE.email, ALICE.password)).rejects.toBeInstanceOf(AuthError)
  })

  it('treats a copy that forked from what this browser saw as older, however high its version numbers go', async () => {
    const { founder, at: start, alice, bob, group, backup } = await household()
    let at = start
    // Bob is made an admin, and keeps his own copy; the founder then suspends him (a new key).
    updateUser(founder, bob, { roleName: 'Admin', groupId: null })
    at = await save(founder, at)
    const bobsCopy = await signIn(BOB)
    const admin = await signIn(FOUNDER)
    suspendUser(admin, bob)
    at = await save(admin, at)
    const seen = rosterSeen(backup.keys.vaultId)
    // On his copy, still an admin there, Bob signs versions past what this browser saw.
    let fork: KeysRecord | null = null
    for (const role of ['Manager', 'Viewer', 'Manager', 'Viewer'] as const) {
      updateUser(bobsCopy, alice, { roleName: role, groupId: group.id })
      fork = (await sealVault(bobsCopy, { full: true })) as KeysRecord
    }
    expect(fork!.keys.roster.version).toBeGreaterThan(seen)

    // A sign-in to it is held back like one to an older copy.
    await expect(unlockVault(fork!, ALICE.email, ALICE.password)).rejects.toMatchObject({ code: 'KEYS_ROSTER_ROLLBACK' })
    // A restore reports it as older, and takes Bob out again.
    const check = await checkKeysBackup(fork!, FOUNDER.email, FOUNDER.password)
    track(check.vault)
    expect(check.older?.removals).toEqual([{ id: bob, email: BOB.email, invite: false }])
    const restored = await restoreOver(check, at)
    expect(restored.keys.epoch).toBe(fork!.keys.epoch + 1)
    await expect(unlockVault(await stored(), BOB.email, BOB.password)).rejects.toBeInstanceOf(AuthError)
  })

  it('cannot tell who left when the kept versions stop short of what this browser saw', async () => {
    const { founder, at: start, alice, bob, backup } = await household()
    let at = start
    const key = `moliya.v2.rosterTail.${backup.keys.vaultId}`
    suspendUser(founder, alice)
    at = await save(founder, at)
    const shorter = localStorage.getItem(key)!
    suspendUser(founder, bob)
    at = await save(founder, at)
    // The newest versions were not kept (storage full), while the mark moved on.
    localStorage.setItem(key, shorter)
    const check = await checkKeysBackup(backup, FOUNDER.email, FOUNDER.password)
    track(check.vault)
    expect(check.older?.removals).toBeNull()
  })

  it('lets only an admin of the backup restore an older copy', async () => {
    const { founder, at, alice, backup } = await household()
    suspendUser(founder, alice)
    await save(founder, at)
    await expect(checkKeysBackup(backup, BOB.email, BOB.password)).rejects.toMatchObject({ code: 'KEYS_ROSTER_ROLLBACK' })
  })
})
