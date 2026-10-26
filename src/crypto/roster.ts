import type { FounderRef } from '../db/keys-header'
import { canonicalize } from './canonical'
import { LABELS, fingerprintOf, isBase64, sha256HexOf, signPayload, verifyPayload } from './sign'
import { SUITE, type Suite } from './suite'

/**
 * The signed member list (docs/design/v2.0-key-redesign.md, 3.7 and 3.8). Each version names everyone who may sign in,
 * with their role, group and public keys, and is signed by an admin of the version before it, back to version 1,
 * which the founder signs. A member's keys enter the roster only through an invite: the redeemed key binding, signed
 * by the invite key the admin's roster named and by the member's new key, travels into the version that makes the
 * member active, so the chain stays checkable after the binding row is gone.
 */

export const ROSTER_ROLES = ['Admin', 'Manager', 'Viewer'] as const
export type RosterRole = (typeof ROSTER_ROLES)[number]

/** Generous: removed members stay listed, so their earlier signatures remain attributable. */
export const MAX_ROSTER_MEMBERS = 4096

/** The two signatures of a redeemed invite, kept in the roster entry it turned into. */
export type BindingProof = { rosterVersion: number; at: string; inviteSig: string; memberSig: string }

type MemberBase = { id: string; email: string; role: RosterRole; group: number | null }
export type ActiveMember = MemberBase & { status: 'active'; encPub: string; sigPub: string; proof?: BindingProof }
export type InvitedMember = MemberBase & { status: 'invited'; inviteSigPub: string; inviteExpiresAt: string }
export type RemovedMember = MemberBase & { status: 'removed'; encPub?: string; sigPub?: string }
export type RosterMember = ActiveMember | InvitedMember | RemovedMember

/**
 * Where the audit log stood for the save that signed a version (from 2.0.0-rc.2): `from` is the first entry that must
 * be signed, which never changes once a version names it, and `through` and `hash` are the last entry of the log that
 * save stored, with its chain hash. Admin-signed, so a member who edits the database cannot move the start of the
 * signed log or cut entries up to there unnoticed (design 3.7 as built).
 */
export type RosterAudit = { from: number; through: number; hash: string }

export type RosterBody = {
  type: 'roster'
  suite: Suite
  vaultId: string
  version: number
  prev: string | null
  epoch: number
  issuedAt: string
  issuedBy: string
  members: RosterMember[]
  audit?: RosterAudit
}

export type RosterDoc = RosterBody & { sig: string }

export type KeyBindingBody = {
  type: 'binding'
  suite: Suite
  vaultId: string
  memberId: string
  rosterVersion: number
  inviteSigPub: string
  encPub: string
  sigPub: string
  at: string
}

export type KeyBinding = KeyBindingBody & { inviteSig: string; memberSig: string }

export type { FounderRef }

export type RosterProblem = 'BROKEN' | 'FOUNDER'

const ID = /^[A-Za-z0-9_-]{1,64}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const HEX64 = /^[0-9a-f]{64}$/

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function hasExactly(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value)
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => required.includes(key) || optional.includes(key))
}

const isEmail = (value: unknown): value is string => typeof value === 'string' && value.length >= 3 && value.length <= 254 && value === value.toLowerCase()
const isGroup = (value: unknown): value is number | null => value === null || (Number.isSafeInteger(value) && (value as number) >= 1)
const isPositive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1
const isRole = (value: unknown): value is RosterRole => (ROSTER_ROLES as readonly unknown[]).includes(value)

function isProof(value: unknown): value is BindingProof {
  return (
    isPlain(value) &&
    hasExactly(value, ['rosterVersion', 'at', 'inviteSig', 'memberSig']) &&
    isPositive(value.rosterVersion) &&
    typeof value.at === 'string' &&
    ISO.test(value.at) &&
    isBase64(value.inviteSig, 64) &&
    isBase64(value.memberSig, 64)
  )
}

function isMember(value: unknown): value is RosterMember {
  if (!isPlain(value)) return false
  const base = typeof value.id === 'string' && ID.test(value.id) && isEmail(value.email) && isRole(value.role) && isGroup(value.group)
  if (!base) return false
  const common = ['id', 'email', 'role', 'group', 'status']
  switch (value.status) {
    case 'active':
      return hasExactly(value, [...common, 'encPub', 'sigPub'], ['proof']) && isBase64(value.encPub, 32) && isBase64(value.sigPub, 32) && (value.proof === undefined || isProof(value.proof))
    case 'invited':
      return (
        hasExactly(value, [...common, 'inviteSigPub', 'inviteExpiresAt']) &&
        isBase64(value.inviteSigPub, 32) &&
        typeof value.inviteExpiresAt === 'string' &&
        ISO.test(value.inviteExpiresAt)
      )
    case 'removed':
      return (
        hasExactly(value, common, ['encPub', 'sigPub']) &&
        (value.encPub === undefined || isBase64(value.encPub, 32)) &&
        (value.sigPub === undefined || isBase64(value.sigPub, 32))
      )
    default:
      return false
  }
}

