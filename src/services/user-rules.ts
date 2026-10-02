import { ValidationError } from '../domain/errors'
import type { OpenVault, RoleName } from '../domain/types'

/** Kept apart from user.service so the sign-in and code paths load without the people-management code. */
export function roleIdByName(vault: OpenVault, name: RoleName): number {
  const value = vault.db.queryValue('SELECT id FROM roles WHERE name = ?', [name])
  if (value == null) throw new ValidationError('ROLE')
  return Number(value)
}

/** Admins may have no group; everyone else needs one that exists. */
export function checkUserGroup(vault: OpenVault, groupId: number | null, roleName: RoleName): number | null {
  if (roleName === 'Admin') {
    if (groupId == null) return null
  } else if (groupId == null) {
    throw new ValidationError('GROUP')
  }
  if (groupId == null) return null
  const found = vault.db.queryValue('SELECT id FROM groups WHERE id = ?', [groupId])
  if (found == null) throw new ValidationError('GROUP')
  return groupId
}
