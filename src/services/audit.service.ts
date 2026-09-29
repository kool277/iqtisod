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
  db.exec(
    `INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      actorId,
      action,
      entityType,
      entityId,
      details == null ? null : JSON.stringify(details),
    ],
  )
}

export function listAudit(vault: OpenVault): AuditEntry[] {
  if (!canUser(vault.user, Permission.READ_AUDIT)) throw new ForbiddenError()
  const rows = vault.db.query(
    `SELECT a.id, a.actor_id, u.email AS actor_email, a.action, a.entity_type, a.entity_id, a.details, a.created_at
     FROM audit_logs a
     LEFT JOIN users u ON u.id = a.actor_id
     ORDER BY a.created_at DESC
     LIMIT 200`,
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
