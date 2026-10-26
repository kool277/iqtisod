import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KeysRecord } from '../../src/db/envelope'
import { readVault, writeVault } from '../../src/db/storage'
import { KEYS_RECORD_VERSION } from '../../src/db/versions'
import type { OpenVault } from '../../src/domain/types'
import { writeAudit } from '../../src/services/audit.service'
import { createVault, sealVault, unlockVault } from '../../src/services/auth.service'
import { createTransaction, listCategories } from '../../src/services/finance.service'
import { createInvite, redeemGrant } from '../../src/services/grant.service'
import { createGroup, listGroups } from '../../src/services/group.service'
import { auditSigBody, signAuditEntry, type AuditSig } from '../../src/crypto/audit-sign'
import { auditHash, type AuditRow } from '../../src/db/audit-chain'
import { issueReset } from '../../src/services/grant.service'
import { suspendUser, updateUser } from '../../src/services/user.service'
import { auditCheckInput, checkAuditSignatures, checkVaultAudit, type AuditCheckInput, type AuditCheckReport } from '../../src/services/v2/audit-check'
import { forgetAuditSeen, keepAuditSeen, readAuditSeen } from '../../src/services/v2/audit-seen'
import { signatureCheck } from '../../src/health/evaluate'
import { collectVaultFacts } from '../../src/health/vault'
import { ForbiddenError } from '../../src/domain/errors'
import { commitSealed, confirmKeysSession, rotationOf, type KeysSession } from '../../src/services/v2/session'
import { checkKeysBackup, takeOutAgain } from '../../src/services/v2/restore'
import { upgradeToKeys } from '../../src/services/v2/upgrade'
import { createKeysVault, unlockKeysVault } from '../../src/services/v2/vault'
import { memoryStorage } from '../support/memory-storage'

// The smallest Argon2id the readers accept, so the derivations here stay quick.
vi.mock('../../src/crypto/kdf', async (load) => {
  const actual = await load<typeof import('../../src/crypto/kdf')>()
  return { ...actual, ARGON2_DEFAULT: { name: 'Argon2id', m: 19_456, t: 2, p: 1, len: 32, v: 19 } }
})

const FOUNDER = { email: 'founder@audit.test', password: 'founder-audit-password-1' }
const ALICE = { email: 'alice@audit.test', password: 'alice-audit-password-1' }
const BOB = { email: 'bob@audit.test', password: 'bob-audit-password-1' }

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

async function inputOf(vault: OpenVault): Promise<AuditCheckInput> {
  const input = await auditCheckInput(vault.db, vault.keys!.vaultId, null)
  if (!input) throw new Error('no roster')
  return input
}

async function report(vault: OpenVault): Promise<AuditCheckReport> {
  return checkAuditSignatures(await inputOf(vault))
}

/** The entry `seq` changed as `change` says, with its chain hash recomputed when `rehash`. */
function edited(input: AuditCheckInput, seq: number, change: Partial<AuditRow>, rehash = false): AuditCheckInput {
  const rows = input.rows.map((row) => {
    if (row.seq !== seq) return row
    const next = { ...row, ...change }
    if (!rehash) return next
    const { hash: _hash, ...link } = next
    return { ...next, hash: auditHash(link) }
  })
  return { ...input, rows }
}

/** A new last entry by `actor`, linked into the chain and signed with `sigPriv`, as someone editing the database could. */
async function appended(input: AuditCheckInput, entry: { actor: string; action: string; entityType?: string; entityId?: string }, sig: Omit<AuditSig, 'seq' | 'sig' | 'actor'> & { actor?: string }, sigPriv: CryptoKey): Promise<AuditCheckInput> {
  const last = input.rows.at(-1)!
  const link = {
    seq: last.seq + 1,
    id: crypto.randomUUID(),
    actorId: entry.actor,
    action: entry.action,
    entityType: entry.entityType ?? 'vault',
    entityId: entry.entityId ?? 'primary',
    details: null,
    createdAt: new Date().toISOString(),
    prevHash: last.hash,
  }
  const row: AuditRow = { ...link, hash: auditHash(link) }
  const signer = { actor: sig.actor ?? entry.actor, rosterVersion: sig.rosterVersion, epoch: sig.epoch }
  const signed: AuditSig = { seq: row.seq, ...signer, sig: await signAuditEntry(auditSigBody(input.vaultId, row, signer, false), sigPriv) }
  return { ...input, rows: [...input.rows, row], sigs: [...input.sigs, signed] }
}

