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

export function canUser(user: { permissions: readonly string[] }, permission: string): boolean {
  return user.permissions.includes(permission)
}
