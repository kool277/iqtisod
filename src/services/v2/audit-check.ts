import { auditSigBody, verifyAuditEntry, type AuditSig } from '../../crypto/audit-sign'
import { bindingRedeems, readKeyBinding, type KeyBinding, type RosterDoc, type RosterRole } from '../../crypto/roster'
import { GENESIS_HASH, auditHash, compareAuditHead, readAuditRows, type AuditRow } from '../../db/audit-chain'
import type { SqlDatabase } from '../../db/sqlite'
import { ForbiddenError } from '../../domain/errors'
import type { OpenVault } from '../../domain/types'
import { parseJsonSafely } from '../../lib/safe-json'
import { Permission, canUser } from '../../rbac'
import { auditActionAllowed } from '../../rbac/audit-policy'
import { readAuditSeen, sigOf, sigsDigest, sigsUpTo, type AuditCheckpoint, type KeptCheckpoint } from './audit-seen'
import { readBindings, readRosterDocs } from './roster-store'
import type { KeysSession } from './session'

export type { AuditCheckpoint }

/**
 * The signature check of the audit log (docs/design/v2.0-key-redesign.md, 3.8 step 6). From the first signed entry on,
 * every entry must be signed by its actor, with the key the roster version it names gives them, and their role there
 * must allow the action. A problem warns and blocks nothing: the log only records what the app did, and an admin can
 * still look into it. Entries before the first signed one were written before signatures (1.x, or 2.0 before its RC).
 */

export type AuditSigProblem =
  /** The hash chain breaks here: the entry was edited, or one before it removed or reordered. */
  | 'CHAIN'
  /** No signature, although signing had started. */
  | 'UNSIGNED'
  | 'SIGNATURE'
  /** The signer has no key in the roster version the entry names: never a member, removed, or an unknown key. */
  | 'SIGNER'
  /** Signed by someone other than the person the entry names as its actor. */
  | 'ACTOR'
  /** The signer's role in that roster version does not allow the action. */
  | 'ROLE'
  /** Names an older roster version than an entry before it, one that does not exist, or another epoch than it has. */
  | 'ORDER'
  /** A signature for an entry that is not in the log. */
  | 'ORPHAN'

export type AuditCheckInput = {
  vaultId: string
  /** The entries after `from.seq`, or every entry, in order. */
  rows: readonly AuditRow[]
  /** The signatures of those entries and of any later seq. */
  sigs: readonly AuditSig[]
  /** The lowest seq with a signature anywhere in the log, which is the bridge; null when nothing is signed. */
  firstSigned: number | null
  /** The vault's roster chain as the sign-in checks verified it, version 1 first. */
  roster: readonly RosterDoc[]
  bindings: readonly KeyBinding[]
  /** The key bindings the log's `INVITE_ACCEPTED` and `RESET_COMPLETED` entries carry, from the whole log. */
  redeemed: readonly KeyBinding[]
  from?: AuditCheckpoint
  /** The first signed entry this browser saw in this log before: from there on every entry must be signed. */
  seenSignedFrom?: number | null
}

export type AuditCheckReport = {
  /** The first seq this check looked at. */
  start: number
  checked: number
  /** The first entry that must be signed; null while no entry is. */
  signedFrom: number | null
  /** Entries checked that come before `signedFrom`. */
  legacy: number
  /** Signed entries with nothing wrong. */
  verified: number
  problems: Map<number, AuditSigProblem[]>
  /** Where this check ends. */
  checkpoint: AuditCheckpoint
}

type SignerKey = { sigPub: string; role: RosterRole }

/** Signatures already found valid in this page's life: a signed entry never changes, so it is checked once. */
const verifiedOnce = new Set<string>()
const VERIFIED_ONCE_LIMIT = 200_000
const BATCH = 64

async function inBatches<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  for (let index = 0; index < items.length; index += BATCH) await Promise.all(items.slice(index, index + BATCH).map(work))
}