function isRosterAudit(value: unknown): value is RosterAudit {
  return (
    isPlain(value) &&
    hasExactly(value, ['from', 'through', 'hash']) &&
    isPositive(value.from) &&
    Number.isSafeInteger(value.through) &&
    (value.through as number) >= (value.from as number) &&
    typeof value.hash === 'string' &&
    HEX64.test(value.hash)
  )
}

/** A roster version as stored, or null when anything about its shape is off. Signatures are checked separately. */
export function readRosterDoc(value: unknown): RosterDoc | null {
  if (!isPlain(value)) return null
  if (!hasExactly(value, ['type', 'suite', 'vaultId', 'version', 'prev', 'epoch', 'issuedAt', 'issuedBy', 'members', 'sig'], ['audit'])) return null
  if (value.audit !== undefined && !isRosterAudit(value.audit)) return null
  if (value.type !== 'roster' || value.suite !== SUITE || typeof value.vaultId !== 'string' || !ID.test(value.vaultId)) return null
  if (!isPositive(value.version) || !isPositive(value.epoch)) return null
  if (value.version === 1 ? value.prev !== null : typeof value.prev !== 'string' || !HEX64.test(value.prev)) return null
  if (typeof value.issuedAt !== 'string' || !ISO.test(value.issuedAt) || typeof value.issuedBy !== 'string' || !ID.test(value.issuedBy)) return null
  if (!isBase64(value.sig, 64) || !Array.isArray(value.members) || value.members.length > MAX_ROSTER_MEMBERS) return null
  if (!value.members.every(isMember)) return null
  const members = value.members as RosterMember[]
  if (new Set(members.map((member) => member.id)).size !== members.length) return null
  const current = members.filter((member) => member.status !== 'removed')
  if (new Set(current.map((member) => member.email)).size !== current.length) return null
  return value as unknown as RosterDoc
}

export function readKeyBinding(value: unknown): KeyBinding | null {
  if (!isPlain(value)) return null
  if (!hasExactly(value, ['type', 'suite', 'vaultId', 'memberId', 'rosterVersion', 'inviteSigPub', 'encPub', 'sigPub', 'at', 'inviteSig', 'memberSig'])) return null
  if (value.type !== 'binding' || value.suite !== SUITE || typeof value.vaultId !== 'string' || !ID.test(value.vaultId)) return null
  if (typeof value.memberId !== 'string' || !ID.test(value.memberId) || !isPositive(value.rosterVersion)) return null
  if (!isBase64(value.inviteSigPub, 32) || !isBase64(value.encPub, 32) || !isBase64(value.sigPub, 32)) return null
  if (typeof value.at !== 'string' || !ISO.test(value.at) || !isBase64(value.inviteSig, 64) || !isBase64(value.memberSig, 64)) return null
  return value as unknown as KeyBinding
}

function body(doc: RosterDoc): RosterBody {
  const { sig: _sig, ...rest } = doc
  return rest
}

export function rosterHash(doc: RosterDoc): Promise<string> {
  return sha256HexOf(new TextEncoder().encode(canonicalize(doc)))
}

export async function signRoster(rosterBody: RosterBody, sigPriv: CryptoKey): Promise<RosterDoc> {
  return { ...rosterBody, sig: await signPayload(LABELS.roster, rosterBody, sigPriv) }
}

export function bindingBody(binding: KeyBinding | KeyBindingBody): KeyBindingBody {
  return {
    type: 'binding',
    suite: binding.suite,
    vaultId: binding.vaultId,
    memberId: binding.memberId,
    rosterVersion: binding.rosterVersion,
    inviteSigPub: binding.inviteSigPub,
    encPub: binding.encPub,
    sigPub: binding.sigPub,
    at: binding.at,
  }
}

/** Signed by the invite key the roster names and by the member's new signing key, over the same bytes. */
export async function signBinding(bindingFields: KeyBindingBody, inviteSigPriv: CryptoKey, memberSigPriv: CryptoKey): Promise<KeyBinding> {
  const signed = bindingBody(bindingFields)
  const [inviteSig, memberSig] = await Promise.all([signPayload(LABELS.binding, signed, inviteSigPriv), signPayload(LABELS.binding, signed, memberSigPriv)])
  return { ...signed, inviteSig, memberSig }
}

