import { ForbiddenError, ValidationError } from '../domain/errors'
import type { Group, OpenVault } from '../domain/types'
import { LIMITS } from '../lib/limits'
import { Permission, canUser, seesAllGroups } from '../rbac'
import { writeAudit } from './audit.service'

function mapGroup(row: Record<string, string | number | null>): Group {
  return {
    id: Number(row.id),
    name: String(row.name),
    createdAt: String(row.created_at),
  }
}

export function listGroups(vault: OpenVault): Group[] {
  if (seesAllGroups(vault.user)) {
    return vault.db.query('SELECT id, name, created_at FROM groups ORDER BY name').map(mapGroup)
  }
  if (vault.user.groupId == null) return []
  return vault.db
    .query('SELECT id, name, created_at FROM groups WHERE id = ?', [vault.user.groupId])
    .map(mapGroup)
}

export function createGroup(vault: OpenVault, name: string): void {
  if (!canUser(vault.user, Permission.MANAGE_GROUPS)) throw new ForbiddenError()
  const trimmed = name.trim()
  if (!trimmed) throw new ValidationError('REQUIRED')
  if (trimmed.length > LIMITS.nameChars) throw new ValidationError('TOO_LONG')
  vault.db.withTransaction(() => {
    vault.db.exec('INSERT INTO groups (name) VALUES (?)', [trimmed])
    const id = String(vault.db.queryValue('SELECT last_insert_rowid()') ?? '')
    writeAudit(vault.db, vault.user.id, 'GROUP_CREATED', 'group', id, { name: trimmed })
  })
}

export function deleteGroup(vault: OpenVault, groupId: number): void {
  if (!canUser(vault.user, Permission.MANAGE_GROUPS)) throw new ForbiddenError()
  const people = Number(vault.db.queryValue('SELECT COUNT(*) FROM users WHERE group_id = ?', [groupId]) ?? 0)
  const records = Number(
    vault.db.queryValue('SELECT COUNT(*) FROM transactions WHERE group_id = ?', [groupId]) ?? 0,
  )
  if (people > 0 || records > 0) throw new ValidationError('GROUP_IN_USE')
  const existing = vault.db.queryOne('SELECT name FROM groups WHERE id = ?', [groupId])
  if (!existing) throw new ValidationError('REQUIRED')
  vault.db.withTransaction(() => {
    writeAudit(vault.db, vault.user.id, 'GROUP_DELETED', 'group', String(groupId), { name: existing.name })
    vault.db.exec('DELETE FROM groups WHERE id = ?', [groupId])
  })
}
