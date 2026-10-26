import { Permission, permissionsForRole, type PermissionName } from './index'

export type AuditRole = 'Admin' | 'Manager' | 'Viewer'

/** `self`: an entry a person writes about themselves (entity `user`, their own id). Any listed rule is enough. */
type AuditRule = { permission?: PermissionName; self?: true; anyone?: true }

/**
 * Who may write each audit action, which the signature check of a per-person-keys vault applies with the role the
 * signer has in the roster version the entry names (docs/design/v2.0-key-redesign.md, 3.8 step 6). Each permission is
 * the one the service checks before it writes the entry; role permissions come from {@link permissionsForRole}.
 * Every action the app writes, and every one it has written before, is listed.
 */
export const AUDIT_POLICY = {
  VAULT_CREATED: { permission: Permission.MANAGE_USERS },
  VAULT_UPGRADED: { permission: Permission.MANAGE_USERS },
  VAULT_REPLACED_BY_IMPORT: { permission: Permission.IMPORT_VAULT },
  ROSTER_ROLLBACK_ACCEPTED: { permission: Permission.MANAGE_USERS },
  EPOCH_ROTATED: { permission: Permission.MANAGE_USERS },
  // Whoever signs in after an update applies a migration.
  SCHEMA_MIGRATED: { anyone: true },
  SETTINGS_UPDATED: { permission: Permission.MANAGE_SETTINGS },
  CATEGORY_CREATED: { permission: Permission.MANAGE_SETTINGS },
  CATEGORY_UPDATED: { permission: Permission.MANAGE_SETTINGS },
  CATEGORY_DELETED: { permission: Permission.MANAGE_SETTINGS },
  GROUP_CREATED: { permission: Permission.MANAGE_GROUPS },
  GROUP_DELETED: { permission: Permission.MANAGE_GROUPS },
  TRANSACTION_CREATED: { permission: Permission.CREATE_TRANSACTION },
  TRANSACTION_UPDATED: { permission: Permission.UPDATE_TRANSACTION },
  TRANSACTION_DELETED: { permission: Permission.DELETE_TRANSACTION },
  BACKUP_EXPORTED: { permission: Permission.EXPORT_VAULT },
  DATA_EXPORTED: { permission: Permission.EXPORT_VAULT },
  PLAINTEXT_EXPORTED: { permission: Permission.EXPORT_VAULT },
  AUDIT_MARK_RESET: { permission: Permission.READ_AUDIT },
  USER_CREATED: { permission: Permission.MANAGE_USERS },
  USER_UPDATED: { permission: Permission.MANAGE_USERS },
  USER_PASSWORD_RESET: { permission: Permission.MANAGE_USERS },
  USER_MUST_CHANGE_PASSWORD: { permission: Permission.MANAGE_USERS },
  USER_SUSPENDED: { permission: Permission.MANAGE_USERS },
  USER_REACTIVATED: { permission: Permission.MANAGE_USERS },
  USER_DELETED: { permission: Permission.MANAGE_USERS },
  TRANSACTIONS_REASSIGNED: { permission: Permission.MANAGE_USERS },
  INVITE_CREATED: { permission: Permission.MANAGE_USERS },
  INVITE_REVOKED: { permission: Permission.MANAGE_USERS },
  RESET_ISSUED: { permission: Permission.MANAGE_USERS },
  RESET_REVOKED: { permission: Permission.MANAGE_USERS },
  CLOCK_FLOOR_RESET: { permission: Permission.MANAGE_USERS },
  // Written by the person who redeems a code they were given, with the role it gives them.
  INVITE_ACCEPTED: { anyone: true },
  RESET_COMPLETED: { anyone: true },
  // Ended by whichever session finds the code expired; such an entry has no actor.
  INVITE_EXPIRED: { anyone: true },
  PASSWORD_CHANGED: { self: true },
  CREDENTIALS_UPGRADED: { self: true },
  SIGNIN_FAILURES_SEEN: { self: true },
  TOTP_ENABLED: { self: true },
  TOTP_DISABLED: { self: true },
  TOTP_RECOVERY_USED: { self: true },
  // An admin clears someone's check; redeeming a reset code clears the person's own.
  TOTP_CLEARED: { permission: Permission.MANAGE_USERS, self: true },
} as const satisfies Record<string, AuditRule>

export type AuditAction = keyof typeof AUDIT_POLICY

export function isAuditAction(action: string): action is AuditAction {
  return Object.hasOwn(AUDIT_POLICY, action)
}

/**
 * Whether someone with `role` may have written `entry`, signed by `actor`. An Admin holds every permission, so any
 * action of theirs passes, including one a later release adds; anyone else must match a rule of a known action.
 */
export function auditActionAllowed(role: AuditRole, entry: { action: string; actor: string; entityType: string | null; entityId: string | null }): boolean {
  if (role === 'Admin') return true
  if (!isAuditAction(entry.action)) return false
  const rule: AuditRule = AUDIT_POLICY[entry.action]
  if (rule.anyone) return true
  if (rule.self && entry.entityType === 'user' && entry.entityId === entry.actor) return true
  return rule.permission !== undefined && permissionsForRole(role).includes(rule.permission)
}