/** The key and role `actor` signs with under roster version `version`, or null when they have none there. */
async function keyAt(input: AuditCheckInput, actor: string, version: number): Promise<SignerKey | null> {
  const { roster } = input
  const member = roster[version - 1]?.members.find((item) => item.id === actor)
  if (!member) return null
  if (member.status === 'active') return { sigPub: member.sigPub, role: member.role }
  if (member.status !== 'invited') return null
  // Redeemed but not yet folded in: the key binding that redeems this invite, stored or carried by the redeeming entry
  // (which outlives a binding an admin dropped by replacing or removing the invite before folding it in).
  for (const binding of [...input.bindings, ...input.redeemed]) {
    if (binding.memberId === actor && binding.inviteSigPub === member.inviteSigPub && (await bindingRedeems(binding, member, input.vaultId))) {
      return { sigPub: binding.sigPub, role: member.role }
    }
  }
  // Folded in since: the version that made them active through this same invite, whose proof the roster check verified.
  for (let next = version + 1; next <= roster.length; next += 1) {
    const before = roster[next - 2].members.find((item) => item.id === actor)
    if (before?.status !== 'invited' || before.inviteSigPub !== member.inviteSigPub) return null
    const after = roster[next - 1].members.find((item) => item.id === actor)
    if (after?.status === 'active' && after.proof !== undefined) return { sigPub: after.sigPub, role: member.role }
  }
  return null
}

/**
 * Checks `input` and reports every problem by seq. Each entry names the roster version of the record that first stored
 * it; an admin who signs a version that lowers their own role signs their entries of that save with it, so the issuer
 * of a version is judged by their role in the version before.
 */
export async function checkAuditSignatures(input: AuditCheckInput): Promise<AuditCheckReport> {
  const { rows, roster, vaultId, from } = input
  const problems = new Map<number, AuditSigProblem[]>()
  const flag = (seq: number, problem: AuditSigProblem) => {
    const list = problems.get(seq) ?? []
    if (!list.includes(problem)) list.push(problem)
    problems.set(seq, list)
  }
  const starts = [input.firstSigned, from?.signedFrom ?? null, input.seenSignedFrom ?? null].filter((value): value is number => value !== null)
  const signedFrom = starts.length > 0 ? Math.min(...starts) : null

  let previous = from?.hash ?? GENESIS_HASH
  let expected = (from?.seq ?? 0) + 1
  const linked = new Set<number>()
  for (const row of rows) {
    const { hash, ...link } = row
    if (row.seq !== expected || row.prevHash !== previous || auditHash(link) !== hash) flag(row.seq, 'CHAIN')
    else linked.add(row.seq)
    previous = hash
    expected = row.seq + 1
  }

  const present = new Set(rows.map((row) => row.seq))
  for (const sig of input.sigs) if (!present.has(sig.seq)) flag(sig.seq, 'ORPHAN')

  const sigs = new Map(input.sigs.map((sig) => [sig.seq, sig]))
  const signed: { row: AuditRow; sig: AuditSig }[] = []
  let legacy = 0
  let lastVersion = from?.rosterVersion ?? 0
  for (const row of rows) {
    if (signedFrom === null || row.seq < signedFrom) {
      legacy += 1
      continue
    }
    const sig = sigs.get(row.seq)
    if (!sig) {
      flag(row.seq, 'UNSIGNED')
      continue
    }
    if (row.actorId !== null && row.actorId !== sig.actor) flag(row.seq, 'ACTOR')
    const doc = roster[sig.rosterVersion - 1]
    if (!doc || sig.rosterVersion < lastVersion || sig.epoch !== doc.epoch) flag(row.seq, 'ORDER')
    lastVersion = Math.max(lastVersion, sig.rosterVersion)
    if (doc) signed.push({ row, sig })
  }

  const keys = new Map<string, Promise<SignerKey | null>>()
  const keyOf = (actor: string, version: number) => {
    const id = `${version}|${actor}`
    let pending = keys.get(id)
    if (!pending) {
      pending = keyAt(input, actor, version)
      keys.set(id, pending)
    }
    return pending
  }
  await inBatches(signed, async ({ row, sig }) => {
    const key = await keyOf(sig.actor, sig.rosterVersion)
    if (!key) {
      flag(row.seq, 'SIGNER')
      return
    }
    const bridge = row.seq === input.firstSigned
    const memo = linked.has(row.seq) ? `${vaultId}|${row.seq}|${row.hash}|${sig.actor}|${sig.rosterVersion}|${sig.epoch}|${bridge ? 1 : 0}|${key.sigPub}|${sig.sig}` : null
    if (memo === null || !verifiedOnce.has(memo)) {
      const body = auditSigBody(vaultId, row, { actor: sig.actor, rosterVersion: sig.rosterVersion, epoch: sig.epoch }, bridge)
      if (!(await verifyAuditEntry(body, sig.sig, key.sigPub))) {
        flag(row.seq, 'SIGNATURE')
        return
      }
      if (memo !== null) {
        if (verifiedOnce.size >= VERIFIED_ONCE_LIMIT) verifiedOnce.clear()
        verifiedOnce.add(memo)
      }
    }
    const entry = { action: row.action, actor: sig.actor, entityType: row.entityType, entityId: row.entityId }
    if (auditActionAllowed(key.role, entry)) return
    const doc = roster[sig.rosterVersion - 1]
    const before = sig.rosterVersion > 1 && doc.issuedBy === sig.actor ? roster[sig.rosterVersion - 2].members.find((item) => item.id === sig.actor) : undefined
    if (before?.status !== 'removed' && before?.role === 'Admin') return
    flag(row.seq, 'ROLE')
  })

  const verified = signed.filter(({ row }) => !problems.has(row.seq)).length
  const last = rows.at(-1)
  const checkpoint: AuditCheckpoint = last
    ? { seq: last.seq, hash: last.hash, signedFrom, rosterVersion: lastVersion > 0 ? lastVersion : null }
    : (from ?? { seq: 0, hash: GENESIS_HASH, signedFrom, rosterVersion: null })
  return { start: (from?.seq ?? 0) + 1, checked: rows.length, signedFrom, legacy, verified, problems, checkpoint }
}

