import { Permission, canUser, type PermissionName } from '../../rbac'

/**
 * Tables whose current view may be exported, with the permission that already guards the page.
 * Private-safe tables are deliberately absent: their contents never leave the safe as a file.
 */
export const VIEW_TABLES = {
  transactions: Permission.READ_TRANSACTIONS,
  users: Permission.MANAGE_USERS,
  grants: Permission.MANAGE_USERS,
  groups: Permission.MANAGE_GROUPS,
  audit: Permission.READ_AUDIT,
  categories: Permission.MANAGE_SETTINGS,
  archives: Permission.EXPORT_VAULT,
} as const satisfies Record<string, PermissionName>

export type ViewTable = keyof typeof VIEW_TABLES

export function isViewTable(value: string): value is ViewTable {
  return Object.hasOwn(VIEW_TABLES, value)
}

/** Same rule as the full export: only people who may export the vault, and only from a page they may already read. */
export function canExportView(user: { permissions: readonly string[] }, table: ViewTable): boolean {
  return canUser(user, Permission.EXPORT_VAULT) && canUser(user, VIEW_TABLES[table])
}
