import 'fake-indexeddb/auto'
import { cloneBytes } from '../../src/crypto/encoding'
import { deriveInviteKeys } from '../../src/crypto/invite-crypto'
import { signBinding } from '../../src/crypto/roster'
import { normalizeAccessCode } from '../../src/lib/access-code'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openChunkedBody } from '../../src/db/chunks'
import { decodeStoredRecord, type KeysRecord, type LegacyRecord } from '../../src/db/envelope'
import { listArchives, readArchive, readVault, readVaultRaw, writeVault } from '../../src/db/storage'
import { KEYS_RECORD_VERSION } from '../../src/db/versions'
import { AuthError, ForbiddenError } from '../../src/domain/errors'
import type { OpenVault } from '../../src/domain/types'
import { createVault, sealVault, unlockVault } from '../../src/services/auth.service'
import { createInvite, issueReset, redeemGrant } from '../../src/services/grant.service'
import { listGroups } from '../../src/services/group.service'
import { createUser, deleteUser, reactivateUser, removalEffects, suspendUser, updateUser } from '../../src/services/user.service'
import { readBindings, readRosterDocs, writeBinding } from '../../src/services/v2/roster-store'
import { collectVaultFacts } from '../../src/health/vault'
import { noteExport } from '../../src/services/backup.service'
import { commitSealed, confirmKeysSession, rotationOf } from '../../src/services/v2/session'
import { upgradeToKeys } from '../../src/services/v2/upgrade'
import { createKeysVault, unlockKeysVault } from '../../src/services/v2/vault'
import { memoryStorage } from '../support/memory-storage'

// The smallest Argon2id the readers accept, so the derivations here stay quick.
vi.mock('../../src/crypto/kdf', async (load) => {
  const actual = await load<typeof import('../../src/crypto/kdf')>()
  return { ...actual, ARGON2_DEFAULT: { name: 'Argon2id', m: 19_456, t: 2, p: 1, len: 32, v: 19 } }
})

const FOUNDER = { email: 'founder@rotate.test', password: 'founder-rotate-password-1' }
const ALICE = { email: 'alice@rotate.test', password: 'alice-rotate-password-1' }
const BOB = { email: 'bob@rotate.test', password: 'bob-rotate-password-1' }
const CAROL = { email: 'carol@rotate.test', password: 'carol-rotate-password-1' }

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

/** Saves the way the app's autosave does, archiving the record a new epoch replaces. */
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

/** The founder, plus each person invited as a Viewer, redeemed, and signed into the roster by the founder's save. */
async function household(people: { email: string; password: string }[]) {
  const created = await createKeysVault({ ...FOUNDER, displayName: 'Rotation Household', currency: 'USD' })
  track(created.vault)
  await writeVault(created.record, { expectedStamp: null })
  commitSealed(created.vault, created.record)
  confirmKeysSession(created.vault)
  let at = created.record.updatedAt
  const [group] = listGroups(created.vault)
  const ids: string[] = []
  for (const person of people) {
    const founder = await signIn(FOUNDER)
    const invite = await createInvite(founder, { email: person.email, roleName: 'Viewer', groupId: group.id, validity: '24h' })
    at = await save(founder, at)
    const member = track(await redeemGrant(await stored(), { kind: 'INVITE', email: person.email, code: invite.code, password: person.password }))
    at = await save(member, at)
    ids.push(invite.id)
  }
  const founder = await signIn(FOUNDER)
  at = await save(founder, at)
  return { founder, at, ids, group }
}

/** The audit log as stored, whoever is signed in. */
function audit(vault: OpenVault): { action: string; entityId: string; details: Record<string, unknown> }[] {
  return vault.db
    .query('SELECT action, entity_id, details FROM audit_logs ORDER BY seq')
    .map((row) => ({ action: String(row.action), entityId: String(row.entity_id), details: row.details == null ? {} : (JSON.parse(String(row.details)) as Record<string, unknown>) }))
}

