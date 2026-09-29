import { describe, expect, it } from 'vitest'
import { Permission, canUser, permissionsForRole } from '../../src/rbac'

function user(role: 'Admin' | 'Manager' | 'Viewer') {
  return { permissions: permissionsForRole(role) }
}

describe('canUser', () => {
  it('lets an admin delete a transaction and manage the vault', () => {
    expect(canUser(user('Admin'), 'DELETE_TRANSACTION')).toBe(true)
    expect(canUser(user('Admin'), Permission.MANAGE_USERS)).toBe(true)
    expect(canUser(user('Admin'), Permission.EXPORT_VAULT)).toBe(true)
    expect(canUser(user('Admin'), Permission.READ_AUDIT)).toBe(true)
    expect(canUser(user('Admin'), Permission.MANAGE_SETTINGS)).toBe(true)
  })

  it('lets a manager change records in their group and nothing else', () => {
    expect(canUser(user('Manager'), Permission.CREATE_TRANSACTION)).toBe(true)
    expect(canUser(user('Manager'), Permission.UPDATE_TRANSACTION)).toBe(true)
    expect(canUser(user('Manager'), 'DELETE_TRANSACTION')).toBe(true)
    expect(canUser(user('Manager'), Permission.READ_DASHBOARD)).toBe(true)
    expect(canUser(user('Manager'), Permission.MANAGE_USERS)).toBe(false)
    expect(canUser(user('Manager'), Permission.MANAGE_GROUPS)).toBe(false)
    expect(canUser(user('Manager'), Permission.EXPORT_VAULT)).toBe(false)
    expect(canUser(user('Manager'), Permission.READ_AUDIT)).toBe(false)
    expect(canUser(user('Manager'), Permission.MANAGE_SETTINGS)).toBe(false)
  })

  it('limits a viewer to reading the dashboard and transactions', () => {
    expect(canUser(user('Viewer'), Permission.READ_DASHBOARD)).toBe(true)
    expect(canUser(user('Viewer'), Permission.READ_TRANSACTIONS)).toBe(true)
    expect(canUser(user('Viewer'), Permission.CREATE_TRANSACTION)).toBe(false)
    expect(canUser(user('Viewer'), Permission.UPDATE_TRANSACTION)).toBe(false)
    expect(canUser(user('Viewer'), 'DELETE_TRANSACTION')).toBe(false)
    expect(canUser(user('Viewer'), Permission.IMPORT_VAULT)).toBe(false)
  })
})