function redeemedBindings(db: SqlDatabase): KeyBinding[] {
  const rows = db.query("SELECT actor_id, details FROM audit_logs WHERE action IN ('INVITE_ACCEPTED', 'RESET_COMPLETED') AND details IS NOT NULL")
  return rows.flatMap((row) => {
    try {
      const details = parseJsonSafely(String(row.details), { maxChars: 65_536 }) as { binding?: unknown } | null
      const binding = readKeyBinding(details?.binding)
      return binding && binding.memberId === row.actor_id ? [binding] : []
    } catch {
      return []
    }
  })
}

/**
 * What {@link checkAuditSignatures} needs from an open vault. It starts after `kept` when the log still reaches it
 * with the same entries and signatures, and from the first entry otherwise (or with `full`). Everything is read before
 * the first await, so the check sees one state even if a save runs meanwhile. Null when the roster cannot be read,
 * which the sign-in checks refuse.
 */
export async function auditCheckInput(db: SqlDatabase, vaultId: string, kept: KeptCheckpoint | null, options: { full?: boolean } = {}): Promise<AuditCheckInput | null> {
  const reaches = !options.full && kept !== null && kept.seq > 0 && compareAuditHead(db, kept) === null && sigsDigest(sigsUpTo(db, kept.seq)) === kept.sigs
  const after = reaches ? kept.seq : 0
  const rows = readAuditRows(db, after)
  const sigs = db.query('SELECT seq, actor, roster_version, epoch, sig FROM audit_sigs WHERE seq > ? ORDER BY seq', [after]).map(sigOf)
  const first = db.queryValue('SELECT MIN(seq) FROM audit_sigs')
  const bindings = readBindings(db) ?? []
  const redeemed = redeemedBindings(db)
  // Reads its rows before it awaits.
  const roster = await readRosterDocs(db)
  if (!roster) return null
  const input: AuditCheckInput = { vaultId, rows, sigs, firstSigned: first == null ? null : Number(first), roster, bindings, redeemed, seenSignedFrom: kept?.signedFrom ?? null }
  if (!reaches) return input
  const { sigs: _digest, ...from } = kept
  return { ...input, from }
}

/**
 * The check of an open vault: from this browser's checkpoint (the entries since its last check, at sign-in), or every
 * entry with `full` (the Audit page and the Health check's full check). Needs the audit permission.
 */
export async function checkVaultAudit(vault: OpenVault & { keys: KeysSession }, options: { full?: boolean } = {}): Promise<AuditCheckReport | null> {
  if (!canUser(vault.user, Permission.READ_AUDIT)) throw new ForbiddenError()
  const input = await auditCheckInput(vault.db, vault.keys.vaultId, readAuditSeen(vault.keys.vaultId), options)
  return input ? checkAuditSignatures(input) : null
}
