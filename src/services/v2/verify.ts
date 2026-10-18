import { effectiveMembers, verifyRosterChain, type EffectiveMember, type KeyBinding, type RosterDoc } from '../../crypto/roster'
import type { KeysRecord } from '../../db/envelope'
import { verifyHeader } from '../../db/header-sig'
import type { SqlDatabase } from '../../db/sqlite'
import { KeysBlockedError } from '../../domain/errors'
import { readBindings, readPeople, readRosterDocs } from './roster-store'
import { pinnedFounder, rosterSeen } from './session'
import { chainHashes, keptTail, tailPosition } from './tail'

export type VerifiedVault = {
  latest: RosterDoc
  latestHash: string
  members: Map<string, EffectiveMember>
  bindings: KeyBinding[]
  /** The founder key was not pinned in this browser yet. */
  firstSeen: boolean
  /** The roster is older than the newest version this browser saw, and the caller accepted that. */
  rolledBack: boolean
  /** Everyone who holds or held the current epoch's DEK (see `KeysSession.holders`). */
  holders: string[]
}

/** Who is opening the vault: a member with their unsealed public keys, or an invitee with the invite key they derived. */
export type Opener = { memberId: string; encPub: string; sigPub: string; invite?: undefined } | { memberId: string; invite: { sigPub: string }; encPub?: undefined; sigPub?: undefined }

/**
 * The unlock checks of design 3.8, steps 1–5, on a record whose body has already been opened with the DEK (step 7,
 * which authenticates it, so nothing here reads unauthenticated bytes). Each failure blocks with its own code; the
 * caller must close `db` and open no session.
 */
export async function verifyKeysVault(record: KeysRecord, db: SqlDatabase, opener: Opener, options: { acceptRollback?: boolean } = {}): Promise<VerifiedVault> {
  const { keys } = record
  // 1. The founder this browser pinned, if it pinned one.
  const pinned = pinnedFounder(keys.vaultId)
  if (pinned !== null && pinned !== keys.founder.sigPub) throw new KeysBlockedError('KEYS_FOUNDER_MISMATCH')

  // 3. The roster chain, back to the founder, and the header's references to it.
  const docs = await readRosterDocs(db)
  if (!docs) throw new KeysBlockedError('KEYS_ROSTER_BROKEN')
  const chain = await verifyRosterChain(docs, keys.vaultId)
  if ('problem' in chain) throw new KeysBlockedError('KEYS_ROSTER_BROKEN')
  if (chain.founder.memberId !== keys.founder.memberId || chain.founder.sigPub !== keys.founder.sigPub || chain.founder.fingerprint !== keys.founder.fingerprint) {
    throw new KeysBlockedError('KEYS_HEADER_INVALID')
  }
  if (keys.roster.version !== chain.latest.version || keys.roster.hash !== chain.latestHash) throw new KeysBlockedError('KEYS_HEADER_INVALID')
  const bindings = readBindings(db)
  if (!bindings) throw new KeysBlockedError('KEYS_ROSTER_BROKEN')
  const members = await effectiveMembers(chain.latest, bindings)
  if (!members) throw new KeysBlockedError('KEYS_ROSTER_BROKEN')
  // Everyone the roster lets in must be in the database with the same email, role and group, and not suspended.
  const people = new Map(readPeople(db).map((person) => [person.id, person]))
  for (const member of members.values()) {
    const person = people.get(member.id)
    if (!person || person.email !== member.email || person.role !== member.role || person.group !== member.group || person.status !== 'ACTIVE') {
      throw new KeysBlockedError('KEYS_ROSTER_BROKEN')
    }
  }

  // 2. The header is signed by someone the roster lets in.
  const signer = members.get(keys.sig.by)
  if (!signer || !(await verifyHeader(record, signer.sigPub))) throw new KeysBlockedError('KEYS_HEADER_INVALID')

  // 4. The person opening it is still in, with the keys they hold; an invitee holds the invite the roster names.
  if (opener.invite) {
    const invited = chain.latest.members.find((member) => member.id === opener.memberId)
    if (invited?.status !== 'invited' || invited.inviteSigPub !== opener.invite.sigPub || members.has(opener.memberId)) throw new KeysBlockedError('KEYS_REMOVED')
  } else {
    const me = members.get(opener.memberId)
    if (!me || me.encPub !== opener.encPub || me.sigPub !== opener.sigPub) throw new KeysBlockedError('KEYS_REMOVED')
  }

  // 5. One epoch everywhere; the opener's wrap was already unwrapped for the header's epoch.
  if (keys.epoch !== chain.latest.epoch) throw new KeysBlockedError('KEYS_EPOCH_MISMATCH')

  // The rollback check comes last so that an admin can be offered to open an older copy only of a vault that passed the
  // rest. A copy is older when its roster is behind what this browser saw: an older version, or a fork of it, however
  // high its own version numbers go (design 3.8 step 3, 4.10).
  const seen = rosterSeen(keys.vaultId)
  const rolledBack = tailPosition(chain.latest.version, chainHashes(db), await keptTail(keys.vaultId), seen).behind
  if (rolledBack) {
    const admin = !opener.invite && members.get(opener.memberId)?.role === 'Admin'
    if (!options.acceptRollback || !admin) throw new KeysBlockedError('KEYS_ROSTER_ROLLBACK', { seen, current: chain.latest.version })
  }
  return { latest: chain.latest, latestHash: chain.latestHash, members, bindings, firstSeen: pinned === null, rolledBack, holders: epochHolders(docs, chain.latest.epoch, bindings) }
}

/** Members active in any version of `epoch`, and everyone with a key binding: each of them unwrapped that epoch's DEK. */
export function epochHolders(docs: readonly RosterDoc[], epoch: number, bindings: readonly KeyBinding[]): string[] {
  const holders = new Set<string>()
  for (const doc of docs) {
    if (doc.epoch !== epoch) continue
    for (const member of doc.members) if (member.status === 'active') holders.add(member.id)
  }
  for (const binding of bindings) holders.add(binding.memberId)
  return [...holders].sort()
}
