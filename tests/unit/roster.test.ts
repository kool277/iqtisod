import { describe, expect, it } from 'vitest'
import {
  effectiveMembers,
  nextRosterMembers,
  readRosterDoc,
  rosterHash,
  signBinding,
  signRoster,
  verifyRosterChain,
  type KeyBinding,
  type RosterBody,
  type RosterDoc,
  type RosterMember,
} from '../../src/crypto/roster'
import { exportPub } from '../../src/crypto/sign'
import { SUITE } from '../../src/crypto/suite'

const VAULT = 'vault-r'
const AT = '2026-10-16T10:00:00.000Z'

type Keys = { sigPriv: CryptoKey; sigPub: string; encPub: string }

async function keys(): Promise<Keys> {
  const sig = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const enc = (await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair
  return { sigPriv: sig.privateKey, sigPub: await exportPub(sig.publicKey), encPub: await exportPub(enc.publicKey) }
}

const active = (id: string, k: Keys, role: RosterMember['role'] = 'Admin', group: number | null = null): RosterMember => ({
  id,
  email: `${id}@roster.test`,
  role,
  group,
  status: 'active',
  encPub: k.encPub,
  sigPub: k.sigPub,
})

function bodyOf(version: number, prev: string | null, issuedBy: string, members: RosterMember[]): RosterBody {
  return { type: 'roster', suite: SUITE, vaultId: VAULT, version, prev, epoch: 1, issuedAt: AT, issuedBy, members }
}

/** Founder `a`; version 2 invites `b` as a Manager; `b` redeems; version 3, signed by `a`, folds the binding in. */
async function household() {
  const a = await keys()
  const b = await keys()
  const invite = await keys()
  const v1 = await signRoster(bodyOf(1, null, 'a', [active('a', a)]), a.sigPriv)
  const invited: RosterMember = { id: 'b', email: 'b@roster.test', role: 'Manager', group: 1, status: 'invited', inviteSigPub: invite.sigPub, inviteExpiresAt: '2026-10-17T10:00:00.000Z' }
  const v2 = await signRoster(bodyOf(2, await rosterHash(v1), 'a', [active('a', a), invited]), a.sigPriv)
  const binding = await signBinding(
    { type: 'binding', suite: SUITE, vaultId: VAULT, memberId: 'b', rosterVersion: 2, inviteSigPub: invite.sigPub, encPub: b.encPub, sigPub: b.sigPub, at: AT },
    invite.sigPriv,
    b.sigPriv,
  )
  const folded: RosterMember = { ...active('b', b, 'Manager', 1), proof: { rosterVersion: 2, at: AT, inviteSig: binding.inviteSig, memberSig: binding.memberSig } } as RosterMember
  const v3 = await signRoster(bodyOf(3, await rosterHash(v2), 'a', [active('a', a), folded]), a.sigPriv)
  return { a, b, invite, v1, v2, v3, binding, invited }
}

async function resign(doc: RosterDoc, change: (body: RosterBody) => void, key: CryptoKey): Promise<RosterDoc> {
  const { sig: _sig, ...body } = structuredClone(doc)
  change(body)
  return signRoster(body, key)
}

describe('roster chain', () => {
  it('accepts a chain from the founder, through an invite, to the redeemed member', async () => {
    const { a, v1, v2, v3 } = await household()
    const chain = await verifyRosterChain([v1, v2, v3], VAULT)
    expect('problem' in chain).toBe(false)
    if ('problem' in chain) return
    expect(chain.latest.version).toBe(3)
    expect(chain.founder.sigPub).toBe(a.sigPub)
    expect(chain.latestHash).toBe(await rosterHash(v3))
    for (const doc of [v1, v2, v3]) expect(readRosterDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc)
  })

  it('refuses any edited, reordered, missing or wrongly signed version', async () => {
    const { a, b, v1, v2, v3 } = await household()
    const flipped = structuredClone(v2)
    flipped.members[1].email = 'x@roster.test'
    const byManager = await resign(v3, () => undefined, b.sigPriv)
    const wrongPrev = await resign(v2, (body) => (body.prev = 'f'.repeat(64)), a.sigPriv)
    const otherVault = await resign(v2, (body) => (body.vaultId = 'vault-x'), a.sigPriv)
    const rolledEpoch = await resign(v2, (body) => (body.epoch = 0 as number), a.sigPriv)
    for (const [label, docs] of Object.entries({
      flipped: [v1, flipped, v3],
      byManager: [v1, v2, byManager],
      gap: [v1, v3],
      reordered: [v2, v1, v3],
      wrongPrev: [v1, wrongPrev],
      otherVault: [v1, otherVault],
      rolledEpoch: [v1, rolledEpoch],
      empty: [],
    })) {
      expect('problem' in (await verifyRosterChain(docs, VAULT)), label).toBe(true)
    }
  })

  it('refuses a first version that is not the founder alone, signed by the founder', async () => {
    const { a, b } = await household()
    const two = await signRoster(bodyOf(1, null, 'a', [active('a', a), active('b', b, 'Viewer', 1)]), a.sigPriv)
    const manager = await signRoster(bodyOf(1, null, 'a', [active('a', a, 'Manager', 1)]), a.sigPriv)
    const signedByOther = await signRoster(bodyOf(1, null, 'a', [active('a', a)]), b.sigPriv)
    for (const doc of [two, manager, signedByOther]) expect(await verifyRosterChain([doc], VAULT)).toEqual({ problem: 'FOUNDER' })
  })

  it('refuses keys that enter the roster without the invite that admits them', async () => {
    const { a, b, v1, v2 } = await household()
    const smuggled = await signRoster(bodyOf(3, await rosterHash(v2), 'a', [active('a', a), active('b', b, 'Manager', 1)]), a.sigPriv)
    expect('problem' in (await verifyRosterChain([v1, v2, smuggled], VAULT))).toBe(true)
    const intruder = await keys()
    const replaced = await signRoster(bodyOf(2, await rosterHash(v1), 'a', [active('a', intruder)]), a.sigPriv)
    expect('problem' in (await verifyRosterChain([v1, replaced], VAULT))).toBe(true)
  })

  it('lets an invited admin sign the version that admits them, with their proof in it', async () => {
    const a = await keys()
    const c = await keys()
    const invite = await keys()
    const v1 = await signRoster(bodyOf(1, null, 'a', [active('a', a)]), a.sigPriv)
    const v2 = await signRoster(
      bodyOf(2, await rosterHash(v1), 'a', [active('a', a), { id: 'c', email: 'c@roster.test', role: 'Admin', group: null, status: 'invited', inviteSigPub: invite.sigPub, inviteExpiresAt: AT }]),
      a.sigPriv,
    )
    const binding = await signBinding(
      { type: 'binding', suite: SUITE, vaultId: VAULT, memberId: 'c', rosterVersion: 2, inviteSigPub: invite.sigPub, encPub: c.encPub, sigPub: c.sigPub, at: AT },
      invite.sigPriv,
      c.sigPriv,
    )
    const self = { ...active('c', c), proof: { rosterVersion: 2, at: AT, inviteSig: binding.inviteSig, memberSig: binding.memberSig } } as RosterMember
    const v3 = await signRoster(bodyOf(3, await rosterHash(v2), 'c', [active('a', a), self]), c.sigPriv)
    expect('problem' in (await verifyRosterChain([v1, v2, v3], VAULT))).toBe(false)
    const forged = { ...self, proof: { ...(self as { proof: object }).proof, memberSig: binding.inviteSig } } as RosterMember
    const v3bad = await signRoster(bodyOf(3, await rosterHash(v2), 'c', [active('a', a), forged]), c.sigPriv)
    expect('problem' in (await verifyRosterChain([v1, v2, v3bad], VAULT))).toBe(true)
  })
})

describe('the audit anchor in the roster', () => {
  const H = (digit: string) => digit.repeat(64)

  async function anchored(first: RosterBody['audit'], second: RosterBody['audit'] | undefined) {
    const a = await keys()
    const v1 = await signRoster({ ...bodyOf(1, null, 'a', [active('a', a)]), audit: first }, a.sigPriv)
    const body = bodyOf(2, await rosterHash(v1), 'a', [active('a', a)])
    const v2 = await signRoster(second ? { ...body, audit: second } : body, a.sigPriv)
    return verifyRosterChain([v1, v2], VAULT)
  }

  it('keeps where the signed log starts, and never lets its recorded end go back', async () => {
    expect('problem' in (await anchored({ from: 1, through: 3, hash: H('a') }, { from: 1, through: 9, hash: H('b') }))).toBe(false)
    expect(await anchored({ from: 1, through: 3, hash: H('a') }, undefined)).toEqual({ problem: 'BROKEN' })
    expect(await anchored({ from: 1, through: 3, hash: H('a') }, { from: 2, through: 9, hash: H('b') })).toEqual({ problem: 'BROKEN' })
    expect(await anchored({ from: 1, through: 3, hash: H('a') }, { from: 1, through: 2, hash: H('b') })).toEqual({ problem: 'BROKEN' })
  })

  it('reads only a well-formed anchor', async () => {
    const a = await keys()
    const doc = await signRoster({ ...bodyOf(1, null, 'a', [active('a', a)]), audit: { from: 1, through: 1, hash: H('c') } }, a.sigPriv)
    expect(readRosterDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc)
    for (const audit of [{ from: 0, through: 1, hash: H('c') }, { from: 2, through: 1, hash: H('c') }, { from: 1, through: 1, hash: 'xyz' }, { from: 1, through: 1 }, { from: 1, through: 1, hash: H('c'), more: 1 }]) {
      expect(readRosterDoc({ ...JSON.parse(JSON.stringify(doc)), audit }), JSON.stringify(audit)).toBeNull()
    }
  })
})

describe('effective roster', () => {
  it('adds a redeemed invite with a valid binding and refuses any other binding', async () => {
    const { b, v2, binding } = await household()
    const members = await effectiveMembers(v2, [binding])
    expect(members?.get('b')?.sigPub).toBe(b.sigPub)
    const wrongInvite = { ...binding, inviteSigPub: b.sigPub } as KeyBinding
    const notInvited = { ...binding, memberId: 'a' } as KeyBinding
    const badSig = { ...binding, memberSig: binding.inviteSig } as KeyBinding
    for (const bad of [wrongInvite, notInvited, badSig]) expect(await effectiveMembers(v2, [bad])).toBeNull()
  })
})

describe('next roster version', () => {
  it('signs nothing when nothing changed, and records role changes, invites, folds and removals', async () => {
    const { b, v2, v3, binding } = await household()
    const people = [
      { id: 'a', email: 'a@roster.test', role: 'Admin' as const, group: null, active: true, sealed: true },
      { id: 'b', email: 'b@roster.test', role: 'Manager' as const, group: 1, active: true, sealed: true },
    ]
    expect(nextRosterMembers({ latest: v3, bindings: new Map(), people, invites: [] })).toBeNull()

    const promoted = nextRosterMembers({ latest: v3, bindings: new Map(), people: [people[0], { ...people[1], role: 'Admin' }], invites: [] })
    expect(promoted?.find((member) => member.id === 'b')?.role).toBe('Admin')

    const folded = nextRosterMembers({ latest: v2, bindings: new Map([['b', binding]]), people, invites: [] })
    const entry = folded?.find((member) => member.id === 'b')
    expect(entry).toMatchObject({ status: 'active', sigPub: b.sigPub, proof: { rosterVersion: 2 } })

    const suspended = nextRosterMembers({ latest: v3, bindings: new Map(), people: [people[0], { ...people[1], active: false }], invites: [] })
    expect(suspended?.find((member) => member.id === 'b')).toMatchObject({ status: 'removed', sigPub: b.sigPub })

    const invited = nextRosterMembers({
      latest: v3,
      bindings: new Map(),
      people,
      invites: [{ memberId: 'n', email: 'n@roster.test', role: 'Viewer', group: 1, inviteSigPub: b.encPub, inviteExpiresAt: AT }],
    })
    expect(invited?.find((member) => member.id === 'n')).toMatchObject({ status: 'invited', role: 'Viewer' })
    // A proof in the latest version is not a change on its own.
    expect(nextRosterMembers({ latest: v3, bindings: new Map(), people, invites: [] })).toBeNull()
  })
})
