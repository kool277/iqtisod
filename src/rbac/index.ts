export const Permission = {
  MANAGE_USERS: 'MANAGE_USERS',
  MANAGE_GROUPS: 'MANAGE_GROUPS',
  CREATE_TRANSACTION: 'CREATE_TRANSACTION',
  UPDATE_TRANSACTION: 'UPDATE_TRANSACTION',
  DELETE_TRANSACTION: 'DELETE_TRANSACTION',
  READ_TRANSACTIONS: 'READ_TRANSACTIONS',
  READ_DASHBOARD: 'READ_DASHBOARD',
  EXPORT_VAULT: 'EXPORT_VAULT',
  IMPORT_VAULT: 'IMPORT_VAULT',
  READ_AUDIT: 'READ_AUDIT',
  MANAGE_SETTINGS: 'MANAGE_SETTINGS',
} as const

export type PermissionName = (typeof Permission)[keyof typeof Permission]

const ALL_PERMISSIONS = Object.values(Permission)

export function permissionsForRole(role: 'Admin' | 'Manager' | 'Viewer'): PermissionName[] {
  switch (role) {
    case 'Admin':
      return [...ALL_PERMISSIONS]
    case 'Manager':
      return [
        Permission.CREATE_TRANSACTION,
        Permission.UPDATE_TRANSACTION,
        Permission.DELETE_TRANSACTION,
        Permission.READ_TRANSACTIONS,
        Permission.READ_DASHBOARD,
      ]
    case 'Viewer':
      return [Permission.READ_TRANSACTIONS, Permission.READ_DASHBOARD]
  }
}

/** No permission holds while a forced password change is pending, so every service check refuses until it is done. */
export function canUser(user: { permissions: readonly string[]; mustChangePassword?: boolean }, permission: string): boolean {
  return user.mustChangePassword !== true && user.permissions.includes(permission)
}

/** People managers see everyone; someone who may change their group's records sees that group's members, read-only. */
export function seesMembers(user: { permissions: readonly string[]; mustChangePassword?: boolean; groupId: number | null }): boolean {
  return canUser(user, Permission.MANAGE_USERS) || (canUser(user, Permission.UPDATE_TRANSACTION) && user.groupId != null)
}

/** Seeing every group's money goes with managing the groups, the same permission the role screens use. */
export function seesAllGroups(user: { permissions: readonly string[]; mustChangePassword?: boolean }): boolean {
  return canUser(user, Permission.MANAGE_GROUPS)
}
