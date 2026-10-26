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

/** What an entry's chain hash is the SHA-256 of, as UTF-8. */
export function auditHashText(link: AuditLink): string {
  return JSON.stringify([link.seq, link.id, link.actorId, link.action, link.entityType, link.entityId, link.details, link.createdAt, link.prevHash])
}

export function auditHash(link: AuditLink): string {
  return sha256Hex(auditHashText(link))
}

function text(value: SqlValue): string | null {
  return value == null ? null : String(value)
}

/** A stored entry with the hash stored beside it, which a check compares with {@link auditHash}. */
export type AuditRow = AuditLink & { hash: string }

const ROW_COLUMNS = 'seq, id, actor_id, action, entity_type, entity_id, details, created_at, prev_hash, hash'

export function auditRowOf(row: Record<string, SqlValue>): AuditRow {
  return {
    seq: Number(row.seq),
    id: String(row.id),
    actorId: text(row.actor_id),
    action: String(row.action),
    entityType: text(row.entity_type),
    entityId: text(row.entity_id),
    details: text(row.details),
    createdAt: String(row.created_at),
    prevHash: String(row.prev_hash),
    hash: String(row.hash),
  }
}

/** Every entry after `afterSeq`, in order. */
export function readAuditRows(db: SqlDatabase, afterSeq = 0): AuditRow[] {
  return db.query(`SELECT ${ROW_COLUMNS} FROM audit_logs WHERE seq > ? ORDER BY seq`, [afterSeq]).map(auditRowOf)
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
  const rows = readAuditRows(db)
  let previous = GENESIS_HASH
  let expectedSeq = 1
  for (const row of rows) {
    const { hash, ...link } = row
    if (link.seq !== expectedSeq || link.prevHash !== previous || auditHash(link) !== hash) {
      return { ok: false, entries: rows.length, brokenAt: link.seq, head: previous }
    }
    previous = hash
    expectedSeq += 1
  }
  return { ok: true, entries: rows.length, brokenAt: null, head: previous }
}
