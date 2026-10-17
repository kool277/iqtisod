import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openChunkedBody } from '../../src/db/chunks'
import { parseBackupText, toBackupJson, type KeysRecord, type LegacyRecord } from '../../src/db/envelope'
import { readVault, writeVault } from '../../src/db/storage'
import { KEYS_RECORD_VERSION, KEYS_SCHEMA_VERSION } from '../../src/db/versions'
import { AuthError, KeysBlockedError, ValidationError } from '../../src/domain/errors'
import type { OpenVault } from '../../src/domain/types'
import { changeOwnPassword } from '../../src/services/account.service'
import { createVault, sealVault, unlockVault, verifyOwnPassword } from '../../src/services/auth.service'
import { createInvite, issueReset, redeemGrant } from '../../src/services/grant.service'
import { listGroups } from '../../src/services/group.service'
import { createUser, deleteUser, suspendUser, updateUser } from '../../src/services/user.service'
import { readPeople } from '../../src/services/v2/roster-store'
import { commitSealed, confirmKeysSession, pinFounder, resetRosterSeen, rosterSeen } from '../../src/services/v2/session'
import { upgradeToKeys, upgradeReinvites } from '../../src/services/v2/upgrade'
import { createKeysVault, unlockKeysVault } from '../../src/services/v2/vault'
import { memoryStorage } from '../support/memory-storage'

// The smallest Argon2id the readers accept, so the many derivations here stay quick. Real wraps use 64 MiB.
vi.mock('../../src/crypto/kdf', async (load) => {
  const actual = await load<typeof import('../../src/crypto/kdf')>()
  return { ...actual, ARGON2_DEFAULT: { name: 'Argon2id', m: 19_456, t: 2, p: 1, len: 32, v: 19 } }
})

const FOUNDER = { email: 'founder@keys.test', password: 'founder-keys-password-1' }
const MEMBER = { email: 'member@keys.test', password: 'member-keys-password-1' }

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

/** Saves the way the app does: seal, write with the stamp, then let the session keep the stored chunk state. */
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

async function setUpFounder() {
  const created = await createKeysVault({ ...FOUNDER, displayName: 'Keys Household', currency: 'USD' })
  track(created.vault)
  await writeVault(created.record, { expectedStamp: null })
  commitSealed(created.vault, created.record)
  confirmKeysSession(created.vault)
  return { vault: created.vault, stamp: created.record.updatedAt }
}