function latestVersion(input: AuditCheckInput) {
  const doc = input.roster.at(-1)!
  return { rosterVersion: doc.version, epoch: doc.epoch }
}

function problems(result: AuditCheckReport): Record<number, string[]> {
  return Object.fromEntries([...result.problems].map(([seq, list]) => [seq, [...list].sort()]))
}

function entries(vault: OpenVault): number {
  return Number(vault.db.queryValue('SELECT COUNT(*) FROM audit_logs'))
}

async function founded() {
  const created = await createKeysVault({ ...FOUNDER, displayName: 'Audit Household', currency: 'USD' })
  track(created.vault)
  await writeVault(created.record, { expectedStamp: null })
  commitSealed(created.vault, created.record)
  confirmKeysSession(created.vault)
  return { vault: created.vault, at: created.record.updatedAt }
}

/** The founder, Alice as a Manager and Bob as a Viewer, both redeemed and signed into the roster. */
async function household() {
  const { vault: first, at: start } = await founded()
  let at = start
  const [group] = listGroups(first)
  const alice = await createInvite(first, { email: ALICE.email, roleName: 'Manager', groupId: group.id, validity: '24h' })
  const bob = await createInvite(first, { email: BOB.email, roleName: 'Viewer', groupId: group.id, validity: '24h' })
  at = await save(first, at)
  at = await save(track(await redeemGrant(await stored(), { kind: 'INVITE', email: ALICE.email, code: alice.code, password: ALICE.password })), at)
  at = await save(track(await redeemGrant(await stored(), { kind: 'INVITE', email: BOB.email, code: bob.code, password: BOB.password })), at)
  const founder = await signIn(FOUNDER)
  at = await save(founder, at)
  return { founder, at, group, aliceId: alice.id, bobId: bob.id }
}

