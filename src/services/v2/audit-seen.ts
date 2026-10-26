import type { AuditSig } from '../../crypto/audit-sign'
import type { SqlDatabase } from '../../db/sqlite'
import { readPreference, removePreference, writePreference } from '../../lib/preference'
import { sha256Hex } from '../../lib/sha256'

/**
 * Where an audit signature check stopped: the entry at `seq` with its chain hash, the first signed entry, and the
 * newest roster version named up to there. This browser keeps one per vault once nothing was wrong up to there
 * (`moliya.v2.auditSeen.<vaultId>`, design 3.8 step 6), with `sigs`, the digest of every signature up to `seq`, so that
 * a sign-in checks only the entries after it, unless an entry or a signature up to it changed.
 */
export type AuditCheckpoint = { seq: number; hash: string; signedFrom: number | null; rosterVersion: number | null }
export type KeptCheckpoint = AuditCheckpoint & { sigs: string }

export function sigOf(row: Record<string, unknown>): AuditSig {
  return { seq: Number(row.seq), actor: String(row.actor), rosterVersion: Number(row.roster_version), epoch: Number(row.epoch), sig: String(row.sig) }
}

export function sigsUpTo(db: SqlDatabase, seq: number): AuditSig[] {
  return db.query('SELECT seq, actor, roster_version, epoch, sig FROM audit_sigs WHERE seq <= ? ORDER BY seq', [seq]).map(sigOf)
}

export function sigsDigest(sigs: readonly AuditSig[]): string {
  return sha256Hex(JSON.stringify(sigs.map((sig) => [sig.seq, sig.actor, sig.rosterVersion, sig.epoch, sig.sig])))
}

const auditSeenKey = (vaultId: string) => `moliya.v2.auditSeen.${vaultId}`
const HEX64 = /^[0-9a-f]{64}$/

const isSeq = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const isOptionalPositive = (value: unknown): value is number | null => value === null || (Number.isSafeInteger(value) && (value as number) >= 1)

export function readAuditSeen(vaultId: string): KeptCheckpoint | null {
  try {
    const value = JSON.parse(readPreference(auditSeenKey(vaultId)) ?? 'null') as Record<string, unknown> | null
    if (!value || typeof value !== 'object') return null
    const { seq, hash, signedFrom, rosterVersion, sigs } = value
    if (!isSeq(seq) || typeof hash !== 'string' || !HEX64.test(hash) || !isOptionalPositive(signedFrom) || !isOptionalPositive(rosterVersion)) return null
    if (typeof sigs !== 'string' || !HEX64.test(sigs)) return null
    return { seq, hash, signedFrom, rosterVersion, sigs }
  } catch {
    return null
  }
}

export function forgetAuditSeen(vaultId: string): void {
  removePreference(auditSeenKey(vaultId))
}

/**
 * Keeps the log up to `seq` as checked, once everything up to there was checked with nothing wrong or signed in this
 * session; the first signed entry then never moves later than this browser saw it. With `reset` (an admin accepted the
 * log as it is) it is taken as it is now.
 */
export function keepAuditSeen(db: SqlDatabase, vaultId: string, seq: number, options: { reset?: boolean } = {}): void {
  const row = db.queryOne('SELECT hash FROM audit_logs WHERE seq = ?', [seq])
  if (!row) return
  const sigs = sigsUpTo(db, seq)
  const seen = options.reset ? null : (readAuditSeen(vaultId)?.signedFrom ?? null)
  const first = sigs[0]?.seq ?? null
  const signedFrom = seen !== null && first !== null ? Math.min(seen, first) : (first ?? seen)
  const version = sigs.reduce((max, sig) => Math.max(max, sig.rosterVersion), 0)
  const kept: KeptCheckpoint = { seq, hash: String(row.hash), signedFrom, rosterVersion: version > 0 ? version : null, sigs: sigsDigest(sigs) }
  writePreference(auditSeenKey(vaultId), JSON.stringify(kept))
}
