import { verifyAuditChain, type ChainReport } from '../db/audit-chain'
import type { SqlValue } from '../db/sqlite'
import { ForbiddenError } from '../domain/errors'
import type { AuditEntry, OpenVault } from '../domain/types'
import { Permission, canUser } from '../rbac'

export const AUDIT_PAGE_LIMIT = 10_000

export function mapAuditRow(row: Record<string, SqlValue>): AuditEntry {
  return {
    id: String(row.id),
    actorId: row.actor_id == null ? null : String(row.actor_id),
    actorEmail: row.actor_email == null ? null : String(row.actor_email),
    action: String(row.action),
    entityType: row.entity_type == null ? null : String(row.entity_type),
    entityId: row.entity_id == null ? null : String(row.entity_id),
    details: row.details == null ? null : String(row.details),
    createdAt: String(row.created_at),
  }
}

/** The actor's email, or for someone since removed, the email their `USER_DELETED` entry recorded. */
export const AUDIT_ACTOR_EMAIL = `CASE WHEN a.actor_id IS NULL OR u.id IS NOT NULL THEN u.email ELSE (
  SELECT json_extract(d.details, '$.email') FROM audit_logs d
  WHERE d.action = 'USER_DELETED' AND d.entity_type = 'user' AND d.entity_id = a.actor_id AND json_valid(d.details)
  ORDER BY d.seq DESC LIMIT 1) END`

export function listAudit(vault: OpenVault, limit = 200): AuditEntry[] {
  if (!canUser(vault.user, Permission.READ_AUDIT)) throw new ForbiddenError()
  const bounded = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), AUDIT_PAGE_LIMIT) : 200
  const rows = vault.db.query(
    `SELECT a.id, a.actor_id, ${AUDIT_ACTOR_EMAIL} AS actor_email, a.action, a.entity_type, a.entity_id, a.details, a.created_at
     FROM audit_logs a
     LEFT JOIN users u ON u.id = a.actor_id
     ORDER BY a.seq DESC
     LIMIT ?`,
    [bounded],
  )
  return rows.map(mapAuditRow)
}

export function auditIntegrity(vault: OpenVault): ChainReport {
  if (!canUser(vault.user, Permission.READ_AUDIT)) throw new ForbiddenError()
  return verifyAuditChain(vault.db)
}