describe('signed audit entries', () => {
  it('signs the first entry of a new vault as the bridge, and every entry of each save after it', async () => {
    const { vault } = await founded()
    expect(vault.db.query('SELECT seq, actor, roster_version, epoch FROM audit_sigs')).toEqual([{ seq: 1, actor: vault.user.id, roster_version: 1, epoch: 1 }])
    const result = await report(vault)
    expect(problems(result)).toEqual({})
    expect(result).toMatchObject({ signedFrom: 1, legacy: 0, verified: 1, checked: 1 })
  })

  it('verifies a whole household: invites redeemed before and after their fold, work by each role, and a removal', async () => {
    const { founder, at: start, group, bobId } = await household()
    let at = start
    const food = listCategories(founder).find((category) => category.nameEn === 'Food')!.id
    const alice = await signIn(ALICE)
    createTransaction(alice, { type: 'EXPENSE', amount: '12.00', currency: 'USD', categoryId: food, groupId: group.id, date: '2026-10-20', notes: '', receiptData: null })
    at = await save(alice, at)
    const admin = await signIn(FOUNDER)
    createGroup(admin, 'Second')
    suspendUser(admin, bobId)
    at = await save(admin, at)
    expect(admin.keys.epoch).toBe(2)
    const result = await report(admin)
    expect(problems(result)).toEqual({})
    expect(result.verified).toBe(entries(admin))
    // Every entry names the roster version of the record that stored it, with that version's epoch.
    const named = admin.db.query('SELECT s.roster_version AS version, s.epoch, r.doc FROM audit_sigs s JOIN roster_versions r ON r.version = s.roster_version')
    for (const row of named) expect(JSON.parse(String(row.doc)).epoch).toBe(row.epoch)
  })

  it('lets an admin who steps down sign the entries of the save that lowers their role', async () => {
    const { founder, at: start, aliceId } = await household()
    let at = start
    updateUser(founder, aliceId, { roleName: 'Admin', groupId: null })
    at = await save(founder, at)
    const alice = await signIn(ALICE)
    updateUser(alice, alice.user.id, { roleName: 'Viewer', groupId: listGroups(alice)[0].id })
    at = await save(alice, at)
    const result = await report(alice)
    expect(problems(result)).toEqual({})
  })

  it('starts signing at the founder upgrade, leaving every 1.x entry before it as it was', async () => {
    const legacy = await createVault({ ...FOUNDER, displayName: 'Upgraded Household', currency: 'USD' })
    track(legacy.vault)
    const food = listCategories(legacy.vault).find((category) => category.nameEn === 'Food')!.id
    const group = listGroups(legacy.vault)[0].id
    createTransaction(legacy.vault, { type: 'EXPENSE', amount: '3.00', currency: 'USD', categoryId: food, groupId: group, date: '2026-10-20', notes: '', receiptData: null })
    const before = entries(legacy.vault)
    const { vault } = await upgradeToKeys(legacy.vault, FOUNDER.password)
    const result = await report(vault)
    expect(problems(result)).toEqual({})
    expect(result).toMatchObject({ signedFrom: before + 1, legacy: before })
    expect(result.verified).toBe(entries(vault) - before)
  })

  it('signs entries written while a save was signing in the next attempt, so nothing unsigned is stored', async () => {
    const { founder, at } = await household()
    const food = listCategories(founder).find((category) => category.nameEn === 'Food')!.id
    const group = listGroups(founder)[0].id
    createGroup(founder, 'Pending before the save')
    const subtle = globalThis.crypto.subtle
    const sign = subtle.sign.bind(subtle)
    let written = 0
    let calls = 0
    // The app writes while the first attempt signs: a new entry the signatures in flight do not cover.
    const spy = vi.spyOn(subtle, 'sign').mockImplementation((algorithm, key, data) => {
      calls += 1
      if (written === 0) {
        written += 1
        createTransaction(founder, { type: 'EXPENSE', amount: '1.00', currency: 'USD', categoryId: food, groupId: group, date: '2026-10-20', notes: '', receiptData: null })
      }
      return sign(algorithm, key, data)
    })
    let record
    try {
      record = await sealVault(founder)
    } finally {
      spy.mockRestore()
    }
    // One entry signed by the first attempt, both by the second, then the header.
    expect({ written, calls }).toEqual({ written: 1, calls: 4 })
    await writeVault(record, { expectedStamp: at })
    commitSealed(founder, record)
    // Read back from what was stored, not from the open session.
    const reopened = await signIn(FOUNDER)
    const head = entries(reopened)
    expect(reopened.db.queryValue("SELECT action FROM audit_logs WHERE seq = ?", [head - 0])).toBe('TRANSACTION_CREATED')
    const result = await report(reopened)
    expect(problems(result)).toEqual({})
    expect(result.verified).toBe(head)
  })

  it('keeps the signatures of someone whose redeemed invite an admin replaced or removed before it was folded in', async () => {
    const { vault: first, at: start } = await founded()
    let at = start
    const [group] = listGroups(first)
    const alice = await createInvite(first, { email: ALICE.email, roleName: 'Manager', groupId: group.id, validity: '24h' })
    const bob = await createInvite(first, { email: BOB.email, roleName: 'Viewer', groupId: group.id, validity: '24h' })
    at = await save(first, at)
    at = await save(track(await redeemGrant(await stored(), { kind: 'INVITE', email: ALICE.email, code: alice.code, password: ALICE.password })), at)
    at = await save(track(await redeemGrant(await stored(), { kind: 'INVITE', email: BOB.email, code: bob.code, password: BOB.password })), at)
    // The first admin save after they joined gives Alice a new code and suspends Bob: neither binding is folded in.
    const founder = await signIn(FOUNDER)
    await issueReset(founder, alice.id, { validity: '24h', stopOldPassword: true })
    suspendUser(founder, bob.id)
    at = await save(founder, at)
    expect(founder.db.queryValue('SELECT COUNT(*) FROM key_bindings')).toBe(0)
    const result = await report(founder)
    expect(problems(result)).toEqual({})
    expect(result.verified).toBe(entries(founder))
  })

  it('verifies an older backup restored with someone taken out again, and a reset code redeemed', async () => {
    const { founder, at: start, aliceId } = await household()
    let at = start
    const backup = await stored()
    suspendUser(founder, aliceId)
    at = await save(founder, at)
    const check = await checkKeysBackup(backup, FOUNDER.email, FOUNDER.password)
    track(check.vault)
    takeOutAgain(check.vault, check.older!.removals!)
    await sealVault(check.vault)
    expect(problems(await report(check.vault))).toEqual({})

    const admin = await signIn(FOUNDER)
    const bob = admin.db.queryValue('SELECT id FROM users WHERE email = ?', [BOB.email]) as string
    const reset = await issueReset(admin, bob, { validity: '24h', stopOldPassword: true })
    at = await save(admin, at)
    const redeemed = track(await redeemGrant(await stored(), { kind: 'RESET', email: BOB.email, code: reset.code, password: 'bob-audit-password-2' }))
    at = await save(redeemed, at)
    expect(problems(await report(redeemed))).toEqual({})
    const folded = await signIn(FOUNDER)
    at = await save(folded, at)
    expect(problems(await report(folded))).toEqual({})
  })

  it('signs the entry of an older copy an admin chose to open', async () => {
    const { founder, at: start, aliceId } = await household()
    const older = await stored()
    updateUser(founder, aliceId, { roleName: 'Viewer', groupId: listGroups(founder)[0].id })
    await save(founder, start)
    const opened = track(await unlockKeysVault(older, FOUNDER.email, FOUNDER.password, { acceptRollback: true }))
    expect(opened.db.queryValue('SELECT action FROM audit_logs ORDER BY seq DESC LIMIT 1')).toBe('ROSTER_ROLLBACK_ACCEPTED')
    await sealVault(opened)
    expect(problems(await report(opened))).toEqual({})
  })

  it('flags an entry written outside a save with someone else as actor', async () => {
    const { founder, at, aliceId } = await household()
    writeAudit(founder.db, aliceId, 'TRANSACTION_DELETED', 'transaction', 'x')
    await save(founder, at)
    const result = await report(founder)
    const head = entries(founder)
    expect(problems(result)).toEqual({ [head]: ['ACTOR'] })
  })
})