async function epochOfLatestRoster(vault: OpenVault): Promise<number> {
  const docs = await readRosterDocs(vault.db)
  return docs!.at(-1)!.epoch
}

describe('key rotation', () => {
  it('starts a new epoch when someone who held the key leaves: everyone who stays gets the new key, they get none', async () => {
    const { founder, at, ids } = await household([ALICE, BOB])
    const [alice, bob] = ids
    const before = await stored()
    expect(before.keys.epoch).toBe(1)
    const oldDek = founder.dek
    deleteUser(founder, alice)
    // The session moves on at once; the next save wraps the new key.
    expect(founder.keys!.epoch).toBe(2)
    expect(founder.dek).not.toBe(oldDek)
    await save(founder, at)
    const after = await stored()
    expect(after.keys.epoch).toBe(2)
    expect(Object.keys(after.keys.dekWraps).sort()).toEqual([founder.user.id, bob].sort())
    expect(Object.values(after.keys.dekWraps).every((wrap) => wrap.epoch === 2)).toBe(true)
    await expect(openChunkedBody(after.body, oldDek, { vaultId: after.keys.vaultId, epoch: 2 })).rejects.toThrow()
    await expect(openChunkedBody(after.body, oldDek, { vaultId: after.keys.vaultId, epoch: 1 })).rejects.toThrow()
    await expect(unlockVault(after, ALICE.email, ALICE.password)).rejects.toBeInstanceOf(AuthError)
    const signedIn = await signIn(BOB, after)
    expect(signedIn.keys!.epoch).toBe(2)
    expect(await epochOfLatestRoster(signedIn)).toBe(2)
    const latest = (await readRosterDocs(signedIn.db))!.at(-1)!
    expect(latest.members.find((member) => member.id === alice)?.status).toBe('removed')
    const rotated = audit(signedIn).find((entry) => entry.action === 'EPOCH_ROTATED')
    expect(rotated?.details).toMatchObject({ from: 1, to: 2 })
  })

  it('needs no new epoch for someone still waiting for a new invite after the upgrade', async () => {
    const created = await createVault({ ...FOUNDER, displayName: 'Old Household', currency: 'USD' })
    const v1 = track(created.vault)
    const [group] = listGroups(v1)
    const waiting = await createUser(v1, { email: CAROL.email, password: CAROL.password, roleName: 'Viewer', groupId: group.id })
    await writeVault((await sealVault(v1)) as LegacyRecord, { expectedStamp: null })
    const upgraded = await upgradeToKeys(v1, FOUNDER.password)
    await writeVault(upgraded.record, { expectedStamp: (await readVault())!.record.updatedAt, archive: { reason: 'upgrade', raw: await readVaultRaw() } })
    commitSealed(upgraded.vault, upgraded.record)
    // Carol still waits for a new invite after the upgrade: she never had this epoch's key.
    deleteUser(upgraded.vault, waiting)
    expect(upgraded.vault.keys.epoch).toBe(1)
  })

  it('needs no new epoch for a new code for someone who stays, but does once they leave', async () => {
    const { founder, at, ids } = await household([ALICE])
    const reset = await issueReset(founder, ids[0], { validity: '24h', stopOldPassword: true })
    expect(founder.keys!.epoch).toBe(1)
    await save(founder, at)
    expect((await stored()).keys.epoch).toBe(1)
    // She held the key before the new code, so taking her out now does need a new epoch.
    const again = await signIn(FOUNDER)
    expect(again.grants.map((grant) => grant.id)).toEqual([reset.id])
    suspendUser(again, ids[0])
    expect(again.keys!.epoch).toBe(2)
  })

  it('revokes every open code, since each wraps the old key, and a code made afterwards opens the vault', async () => {
    const { founder, ids, group } = await household([ALICE])
    let at = (await stored()).updatedAt
    const pending = await createInvite(founder, { email: BOB.email, roleName: 'Viewer', groupId: group.id, validity: '24h' })
    at = await save(founder, at)
    const admin = await signIn(FOUNDER)
    suspendUser(admin, ids[0])
    expect(admin.grants).toEqual([])
    const fresh = await createInvite(admin, { email: CAROL.email, roleName: 'Viewer', groupId: group.id, validity: '24h' })
    at = await save(admin, at)
    const record = await stored()
    expect(record.grants?.map((grant) => grant.id)).toEqual([fresh.id])
    const revoked = audit(admin).filter((entry) => entry.action === 'INVITE_REVOKED')
    expect(revoked.map((entry) => entry.entityId)).toContain(pending.id)
    expect(revoked.find((entry) => entry.entityId === pending.id)?.details).toMatchObject({ reason: 'ROTATION' })
    await expect(redeemGrant(record, { kind: 'INVITE', email: BOB.email, code: pending.code, password: BOB.password })).rejects.toMatchObject({ code: 'INVITE_INVALID' })
    const carol = track(await redeemGrant(record, { kind: 'INVITE', email: CAROL.email, code: fresh.code, password: CAROL.password }))
    expect(carol.keys!.epoch).toBe(2)
    at = await save(carol, at)
    track(await unlockVault(await stored(), CAROL.email, CAROL.password))
  })

  it('keeps a member who redeemed an invite but was not signed into the roster yet, through their key binding', async () => {
    const { founder, ids, group } = await household([ALICE])
    let at = (await stored()).updatedAt
    const invite = await createInvite(founder, { email: BOB.email, roleName: 'Viewer', groupId: group.id, validity: '24h' })
    at = await save(founder, at)
    const bob = track(await redeemGrant(await stored(), { kind: 'INVITE', email: BOB.email, code: invite.code, password: BOB.password }))
    at = await save(bob, at)
    // The founder signs in with Bob's binding still waiting, and takes Alice out before any save folds Bob in.
    const admin = await signIn(FOUNDER)
    suspendUser(admin, ids[0])
    await save(admin, at)
    const record = await stored()
    expect(Object.keys(record.keys.dekWraps).sort()).toEqual([admin.user.id, invite.id].sort())
    const back = await signIn(BOB, record)
    expect(back.keys!.epoch).toBe(2)
    const latest = (await readRosterDocs(back.db))!.at(-1)!
    expect(latest.members.find((member) => member.id === invite.id)?.status).toBe('active')
  })

  it('tells the dialog what a removal will do: a new key, and how many codes for others stop working', async () => {
    const { founder, ids, group } = await household([ALICE])
    await createInvite(founder, { email: BOB.email, roleName: 'Viewer', groupId: group.id, validity: '24h' })
    await issueReset(founder, ids[0], { validity: '24h', stopOldPassword: true })
    // Alice's own new code goes with her; Bob's open invite is the one that stops.
    expect(removalEffects(founder, ids[0])).toEqual({ newKey: true, codesStopped: 1 })
    const waiting = founder.db.queryValue('SELECT id FROM access_grants WHERE email = ?', [BOB.email])
    expect(removalEffects(founder, String(waiting))).toEqual({ newKey: false, codesStopped: 0 })
  })

  it('tells the health check which household key the last backup holds', async () => {
    const { founder, at, ids } = await household([ALICE])
    noteExport(founder)
    const facts = () => collectVaultFacts(founder, { saveState: 'saved', weak: false, archives: 0, deviceMark: null, recordedHead: null }).keys
    expect(facts()).toMatchObject({ epoch: 1, missing: 0, backupEpoch: 1 })
    suspendUser(founder, ids[0])
    // Until the next save wraps the new key, the people who stay hold none of it.
    expect(facts()).toMatchObject({ epoch: 2, missing: 1, backupEpoch: 1 })
    await save(founder, at)
    expect(facts()).toMatchObject({ epoch: 2, missing: 0, backupEpoch: 1 })
    noteExport(founder)
    expect(facts()?.backupEpoch).toBe(2)
  })

  it('makes one new epoch for several removals before a save', async () => {
    const { founder, at, ids } = await household([ALICE, BOB])
    suspendUser(founder, ids[0])
    deleteUser(founder, ids[1])
    expect(founder.keys!.epoch).toBe(2)
    await save(founder, at)
    const record = await stored()
    expect(record.keys.epoch).toBe(2)
    expect(Object.keys(record.keys.dekWraps)).toEqual([founder.user.id])
    expect(audit(founder).filter((entry) => entry.action === 'EPOCH_ROTATED')).toHaveLength(1)
  })

  it('archives the record a new epoch replaces without the access of those who left, and deletes every older archive', async () => {
    const { founder, ids } = await household([ALICE, BOB])
    let at = (await stored()).updatedAt
    // An older archive, such as the copy kept before an import.
    const older = await sealVault(founder)
    await writeVault(older, { expectedStamp: at, archive: { reason: 'import', raw: await readVaultRaw() } })
    commitSealed(founder, older)
    at = older.updatedAt
    expect(await listArchives()).toHaveLength(1)
    const beforeRotation = await stored()
    suspendUser(founder, ids[0])
    await save(founder, at)
    const archives = await listArchives()
    expect(archives.map((entry) => entry.reason)).toEqual(['rotation'])
    const archived = await readArchive(archives[0].key)
    const record = decodeStoredRecord(archived!.raw, archived!.chunks).record as KeysRecord
    expect(record.keys.epoch).toBe(1)
    expect(record.updatedAt).toBe(beforeRotation.updatedAt)
    expect(Object.keys(record.keys.identities).sort()).toEqual([founder.user.id, ids[1]].sort())
    expect(Object.keys(record.keys.dekWraps).sort()).toEqual([founder.user.id, ids[1]].sort())
    // Whoever stays can still open it, as an older copy; whoever left cannot.
    await expect(unlockVault(record, ALICE.email, ALICE.password)).rejects.toBeInstanceOf(AuthError)
    await expect(unlockVault(record, BOB.email, BOB.password)).rejects.toMatchObject({ code: 'KEYS_ROSTER_ROLLBACK' })
    track(await unlockKeysVault(record, FOUNDER.email, FOUNDER.password, { acceptRollback: true }))
    // A later save in the same epoch keeps the archive.
    await save(founder, (await stored()).updatedAt)
    expect((await listArchives()).map((entry) => entry.reason)).toEqual(['rotation'])
  })

  it('a seal of the new epoch that is never stored leaves the next one complete', async () => {
    const { founder, at, ids } = await household([ALICE, BOB])
    suspendUser(founder, ids[0])
    // Sealed but not written, as when the browser refuses to store it.
    const lost = (await sealVault(founder)) as KeysRecord
    expect(lost.keys.epoch).toBe(2)
    await save(founder, at)
    const record = await stored()
    expect(record.keys.epoch).toBe(2)
    expect(Object.keys(record.keys.dekWraps).sort()).toEqual([founder.user.id, ids[1]].sort())
    expect((await listArchives()).map((entry) => entry.reason)).toEqual(['rotation'])
    track(await unlockVault(record, BOB.email, BOB.password))
  })

  it('a removal while a save signs its roster version makes that save start over in the new epoch', async () => {
    const { founder, at, ids, group } = await household([ALICE, BOB])
    // A change the save must sign, so it waits on a signature before it copies the image.
    updateUser(founder, ids[1], { roleName: 'Manager', groupId: group.id })
    const real = crypto.subtle.sign.bind(crypto.subtle)
    let release!: () => void
    let gate: Promise<void> | null = new Promise<void>((resolve) => (release = resolve))
    let waiting!: () => void
    const reached = new Promise<void>((resolve) => (waiting = resolve))
    vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (...args: Parameters<SubtleCrypto['sign']>) => {
      const wait = gate
      if (wait) {
        gate = null
        waiting()
        await wait
      }
      return real(...args)
    })
    const sealing = sealVault(founder)
    await reached
    suspendUser(founder, ids[0])
    release()
    const record = (await sealing) as KeysRecord
    vi.restoreAllMocks()
    expect(record.keys.epoch).toBe(2)
    await writeVault(record, { expectedStamp: at, rotation: rotationOf(founder, record) })
    commitSealed(founder, record)
    const bob = await signIn(BOB)
    expect(bob.user.roleName).toBe('Manager')
    await expect(unlockVault(await stored(), ALICE.email, ALICE.password)).rejects.toBeInstanceOf(AuthError)
  })

  it('a removal after a save copied the image leaves that save as it was, and the next save rotates', async () => {
    const { founder, at, ids } = await household([ALICE, BOB])
    const real = crypto.subtle.encrypt.bind(crypto.subtle)
    let release!: () => void
    let gate: Promise<void> | null = new Promise<void>((resolve) => (release = resolve))
    let waiting!: () => void
    const reached = new Promise<void>((resolve) => (waiting = resolve))
    vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (...args: Parameters<SubtleCrypto['encrypt']>) => {
      const wait = gate
      if (wait) {
        gate = null
        waiting()
        await wait
      }
      return real(...args)
    })
    const sealing = sealVault(founder, { full: true })
    await reached
    suspendUser(founder, ids[0])
    release()
    const before = (await sealing) as KeysRecord
    vi.restoreAllMocks()
    // Sealed from the image before the removal: the old epoch, with Alice still in it.
    expect(before.keys.epoch).toBe(1)
    expect(before.keys.dekWraps[ids[0]]).toBeDefined()
    await writeVault(before, { expectedStamp: at, rotation: rotationOf(founder, before) })
    commitSealed(founder, before)
    track(await unlockVault(await stored(), ALICE.email, ALICE.password))
    await save(founder, before.updatedAt)
    const after = await stored()
    expect(after.keys.epoch).toBe(2)
    await expect(unlockVault(after, ALICE.email, ALICE.password)).rejects.toBeInstanceOf(AuthError)
    expect((await listArchives()).map((entry) => entry.reason)).toEqual(['rotation'])
  })

  it('does not issue a code minted while a removal started a new epoch, nor one for someone taken out meanwhile', async () => {
    const { founder, at, ids } = await household([ALICE, BOB])
    // Argon2id runs while Alice is suspended: a new epoch starts before the code exists.
    const pending = issueReset(founder, ids[0], { validity: '24h', stopOldPassword: true })
    suspendUser(founder, ids[0])
    await expect(pending).rejects.toMatchObject({ code: 'SAVE_BUSY' })
    await save(founder, at)
    expect((await stored()).grants ?? []).toEqual([])
    // Taken out without a new epoch, as someone who never held the key would be (made so here by hand): the code is
    // refused when it is committed, since the person it is for is suspended by then.
    const admin = await signIn(FOUNDER)
    const later = issueReset(admin, ids[1], { validity: '24h', stopOldPassword: true })
    admin.keys!.holders = admin.keys!.holders.filter((id) => id !== ids[1])
    delete admin.keys!.dekWraps[ids[1]]
    suspendUser(admin, ids[1])
    expect(admin.keys!.epoch).toBe(2)
    await expect(later).rejects.toMatchObject({ code: 'USER_SUSPENDED' })
    expect(admin.grants).toEqual([])
  })

  it('gives no copy of the new key to someone whose signed key cannot take one, and still saves for everyone else', async () => {
    const created = await createKeysVault({ ...FOUNDER, displayName: 'Bad Key Household', currency: 'USD' })
    track(created.vault)
    await writeVault(created.record, { expectedStamp: null })
    commitSealed(created.vault, created.record)
    confirmKeysSession(created.vault)
    let at = created.record.updatedAt
    const [group] = listGroups(created.vault)
    const ids: Record<string, string> = {}
    for (const person of [ALICE, CAROL]) {
      const founder = await signIn(FOUNDER)
      const invite = await createInvite(founder, { email: person.email, roleName: 'Viewer', groupId: group.id, validity: '24h' })
      at = await save(founder, at)
      const record = await stored()
      const member = track(await redeemGrant(record, { kind: 'INVITE', email: person.email, code: invite.code, password: person.password }))
      if (person === CAROL) {
        // A modified client: the binding is signed as it must be, but names an all-zero X25519 key nobody can wrap to.
        const grant = record.grants!.find((item) => item.id === invite.id)!
        const inviteKeys = await deriveInviteKeys(normalizeAccessCode(invite.code), cloneBytes(grant.salt), grant.kdf as never)
        const real = readBindings(member.db)!.find((binding) => binding.memberId === invite.id)!
        writeBinding(member.db, await signBinding({ ...real, encPub: Buffer.alloc(32).toString('base64') }, inviteKeys.sigPriv, member.keys!.identity.sigPriv))
      }
      at = await save(member, at)
      ids[person.email] = invite.id
    }
    let founder = await signIn(FOUNDER)
    at = await save(founder, at)
    founder = await signIn(FOUNDER)
    suspendUser(founder, ids[ALICE.email])
    await save(founder, at)
    const record = await stored()
    expect(Object.keys(record.keys.dekWraps)).toEqual([founder.user.id])
    const latest = (await readRosterDocs(founder.db))!.at(-1)!
    expect(latest.members.find((member) => member.id === ids[CAROL.email])?.status).toBe('removed')
    track(await unlockVault(record, FOUNDER.email, FOUNDER.password))
  })

  it('signs only the roster version it stores on the first save after a removal', async () => {
    const { founder, at, ids } = await household([ALICE, BOB])
    suspendUser(founder, ids[0])
    const signed: number[] = []
    const real = crypto.subtle.sign.bind(crypto.subtle)
    vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (algorithm, key, data) => {
      const bytes = new Uint8Array(data as ArrayBuffer)
      const zero = bytes.indexOf(0)
      if (zero > 0 && new TextDecoder().decode(bytes.subarray(0, zero)) === 'moliya/v2/roster') {
        const body = JSON.parse(new TextDecoder().decode(bytes.subarray(zero + 1))) as { members: { status: string }[] }
        signed.push(body.members.filter((member) => member.status === 'active').length)
      }
      return real(algorithm, key, data)
    })
    await save(founder, at)
    vi.restoreAllMocks()
    // One signature, for the version that names the founder and Bob active: no plan made before the new wraps.
    expect(signed).toEqual([2])
  })

  it('refuses a removal it cannot sign into a new epoch, before changing anything', async () => {
    const { founder, ids } = await household([ALICE])
    founder.keys!.nextDek = null
    expect(() => suspendUser(founder, ids[0])).toThrow(ForbiddenError)
    expect(founder.keys!.epoch).toBe(1)
    expect(founder.db.queryValue("SELECT COUNT(*) FROM audit_logs WHERE action IN ('USER_SUSPENDED', 'EPOCH_ROTATED')")).toBe(0)
  })

  it('gives a reactivated member a code for the new key', async () => {
    const { founder, ids } = await household([ALICE])
    let at = (await stored()).updatedAt
    suspendUser(founder, ids[0])
    at = await save(founder, at)
    const admin = await signIn(FOUNDER)
    const reset = await reactivateUser(admin, ids[0], { validity: '24h' })
    at = await save(admin, at)
    const alice = track(await redeemGrant(await stored(), { kind: 'RESET', email: ALICE.email, code: reset.code, password: 'alice-new-rotate-password-2' }))
    expect(alice.keys!.epoch).toBe(2)
    await save(alice, at)
    const signedIn = track(await unlockVault(await stored(), ALICE.email, 'alice-new-rotate-password-2'))
    expect(signedIn.keys!.epoch).toBe(2)
  })
})