describe('a per-person-keys vault', () => {
  it('is created as record 3 and schema 5, and opens only with the founder\'s password', async () => {
    const { vault } = await setUpFounder()
    const record = await stored()
    expect(record.schemaVersion).toBe(KEYS_SCHEMA_VERSION)
    expect(record.wraps).toEqual([])
    expect(Object.keys(record.keys.identities)).toEqual([vault.user.id])
    expect(record.keys.roster.version).toBe(1)
    expect(record.keys.founder.memberId).toBe(vault.user.id)

    const reopened = track(await unlockVault(record, FOUNDER.email, FOUNDER.password))
    expect(reopened.keys?.memberId).toBe(vault.user.id)
    expect(reopened.user.roleName).toBe('Admin')
    expect(reopened.keys?.firstSeen).toBe(false)
    await expect(unlockVault(record, FOUNDER.email, 'not-the-password-at-all')).rejects.toBeInstanceOf(AuthError)
    await expect(unlockVault(record, 'nobody@keys.test', FOUNDER.password)).rejects.toBeInstanceOf(AuthError)
    // No 1.x check value is stored for anyone.
    expect(reopened.db.queryValue("SELECT COUNT(*) FROM users WHERE password_hash <> '' OR salt <> ''")).toBe(0)
  })

  it('refuses temporary passwords, and lets a member in only through an invite that the next admin save signs', async () => {
    const { vault, stamp } = await setUpFounder()
    const [group] = listGroups(vault)
    await expect(createUser(vault, { email: MEMBER.email, password: MEMBER.password, roleName: 'Manager', groupId: group.id })).rejects.toThrow('KEYS_INVITE_ONLY')
    const invite = await createInvite(vault, { email: MEMBER.email, roleName: 'Manager', groupId: group.id, validity: '24h' })
    const afterInvite = await save(vault, stamp)
    const withInvite = await stored()
    expect(withInvite.keys.roster.version).toBe(2)
    expect(withInvite.grants?.[0].kdf.name).toBe('Argon2id')

    // The invitee redeems the code and saves as themselves: the roster still says invited, the binding lets them in.
    const member = track(await redeemGrant(withInvite, { kind: 'INVITE', email: MEMBER.email, code: invite.code, password: MEMBER.password }))
    expect(member.keys?.memberId).toBe(invite.id)
    await save(member, afterInvite)
    const redeemed = await stored()
    expect(redeemed.keys.roster.version).toBe(2)
    expect(redeemed.grants).toBeUndefined()
    const again = track(await unlockVault(redeemed, MEMBER.email, MEMBER.password))
    expect(again.user.roleName).toBe('Manager')
    expect(again.db.queryValue('SELECT COUNT(*) FROM key_bindings')).toBe(1)
    // The used code opens nothing any more.
    await expect(redeemGrant(redeemed, { kind: 'INVITE', email: MEMBER.email, code: invite.code, password: MEMBER.password })).rejects.toBeInstanceOf(ValidationError)

    // The founder's next save folds the binding into roster version 3.
    const founder = track(await unlockVault(redeemed, FOUNDER.email, FOUNDER.password))
    await save(founder, redeemed.updatedAt)
    const folded = await stored()
    expect(folded.keys.roster.version).toBe(3)
    const reopened = track(await unlockVault(folded, MEMBER.email, MEMBER.password))
    expect(reopened.db.queryValue('SELECT COUNT(*) FROM key_bindings')).toBe(0)
    expect(reopened.db.queryValue('SELECT COUNT(*) FROM roster_versions')).toBe(3)
  })

  it('blocks a vault whose people no longer match the signed roster', async () => {
    const { vault, stamp } = await setUpFounder()
    const [group] = listGroups(vault)
    const invite = await createInvite(vault, { email: MEMBER.email, roleName: 'Viewer', groupId: group.id, validity: '24h' })
    const afterInvite = await save(vault, stamp)
    const member = track(await redeemGrant(await stored(), { kind: 'INVITE', email: MEMBER.email, code: invite.code, password: MEMBER.password }))
    // A viewer with devtools makes themselves an admin in the database and saves.
    member.db.exec("UPDATE users SET role_id = (SELECT id FROM roles WHERE name = 'Admin') WHERE id = ?", [member.user.id])
    await save(member, afterInvite)
    const tampered = await stored()
    await expect(unlockVault(tampered, FOUNDER.email, FOUNDER.password)).rejects.toMatchObject({ code: 'KEYS_ROSTER_BROKEN' })
    await expect(unlockVault(tampered, MEMBER.email, MEMBER.password)).rejects.toMatchObject({ code: 'KEYS_ROSTER_BROKEN' })
  })

  it('blocks a founder other than the one pinned in this browser, and a header that was edited', async () => {
    await setUpFounder()
    const record = await stored()
    pinFounder(record.keys.vaultId, Buffer.alloc(32, 9).toString('base64'))
    await expect(unlockVault(record, FOUNDER.email, FOUNDER.password)).rejects.toMatchObject({ code: 'KEYS_FOUNDER_MISMATCH' })
    pinFounder(record.keys.vaultId, record.keys.founder.sigPub)

    const edited = parseBackupText(JSON.stringify(toBackupJson(record, record.updatedAt))).record as KeysRecord
    edited.createdAt = '2020-01-01T00:00:00.000Z'
    await expect(unlockVault(edited, FOUNDER.email, FOUNDER.password)).rejects.toMatchObject({ code: 'KEYS_HEADER_INVALID' })
    const otherRoster = { ...record, keys: { ...record.keys, roster: { ...record.keys.roster, hash: 'c'.repeat(64) } } }
    await expect(unlockVault(otherRoster, FOUNDER.email, FOUNDER.password)).rejects.toMatchObject({ code: 'KEYS_HEADER_INVALID' })
  })

  it('blocks an older roster than this browser saw, unless an admin chooses to open it', async () => {
    const { vault, stamp } = await setUpFounder()
    const older = await stored()
    const [group] = listGroups(vault)
    await createInvite(vault, { email: MEMBER.email, roleName: 'Viewer', groupId: group.id, validity: '24h' })
    await save(vault, stamp)
    const newer = await stored()
    confirmKeysSession(track(await unlockVault(newer, FOUNDER.email, FOUNDER.password)))
    expect(rosterSeen(newer.keys.vaultId)).toBe(2)

    const blocked = unlockVault(older, FOUNDER.email, FOUNDER.password)
    await expect(blocked).rejects.toBeInstanceOf(KeysBlockedError)
    await expect(blocked).rejects.toMatchObject({ code: 'KEYS_ROSTER_ROLLBACK', versions: { seen: 2, current: 1 } })
    const accepted = track(await unlockKeysVault(older, FOUNDER.email, FOUNDER.password, { acceptRollback: true }))
    expect(accepted.needsSave).toBe(true)
    expect(accepted.db.queryValue("SELECT COUNT(*) FROM audit_logs WHERE action = 'ROSTER_ROLLBACK_ACCEPTED'")).toBe(1)
    resetRosterSeen(newer.keys.vaultId, 1)
    track(await unlockVault(older, FOUNDER.email, FOUNDER.password))
  })

  it('takes a suspended member out with a new epoch, and refuses their old keys put back', async () => {
    const { vault, stamp } = await setUpFounder()
    const [group] = listGroups(vault)
    const invite = await createInvite(vault, { email: MEMBER.email, roleName: 'Viewer', groupId: group.id, validity: '24h' })
    const afterInvite = await save(vault, stamp)
    const member = track(await redeemGrant(await stored(), { kind: 'INVITE', email: MEMBER.email, code: invite.code, password: MEMBER.password }))
    const afterRedeem = await save(member, afterInvite)
    const redeemed = await stored()

    const founder = track(await unlockVault(redeemed, FOUNDER.email, FOUNDER.password))
    const oldDek = founder.dek
    suspendUser(founder, invite.id)
    await save(founder, afterRedeem)
    const suspended = await stored()
    expect(suspended.keys.identities[invite.id]).toBeUndefined()
    expect(suspended.keys.epoch).toBe(redeemed.keys.epoch + 1)
    // The member held the old DEK, so the body is under a new one.
    await expect(openChunkedBody(suspended.body, oldDek, { vaultId: suspended.keys.vaultId, epoch: suspended.keys.epoch })).rejects.toThrow()
    await expect(unlockVault(suspended, MEMBER.email, MEMBER.password)).rejects.toBeInstanceOf(AuthError)

    // Someone copies the member's old identity and DEK wrap back into the header: the signed roster says removed.
    const restored: KeysRecord = {
      ...suspended,
      keys: {
        ...suspended.keys,
        identities: { ...suspended.keys.identities, [invite.id]: redeemed.keys.identities[invite.id] },
        dekWraps: { ...suspended.keys.dekWraps, [invite.id]: redeemed.keys.dekWraps[invite.id] },
      },
    }
    // Their wrap is of the old epoch's key.
    await expect(unlockVault(restored, MEMBER.email, MEMBER.password)).rejects.toMatchObject({ code: 'KEYS_EPOCH_MISMATCH' })
    // Relabelled to the new epoch it no longer unwraps: the AAD binds the epoch.
    const relabelled: KeysRecord = { ...restored, keys: { ...restored.keys, dekWraps: { ...restored.keys.dekWraps, [invite.id]: { ...redeemed.keys.dekWraps[invite.id], epoch: suspended.keys.epoch } } } }
    await expect(unlockVault(relabelled, MEMBER.email, MEMBER.password)).rejects.toThrow()
  })

  it('changes a member\'s own password without an admin, and relabels an email without new keys', async () => {
    const { vault, stamp } = await setUpFounder()
    await changeOwnPassword(vault, FOUNDER.password, 'a-new-founder-password-2')
    await expect(verifyOwnPassword(vault, FOUNDER.password)).rejects.toBeInstanceOf(AuthError)
    await verifyOwnPassword(vault, 'a-new-founder-password-2')
    updateUser(vault, vault.user.id, { roleName: 'Admin', groupId: null, email: 'renamed@keys.test' })
    await save(vault, stamp)
    const record = await stored()
    expect(record.keys.roster.version).toBe(2)
    await expect(unlockVault(record, FOUNDER.email, 'a-new-founder-password-2')).rejects.toBeInstanceOf(AuthError)
    const reopened = track(await unlockVault(record, 'renamed@keys.test', 'a-new-founder-password-2'))
    expect(reopened.user.email).toBe('renamed@keys.test')
  })

  it('re-invites a member: their old access stops at once and the new code gives them new keys', async () => {
    const { vault, stamp } = await setUpFounder()
    const [group] = listGroups(vault)
    const invite = await createInvite(vault, { email: MEMBER.email, roleName: 'Viewer', groupId: group.id, validity: '24h' })
    let at = await save(vault, stamp)
    const member = track(await redeemGrant(await stored(), { kind: 'INVITE', email: MEMBER.email, code: invite.code, password: MEMBER.password }))
    at = await save(member, at)
    const founder = track(await unlockVault(await stored(), FOUNDER.email, FOUNDER.password))
    const oldKey = founder.keys!.identities[invite.id].sigPub
    const reset = await issueReset(founder, invite.id, { validity: '24h', stopOldPassword: false })
    expect(founder.keys!.identities[invite.id]).toBeUndefined()
    at = await save(founder, at)
    await expect(unlockVault(await stored(), MEMBER.email, MEMBER.password)).rejects.toBeInstanceOf(AuthError)
    const back = track(await redeemGrant(await stored(), { kind: 'RESET', email: MEMBER.email, code: reset.code, password: 'member-new-password-2' }))
    expect(back.keys!.identity.sigPub).not.toBe(oldKey)
    at = await save(back, at)
    track(await unlockVault(await stored(), MEMBER.email, 'member-new-password-2'))
    // Deleting a member (records kept) takes them out of the roster too.
    const admin = track(await unlockVault(await stored(), FOUNDER.email, FOUNDER.password))
    deleteUser(admin, invite.id)
    await save(admin, at)
    const final = await stored()
    expect(final.keys.identities[invite.id]).toBeUndefined()
    const people = readPeople(track(await unlockVault(final, FOUNDER.email, FOUNDER.password)).db)
    expect(people.map((person) => person.email)).toEqual([FOUNDER.email])
  })

  it('round-trips through a backup file and opens it with the member\'s password', async () => {
    await setUpFounder()
    const record = await stored()
    const text = JSON.stringify(toBackupJson(record, '2026-10-16T12:00:00.000Z'))
    const parsed = parseBackupText(text)
    expect(parsed.record.version).toBe(KEYS_RECORD_VERSION)
    track(await unlockVault(parsed.record, FOUNDER.email, FOUNDER.password))
  })
})