describe('tampering with the signed log (design 8.2)', () => {
  it('flags an edited action or target, whether or not its chain hash was recomputed', async () => {
    const { founder } = await household()
    const input = await inputOf(founder)
    const seq = input.rows[3].seq
    expect(problems(await checkAuditSignatures(edited(input, seq, { action: 'GROUP_DELETED' })))).toEqual({ [seq]: ['CHAIN', 'SIGNATURE'] })
    expect(problems(await checkAuditSignatures(edited(input, seq, { entityId: 'someone-else' }, true)))).toEqual({ [seq]: ['SIGNATURE'], [seq + 1]: ['CHAIN'] })
  })

  it('flags a log rewritten from an entry on with every hash recomputed', async () => {
    const { founder } = await household()
    const input = await inputOf(founder)
    let rewritten = edited(input, 2, { details: '{"changed":true}' }, true)
    for (const row of rewritten.rows.filter((item) => item.seq > 2)) {
      const before = rewritten.rows.find((item) => item.seq === row.seq - 1)!
      rewritten = edited(rewritten, row.seq, { prevHash: before.hash }, true)
    }
    const result = await checkAuditSignatures(rewritten)
    expect([...result.problems.keys()].sort((a, b) => a - b)).toEqual(input.rows.filter((row) => row.seq >= 2).map((row) => row.seq))
    expect([...result.problems.values()].every((list) => list.join() === 'SIGNATURE')).toBe(true)
  })

  it('flags an entry re-signed by a member with their own key while it names someone else', async () => {
    const { founder } = await household()
    const alice = await signIn(ALICE)
    const input = await inputOf(founder)
    const version = latestVersion(input)
    // Signed by Alice, but the signature row says the founder signed it.
    const claimed = await appended(input, { actor: founder.user.id, action: 'GROUP_CREATED', entityType: 'group' }, { ...version }, alice.keys.identity.sigPriv)
    expect(problems(await checkAuditSignatures(claimed))).toEqual({ [claimed.rows.at(-1)!.seq]: ['SIGNATURE'] })
    // Signed by Alice as herself, for an entry naming the founder as its actor.
    const own = await appended(input, { actor: founder.user.id, action: 'GROUP_CREATED', entityType: 'group' }, { ...version, actor: alice.user.id }, alice.keys.identity.sigPriv)
    expect(problems(await checkAuditSignatures(own))).toEqual({ [own.rows.at(-1)!.seq]: ['ACTOR', 'ROLE'] })
  })

  it('flags an action the signer\'s role does not allow, and lets each role sign what it may', async () => {
    const { founder } = await household()
    const alice = await signIn(ALICE)
    const bob = await signIn(BOB)
    const input = await inputOf(founder)
    const version = latestVersion(input)
    const managerUsers = await appended(input, { actor: alice.user.id, action: 'USER_UPDATED', entityType: 'user', entityId: bob.user.id }, version, alice.keys.identity.sigPriv)
    expect(problems(await checkAuditSignatures(managerUsers))).toEqual({ [managerUsers.rows.at(-1)!.seq]: ['ROLE'] })
    const viewerRecord = await appended(input, { actor: bob.user.id, action: 'TRANSACTION_CREATED', entityType: 'transaction', entityId: 'x' }, version, bob.keys.identity.sigPriv)
    expect(problems(await checkAuditSignatures(viewerRecord))).toEqual({ [viewerRecord.rows.at(-1)!.seq]: ['ROLE'] })
    const viewerOthersCheck = await appended(input, { actor: bob.user.id, action: 'TOTP_CLEARED', entityType: 'user', entityId: alice.user.id }, version, bob.keys.identity.sigPriv)
    expect(problems(await checkAuditSignatures(viewerOthersCheck))).toEqual({ [viewerOthersCheck.rows.at(-1)!.seq]: ['ROLE'] })
    const unknown = await appended(input, { actor: alice.user.id, action: 'SOMETHING_NEW' }, version, alice.keys.identity.sigPriv)
    expect(problems(await checkAuditSignatures(unknown))).toEqual({ [unknown.rows.at(-1)!.seq]: ['ROLE'] })
    for (const ok of [
      await appended(input, { actor: alice.user.id, action: 'TRANSACTION_DELETED', entityType: 'transaction', entityId: 'x' }, version, alice.keys.identity.sigPriv),
      await appended(input, { actor: bob.user.id, action: 'TOTP_ENABLED', entityType: 'user', entityId: bob.user.id }, version, bob.keys.identity.sigPriv),
      await appended(input, { actor: founder.user.id, action: 'SOMETHING_NEW' }, version, founder.keys.identity.sigPriv),
    ]) {
      expect(problems(await checkAuditSignatures(ok))).toEqual({})
    }
  })

  it('flags a deleted signature, and a deleted bridge on the entry that would replace it', async () => {
    const { founder } = await household()
    const input = await inputOf(founder)
    const middle = input.rows[4].seq
    expect(problems(await checkAuditSignatures({ ...input, sigs: input.sigs.filter((sig) => sig.seq !== middle) }))).toEqual({ [middle]: ['UNSIGNED'] })
    // Without the bridge's signature the next entry becomes the first signed one, and was not signed as the bridge.
    const withoutBridge = { ...input, sigs: input.sigs.slice(1), firstSigned: input.sigs[1].seq }
    expect(problems(await checkAuditSignatures(withoutBridge))).toEqual({ [input.sigs[1].seq]: ['SIGNATURE'] })
    // A browser that saw the bridge where it was also flags the entries left without a signature before it.
    expect(problems(await checkAuditSignatures({ ...withoutBridge, seenSignedFrom: 1 }))).toEqual({ 1: ['UNSIGNED'], [input.sigs[1].seq]: ['SIGNATURE'] })
  })

  it('flags a signature left behind by a removed entry, a wrong epoch and a roster version that goes back', async () => {
    const { founder } = await household()
    const input = await inputOf(founder)
    const last = input.rows.at(-1)!.seq
    expect(problems(await checkAuditSignatures({ ...input, rows: input.rows.slice(0, -1) }))).toEqual({ [last]: ['ORPHAN'] })
    const epoch = { ...input, sigs: input.sigs.map((sig) => (sig.seq === last ? { ...sig, epoch: sig.epoch + 1 } : sig)) }
    expect(problems(await checkAuditSignatures(epoch))).toEqual({ [last]: ['ORDER', 'SIGNATURE'] })
    const older = await appended(input, { actor: founder.user.id, action: 'GROUP_CREATED', entityType: 'group' }, { rosterVersion: 1, epoch: 1 }, founder.keys.identity.sigPriv)
    expect(problems(await checkAuditSignatures(older))).toEqual({ [older.rows.at(-1)!.seq]: ['ORDER'] })
    const future = await appended(input, { actor: founder.user.id, action: 'GROUP_CREATED', entityType: 'group' }, { rosterVersion: input.roster.length + 1, epoch: 1 }, founder.keys.identity.sigPriv)
    expect(problems(await checkAuditSignatures(future))).toEqual({ [future.rows.at(-1)!.seq]: ['ORDER'] })
  })

  it('flags an entry by a member after their removal, with the version that removed them or one before it', async () => {
    const { founder, at, bobId } = await household()
    const bob = await signIn(BOB)
    suspendUser(founder, bobId)
    await save(founder, at)
    const input = await inputOf(founder)
    const removal = latestVersion(input)
    const after = await appended(input, { actor: bob.user.id, action: 'SIGNIN_FAILURES_SEEN', entityType: 'user', entityId: bob.user.id }, removal, bob.keys.identity.sigPriv)
    expect(problems(await checkAuditSignatures(after))).toEqual({ [after.rows.at(-1)!.seq]: ['SIGNER'] })
    const back = await appended(input, { actor: bob.user.id, action: 'SIGNIN_FAILURES_SEEN', entityType: 'user', entityId: bob.user.id }, { rosterVersion: removal.rosterVersion - 1, epoch: removal.epoch - 1 }, bob.keys.identity.sigPriv)
    expect(problems(await checkAuditSignatures(back))).toEqual({ [back.rows.at(-1)!.seq]: ['ORDER'] })
  })

  it('flags a signature by a key the roster never named for that member', async () => {
    const { founder } = await household()
    const input = await inputOf(founder)
    const stranger = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair
    const forged = await appended(input, { actor: founder.user.id, action: 'GROUP_CREATED', entityType: 'group' }, latestVersion(input), stranger.privateKey)
    expect(problems(await checkAuditSignatures(forged))).toEqual({ [forged.rows.at(-1)!.seq]: ['SIGNATURE'] })
    const nobody = await appended(input, { actor: 'not-a-member', action: 'GROUP_CREATED', entityType: 'group' }, latestVersion(input), stranger.privateKey)
    expect(problems(await checkAuditSignatures(nobody))).toEqual({ [nobody.rows.at(-1)!.seq]: ['SIGNER'] })
  })
})

