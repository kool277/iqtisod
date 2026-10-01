import { auditHead, compareAuditHead, insertAuditLink, verifyAuditChain, type AuditHead, type AuditHeadProblem } from '../db/audit-chain'
import type { SqlDatabase } from '../db/sqlite'
import { ForbiddenError } from '../domain/errors'
import type { OpenVault } from '../domain/types'
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