async function bindingSignaturesHold(signed: KeyBindingBody, inviteSig: string, memberSig: string): Promise<boolean> {
  const [invite, member] = await Promise.all([
    verifyPayload(LABELS.binding, signed, inviteSig, signed.inviteSigPub),
    verifyPayload(LABELS.binding, signed, memberSig, signed.sigPub),
  ])
  return invite && member
}

/** True when `binding` redeems the invite `invited` names, for this vault, with both signatures valid. */
export async function bindingRedeems(binding: KeyBinding, invited: RosterMember | undefined, vaultId: string): Promise<boolean> {
  if (!invited || invited.status !== 'invited' || binding.vaultId !== vaultId || binding.suite !== SUITE) return false
  if (binding.memberId !== invited.id || binding.inviteSigPub !== invited.inviteSigPub) return false
  return bindingSignaturesHold(bindingBody(binding), binding.inviteSig, binding.memberSig)
}

/** The binding a `proof` stands for, rebuilt from the entry it made active and the invite before it. */
function proofBinding(member: ActiveMember, invited: InvitedMember, vaultId: string): KeyBindingBody {
  return {
    type: 'binding',
    suite: SUITE,
    vaultId,
    memberId: member.id,
    rosterVersion: member.proof!.rosterVersion,
    inviteSigPub: invited.inviteSigPub,
    encPub: member.encPub,
    sigPub: member.sigPub,
    at: member.proof!.at,
  }
}

function byId(doc: RosterBody): Map<string, RosterMember> {
  return new Map(doc.members.map((member) => [member.id, member]))
}

/** Every active member of `next` must have been active in `before` with the same keys, or redeemed an invite of `before`. */
async function keysAccountedFor(next: RosterBody, before: RosterBody): Promise<boolean> {
  const previous = byId(before)
  for (const member of next.members) {
    if (member.status !== 'active') continue
    const was = previous.get(member.id)
    if (was?.status === 'active' && was.encPub === member.encPub && was.sigPub === member.sigPub && member.proof === undefined) continue
    if (was?.status !== 'invited' || member.proof === undefined || member.proof.rosterVersion > before.version) return false
    const signed = proofBinding(member, was, next.vaultId)
    if (!(await bindingSignaturesHold(signed, member.proof.inviteSig, member.proof.memberSig))) return false
  }
  return true
}

/** The key that may sign `next`: an Admin active in `before`, or an Admin who becomes active in `next` by redeeming an invite of `before`. */
function signerKey(next: RosterBody, before: RosterBody): string | null {
  const was = byId(before).get(next.issuedBy)
  if (was?.status === 'active' && was.role === 'Admin') return was.sigPub
  const now = byId(next).get(next.issuedBy)
  if (was?.status === 'invited' && was.role === 'Admin' && now?.status === 'active' && now.role === 'Admin' && now.proof !== undefined) return now.sigPub
  return null
}

export type VerifiedChain = { latest: RosterDoc; latestHash: string; founder: FounderRef }

/**
 * Checks the whole chain: versions 1..n without gaps, each linked to the hash of the one before, version 1 signed by
 * the founder who is its one active Admin, every later version signed by an admin of the version before, and every
 * member's keys accounted for. Returns the latest version, its hash and the founder, or the problem.
 */
export async function verifyRosterChain(docs: readonly RosterDoc[], vaultId: string): Promise<VerifiedChain | { problem: RosterProblem }> {
  if (docs.length === 0) return { problem: 'BROKEN' }
  let previousHash: string | null = null
  let founder: FounderRef | null = null
  for (let index = 0; index < docs.length; index += 1) {
    const doc = docs[index]
    if (doc.version !== index + 1 || doc.vaultId !== vaultId || doc.prev !== previousHash) return { problem: 'BROKEN' }
    if (index === 0) {
      const only = doc.members
      const first = only[0]
      if (only.length !== 1 || first.status !== 'active' || first.role !== 'Admin' || first.id !== doc.issuedBy || first.proof !== undefined) return { problem: 'FOUNDER' }
      if (!(await verifyPayload(LABELS.roster, body(doc), doc.sig, first.sigPub))) return { problem: 'FOUNDER' }
      founder = { memberId: first.id, sigPub: first.sigPub, fingerprint: await fingerprintOf(first.sigPub) }
    } else {
      const before = docs[index - 1]
      if (doc.epoch < before.epoch) return { problem: 'BROKEN' }
      // Once a version anchors the audit log, every later one keeps its start and never goes back on its end.
      if (before.audit && (!doc.audit || doc.audit.from !== before.audit.from || doc.audit.through < before.audit.through)) return { problem: 'BROKEN' }
      const key = signerKey(doc, before)
      if (!key || !(await verifyPayload(LABELS.roster, body(doc), doc.sig, key))) return { problem: 'BROKEN' }
      if (!(await keysAccountedFor(doc, before))) return { problem: 'BROKEN' }
    }
    previousHash = await rosterHash(doc)
  }
  return { latest: docs[docs.length - 1], latestHash: previousHash!, founder: founder! }
}