describe('the checkpoint this browser keeps', () => {
  it('checks only the entries after it, until an entry or a signature up to it changes', async () => {
    const { founder, at } = await household()
    const vaultId = founder.keys.vaultId
    const head = entries(founder)
    keepAuditSeen(founder.db, vaultId, head)
    expect(readAuditSeen(vaultId)).toMatchObject({ seq: head, signedFrom: 1 })
    expect(await checkVaultAudit(founder)).toMatchObject({ start: head + 1, checked: 0, verified: 0 })
    createGroup(founder, 'After the checkpoint')
    await save(founder, at)
    const tail = await checkVaultAudit(founder)
    expect(tail).toMatchObject({ start: head + 1, checked: 1, verified: 1 })
    expect(problems(tail!)).toEqual({})
    expect(await checkVaultAudit(founder, { full: true })).toMatchObject({ start: 1, checked: head + 1, verified: head + 1 })

    // A signature up to the checkpoint deleted: everything is checked again, and the gap shows.
    founder.db.exec('DELETE FROM audit_sigs WHERE seq = 3')
    const again = await checkVaultAudit(founder)
    expect(again).toMatchObject({ start: 1, checked: head + 1 })
    expect(problems(again!)).toEqual({ 3: ['UNSIGNED'] })
  })

  it('starts again from the first entry when the log no longer reaches it, and forgets it on request', async () => {
    const { founder } = await household()
    const vaultId = founder.keys.vaultId
    const head = entries(founder)
    keepAuditSeen(founder.db, vaultId, head)
    const kept = readAuditSeen(vaultId)!
    localStorage.setItem(`moliya.v2.auditSeen.${vaultId}`, JSON.stringify({ ...kept, hash: 'f'.repeat(64) }))
    expect(await checkVaultAudit(founder)).toMatchObject({ start: 1, checked: head })
    localStorage.setItem(`moliya.v2.auditSeen.${vaultId}`, JSON.stringify({ ...kept, sigs: 'nope' }))
    expect(readAuditSeen(vaultId)).toBeNull()
    forgetAuditSeen(vaultId)
    expect(localStorage.getItem(`moliya.v2.auditSeen.${vaultId}`)).toBeNull()
  })

  it('never lets the first signed entry move later than this browser saw it, unless an admin accepted the log', async () => {
    const { founder } = await household()
    const vaultId = founder.keys.vaultId
    const head = entries(founder)
    keepAuditSeen(founder.db, vaultId, head)
    founder.db.exec('DELETE FROM audit_sigs WHERE seq = 1')
    keepAuditSeen(founder.db, vaultId, head)
    expect(readAuditSeen(vaultId)?.signedFrom).toBe(1)
    keepAuditSeen(founder.db, vaultId, head, { reset: true })
    expect(readAuditSeen(vaultId)?.signedFrom).toBe(2)
  })

  it('counts the open session\'s unsaved entries as pending, and stops before them', async () => {
    const { at } = await household()
    const founder = await signIn(FOUNDER)
    const before = entries(founder)
    createGroup(founder, 'Not saved yet')
    createGroup(founder, 'Nor this')
    const open = await checkVaultAudit(founder, { full: true })
    expect(problems(open!)).toEqual({})
    expect(open).toMatchObject({ pending: 2, verified: before, checkpoint: { seq: before } })
    await save(founder, at)
    expect(await checkVaultAudit(founder, { full: true })).toMatchObject({ pending: 0, verified: before + 2, checkpoint: { seq: before + 2 } })
  })

  it('is read only by people who may read the audit log', async () => {
    await household()
    const alice = await signIn(ALICE)
    await expect(checkVaultAudit(alice)).rejects.toBeInstanceOf(ForbiddenError)
  })
})

