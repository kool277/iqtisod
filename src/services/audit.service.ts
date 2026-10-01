import { auditHead, compareAuditHead, insertAuditLink, verifyAuditChain, type AuditHead, type AuditHeadProblem, type ChainReport } from '../db/audit-chain'
import type { SqlDatabase } from '../db/sqlite'
import { ForbiddenError } from '../domain/errors'
import type { AuditEntry, OpenVault } from '../domain/types'
import { Permission, canUser } from '../rbac'

export function writeAudit(
  db: SqlDatabase,
  actorId: string | null,
  action: string,
  entityType: string | null,
  entityId: string | null,
  details?: unknown,
): void {
  insertAuditLink(db, {
    id: crypto.randomUUID(),
    actorId,
    action,
    entityType,
    entityId,
    details: details == null ? null : JSON.stringify(details),
    createdAt: new Date().toISOString(),
  })
}

export const AUDIT_PAGE_LIMIT = 10_000

export function listAudit(vault: OpenVault, limit = 200): AuditEntry[] {
  if (!canUser(vault.user, Permission.READ_AUDIT)) throw new ForbiddenError()
  const bounded = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), AUDIT_PAGE_LIMIT) : 200
  const rows = vault.db.query(
    `SELECT a.id, a.actor_id, u.email AS actor_email, a.action, a.entity_type, a.entity_id, a.details, a.created_at
     FROM audit_logs a
     LEFT JOIN users u ON u.id = a.actor_id
     ORDER BY a.seq DESC
     LIMIT ?`,
    [bounded],
  )
  return rows.map((row) => ({
    id: String(row.id),
    actorId: row.actor_id == null ? null : String(row.actor_id),
    actorEmail: row.actor_email == null ? null : String(row.actor_email),
    action: String(row.action),
    entityType: row.entity_type == null ? null : String(row.entity_type),
    entityId: row.entity_id == null ? null : String(row.entity_id),
    details: row.details == null ? null : String(row.details),
    createdAt: String(row.created_at),
  }))
}

export function auditIntegrity(vault: OpenVault): ChainReport {
  if (!canUser(vault.user, Permission.READ_AUDIT)) throw new ForbiddenError()
  return verifyAuditChain(vault.db)
}

export type AuditWarning =
  | { kind: 'BROKEN'; brokenAt: number }
  | { kind: AuditHeadProblem; source: 'device' | 'record'; expected: AuditHead; actual: AuditHead }

/**
 * Run on the opened database at sign-in. `device` is the furthest entry this browser saw, `record` the head the record
 * claims. Neither is a signature: someone holding the vault key can rewrite the log and both marks, but cutting entries
 * off the end or rewriting history no longer goes unnoticed on a browser that saw the log before.
 */
export function checkAuditLog(db: SqlDatabase, seen: { device: AuditHead | null; record?: AuditHead }, verifyChain: boolean): AuditWarning | null {
  if (verifyChain) {
    const report = verifyAuditChain(db)
    if (!report.ok) return { kind: 'BROKEN', brokenAt: report.brokenAt ?? 0 }
  }
  for (const [source, head] of [['device', seen.device], ['record', seen.record]] as const) {
    if (!head) continue
    const problem = compareAuditHead(db, head)
    if (problem) return { kind: problem, source, expected: head, actual: auditHead(db) }
  }
  return null
}

/** An admin accepts the log as it is now; the warning goes into the log itself. */
export function acknowledgeAuditWarning(vault: OpenVault, warning: AuditWarning): void {
  if (!canUser(vault.user, Permission.READ_AUDIT)) throw new ForbiddenError()
  writeAudit(vault.db, vault.user.id, 'AUDIT_MARK_RESET', 'vault', 'primary', warning)
}
