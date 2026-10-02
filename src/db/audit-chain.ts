import { sha256Hex } from '../lib/sha256'
import type { SqlDatabase, SqlValue } from './sqlite'

export const GENESIS_HASH = '0'.repeat(64)

export type AuditLink = {
  seq: number
  id: string
  actorId: string | null
  action: string
  entityType: string | null
  entityId: string | null
  details: string | null
  createdAt: string
  prevHash: string
}

export function auditHash(link: AuditLink): string {
  return sha256Hex(
    JSON.stringify([
      link.seq,
      link.id,
      link.actorId,
      link.action,
      link.entityType,
      link.entityId,
      link.details,
      link.createdAt,
      link.prevHash,
    ]),
  )
}

function text(value: SqlValue): string | null {
  return value == null ? null : String(value)
}

export function insertAuditLink(db: SqlDatabase, entry: Omit<AuditLink, 'seq' | 'prevHash'>): void {
  const last = db.queryOne('SELECT seq, hash FROM audit_logs ORDER BY seq DESC LIMIT 1')
  const link: AuditLink = {
    ...entry,
    seq: last ? Number(last.seq) + 1 : 1,
    prevHash: last ? String(last.hash) : GENESIS_HASH,
  }
  db.exec(
    `INSERT INTO audit_logs (seq, id, actor_id, action, entity_type, entity_id, details, created_at, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      link.seq,
      link.id,
      link.actorId,
      link.action,
      link.entityType,
      link.entityId,
      link.details,
      link.createdAt,
      link.prevHash,
      auditHash(link),
    ],
  )
}

/** The last entry of the chain: its seq and hash, or seq 0 and the genesis hash for an empty log. */
export type AuditHead = { seq: number; hash: string }

export function isAuditHead(value: unknown): value is AuditHead {
  if (typeof value !== 'object' || value === null) return false
  const head = value as Record<string, unknown>
  return Number.isSafeInteger(head.seq) && (head.seq as number) >= 0 && typeof head.hash === 'string' && /^[0-9a-f]{64}$/.test(head.hash)
}

export function auditHead(db: SqlDatabase): AuditHead {
  const last = db.queryOne('SELECT seq, hash FROM audit_logs ORDER BY seq DESC LIMIT 1')
  return last ? { seq: Number(last.seq), hash: String(last.hash) } : { seq: 0, hash: GENESIS_HASH }
}

export type AuditHeadProblem = 'SHORTER' | 'CHANGED'

/** Whether the log still reaches `seen` with the same entry there: a log may only grow. */
export function compareAuditHead(db: SqlDatabase, seen: AuditHead): AuditHeadProblem | null {
  if (seen.seq > auditHead(db).seq) return 'SHORTER'
  if (seen.seq === 0) return null
  return db.queryValue('SELECT hash FROM audit_logs WHERE seq = ?', [seen.seq]) === seen.hash ? null : 'CHANGED'
}

export type ChainReport = {
  ok: boolean
  entries: number
  brokenAt: number | null
  head: string
}

export function verifyAuditChain(db: SqlDatabase): ChainReport {
  const rows = db.query(
    `SELECT seq, id, actor_id, action, entity_type, entity_id, details, created_at, prev_hash, hash
     FROM audit_logs ORDER BY seq`,
  )
  let previous = GENESIS_HASH
  let expectedSeq = 1
  for (const row of rows) {
    const link: AuditLink = {
      seq: Number(row.seq),
      id: String(row.id),
      actorId: text(row.actor_id),
      action: String(row.action),
      entityType: text(row.entity_type),
      entityId: text(row.entity_id),
      details: text(row.details),
      createdAt: String(row.created_at),
      prevHash: String(row.prev_hash),
    }
    if (link.seq !== expectedSeq || link.prevHash !== previous || auditHash(link) !== row.hash) {
      return { ok: false, entries: rows.length, brokenAt: link.seq, head: previous }
    }
    previous = String(row.hash)
    expectedSeq += 1
  }
  return { ok: true, entries: rows.length, brokenAt: null, head: previous }
}