describe('the health check row', () => {
  it('passes, offers to check every entry after a partial check, and fails on any problem', () => {
    expect(signatureCheck({ checkedFrom: 1, signed: 12, problems: 0, firstProblem: null, signedFrom: 1 })).toMatchObject({ id: 'auditSignatures', status: 'pass', detail: 'ok', facts: { signed: 12 } })
    const partial = signatureCheck({ checkedFrom: 40, signed: 2, problems: 0, firstProblem: null, signedFrom: 1 })
    expect(partial).toMatchObject({ status: 'pass', facts: { signed: 2, checkedFrom: 40 }, action: 'auditFull' })
    expect(signatureCheck({ checkedFrom: 1, signed: 0, problems: 0, firstProblem: null, signedFrom: null })).toMatchObject({ status: 'info', detail: 'none' })
    expect(signatureCheck({ checkedFrom: 1, signed: 9, problems: 2, firstProblem: 4, signedFrom: 1 })).toMatchObject({ status: 'fail', detail: 'problems', facts: { problems: 2, firstProblem: 4 }, action: 'audit', adminOnly: true })
  })

  it('shows the signatures only to people who may read the audit log', async () => {
    const { founder } = await household()
    const alice = await signIn(ALICE)
    const signatures = { checkedFrom: 1, signed: 3, problems: 0, firstProblem: null, signedFrom: 1 }
    const context = { saveState: 'saved' as const, weak: false, archives: 0, deviceMark: null, recordedHead: null, signatures }
    expect(collectVaultFacts(founder, context).signatures).toEqual(signatures)
    expect(collectVaultFacts(alice, context).signatures).toBeNull()
  })
})
