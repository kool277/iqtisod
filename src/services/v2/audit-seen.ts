import type { AuditSig } from '../../crypto/audit-sign'
import type { SqlDatabase } from '../../db/sqlite'
import { readPreference, removePreference, writePreference } from '../../lib/preference'

/**
 * Where an audit signature check stopped: the entry at `seq` with its chain hash, the first signed entry, and the
 * newest roster version named up to there. This browser keeps one per vault once nothing was wrong up to there
 * (`moliya.v2.auditSeen.<vaultId>`, design 3.8 step 6), so that a sign-in checks only the entries after it while the log
 * still has that entry with that hash: the chain then fixes everything up to it, as checked before.
 */
export type AuditCheckpoint = { seq: number; hash: string; signedFrom: number | null; rosterVersion: number | null }

export function sigOf(row: Record<string, unknown>): AuditSig {
  return { seq: Number(row.seq), actor: String(row.actor), rosterVersion: Number(row.roster_version), epoch: Number(row.epoch), sig: String(row.sig) }
}

const auditSeenKey = (vaultId: string) => `moliya.v2.auditSeen.${vaultId}`
const HEX64 = /^[0-9a-f]{64}$/

const isSeq = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const isOptionalPositive = (value: unknown): value is number | null => value === null || (Number.isSafeInteger(value) && (value as number) >= 1)

export function readAuditSeen(vaultId: string): AuditCheckpoint | null {
  try {
    const value = JSON.parse(readPreference(auditSeenKey(vaultId)) ?? 'null') as Record<string, unknown> | null
    if (!value || typeof value !== 'object') return null
    const { seq, hash, signedFrom, rosterVersion } = value
    if (!isSeq(seq) || typeof hash !== 'string' || !HEX64.test(hash) || !isOptionalPositive(signedFrom) || !isOptionalPositive(rosterVersion)) return null
    return { seq, hash, signedFrom, rosterVersion }
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
 * log as it is) it is taken as it is now. Only roster versions that exist count.
 */
export function keepAuditSeen(db: SqlDatabase, vaultId: string, seq: number, options: { reset?: boolean } = {}): void {
  const row = db.queryOne('SELECT hash FROM audit_logs WHERE seq = ?', [seq])
  if (!row) return
  const first = db.queryValue('SELECT MIN(seq) FROM audit_sigs WHERE seq <= ?', [seq])
  const version = db.queryValue('SELECT MAX(roster_version) FROM audit_sigs WHERE seq <= ? AND roster_version <= (SELECT MAX(version) FROM roster_versions)', [seq])
  const seen = options.reset ? null : (readAuditSeen(vaultId)?.signedFrom ?? null)
  const signed = first == null ? null : Number(first)
  const signedFrom = seen !== null && signed !== null ? Math.min(seen, signed) : (signed ?? seen)
  const kept: AuditCheckpoint = { seq, hash: String(row.hash), signedFrom, rosterVersion: version == null ? null : Number(version) }
  writePreference(auditSeenKey(vaultId), JSON.stringify(kept))
}