export type EffectiveMember = { id: string; email: string; role: RosterRole; group: number | null; encPub: string; sigPub: string; binding?: KeyBinding }

/**
 * Who is active now: the latest version's active members, plus every invited member whose key binding is valid.
 * Returns null when any binding is not valid for the latest version, which blocks the vault like a broken chain.
 */
export async function effectiveMembers(latest: RosterDoc, bindings: readonly KeyBinding[]): Promise<Map<string, EffectiveMember> | null> {
  const members = byId(latest)
  const active = new Map<string, EffectiveMember>()
  for (const member of latest.members) {
    if (member.status === 'active') active.set(member.id, { id: member.id, email: member.email, role: member.role, group: member.group, encPub: member.encPub, sigPub: member.sigPub })
  }
  for (const binding of bindings) {
    const invited = members.get(binding.memberId)
    if (active.has(binding.memberId) || !(await bindingRedeems(binding, invited, latest.vaultId))) return null
    const entry = invited as InvitedMember
    active.set(binding.memberId, { id: entry.id, email: entry.email, role: entry.role, group: entry.group, encPub: binding.encPub, sigPub: binding.sigPub, binding })
  }
  return active
}

/** A person as the database has them, for deriving the next roster version. */
export type RosterCandidate = {
  id: string
  email: string
  role: RosterRole
  group: number | null
  /** ACTIVE in `user_profile`; suspended and former members leave the roster. */
  active: boolean
  /** Holds an identity blob and a DEK wrap in the header. */
  sealed: boolean
}

/** An open invite or re-invite, keyed by the member id it is for: the grant id for a new person, the user id otherwise. */
export type RosterInvite = { memberId: string; email: string; role: RosterRole; group: number | null; inviteSigPub: string; inviteExpiresAt: string }

function sameMembers(left: readonly RosterMember[], right: readonly RosterMember[]): boolean {
  const strip = (members: readonly RosterMember[]) => members.map((member) => (member.status === 'active' ? { ...member, proof: undefined } : member))
  return canonicalize(strip(left)) === canonicalize(strip(right))
}

/**
 * The members an admin's save should sign, from the latest version, the valid bindings, the people in the database
 * and the open invites. An open invite makes a person invited (a re-invite of an active member takes their keys away
 * until they redeem it); a valid binding makes them active with its proof; anyone who leaves the roster is kept as
 * removed. Returns null when nothing changed.
 */
export function nextRosterMembers(input: {
  latest: RosterDoc
  bindings: ReadonlyMap<string, KeyBinding>
  people: readonly RosterCandidate[]
  invites: readonly RosterInvite[]
}): RosterMember[] | null {
  const previous = byId(input.latest)
  const people = new Map(input.people.map((person) => [person.id, person]))
  const invites = new Map(input.invites.map((invite) => [invite.memberId, invite]))
  const ids = [...new Set([...previous.keys(), ...people.keys(), ...invites.keys()])].sort()
  const members: RosterMember[] = []
  for (const id of ids) {
    const was = previous.get(id)
    const person = people.get(id)
    const invite = invites.get(id)
    const binding = input.bindings.get(id)
    if (invite) {
      const role = person?.role ?? invite.role
      const group = person ? person.group : invite.group
      members.push({ id, email: person?.email ?? invite.email, role, group, status: 'invited', inviteSigPub: invite.inviteSigPub, inviteExpiresAt: invite.inviteExpiresAt })
      continue
    }
    if (person?.active && person.sealed) {
      if (was?.status === 'active') {
        members.push({ id, email: person.email, role: person.role, group: person.group, status: 'active', encPub: was.encPub, sigPub: was.sigPub })
        continue
      }
      if (was?.status === 'invited' && binding) {
        const proof: BindingProof = { rosterVersion: binding.rosterVersion, at: binding.at, inviteSig: binding.inviteSig, memberSig: binding.memberSig }
        members.push({ id, email: person.email, role: person.role, group: person.group, status: 'active', encPub: binding.encPub, sigPub: binding.sigPub, proof })
        continue
      }
    }
    if (was) {
      if (was.status === 'removed') {
        members.push(was)
        continue
      }
      const keys = was.status === 'active' ? { encPub: was.encPub, sigPub: was.sigPub } : {}
      members.push({ id, email: was.email, role: was.role, group: was.group, status: 'removed', ...keys })
    }
  }
  return sameMembers(members, input.latest.members) ? null : members
}