describe('the founder upgrade of a 1.x vault', () => {
  it('leaves only the founder with access, under a new DEK, and ends every 1.x code', async () => {
    const created = await createVault({ ...FOUNDER, displayName: 'Old Household', currency: 'USD' })
    const v1 = track(created.vault)
    const [group] = listGroups(v1)
    await createUser(v1, { email: MEMBER.email, password: MEMBER.password, roleName: 'Manager', groupId: group.id })
    await createInvite(v1, { email: 'later@keys.test', roleName: 'Viewer', groupId: group.id, validity: '24h' })
    const sealedV1 = (await sealVault(v1)) as LegacyRecord
    await writeVault(sealedV1, { expectedStamp: null })
    expect(upgradeReinvites(v1)).toBe(1)

    await expect(upgradeToKeys(v1, 'wrong-password-entirely')).rejects.toBeInstanceOf(AuthError)
    const v1Dek = v1.dek
    const { vault, record } = await upgradeToKeys(v1, FOUNDER.password)
    await writeVault(record, { expectedStamp: sealedV1.updatedAt, archive: { reason: 'upgrade', raw: sealedV1 } })
    commitSealed(vault, record)
    expect(record.version).toBe(KEYS_RECORD_VERSION)
    expect(record.wraps).toEqual([])
    expect(record.grants).toBeUndefined()
    expect(Object.keys(record.keys.identities)).toEqual([vault.user.id])
    expect(vault.db.queryValue('SELECT COUNT(*) FROM access_grants WHERE ended_at IS NULL')).toBe(0)
    expect(vault.db.queryValue("SELECT COUNT(*) FROM audit_logs WHERE action = 'VAULT_UPGRADED'")).toBe(1)
    expect(vault.db.queryValue("SELECT COUNT(*) FROM users WHERE password_hash <> '' OR salt <> ''")).toBe(0)

    // The 1.x DEK does not open the new body; the founder's password does, the member's no longer does.
    const fresh = await stored()
    expect(vault.dek).not.toBe(v1Dek)
    await expect(openChunkedBody(fresh.body, v1Dek, { vaultId: fresh.keys.vaultId, epoch: 1 })).rejects.toThrow()
    track(await unlockVault(fresh, FOUNDER.email, FOUNDER.password))
    await expect(unlockVault(fresh, MEMBER.email, MEMBER.password)).rejects.toBeInstanceOf(AuthError)
    // The member keeps their records and history; they need a new invite.
    expect(readPeople(vault.db).map((person) => person.email).sort()).toEqual([FOUNDER.email, MEMBER.email].sort())
    // The 1.x record is kept as the rollback path, and still opens with the member's old password.
    const { listArchives, readArchive } = await import('../../src/db/storage')
    const [archive] = await listArchives()
    expect(archive.reason).toBe('upgrade')
    const { decodeStoredRecord } = await import('../../src/db/envelope')
    const kept = decodeStoredRecord((await readArchive(archive.key))!.raw).record
    track(await unlockVault(kept, MEMBER.email, MEMBER.password))
  })
})
