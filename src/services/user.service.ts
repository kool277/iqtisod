import { bytesToBase64 } from '../crypto/encoding'
import { CURRENT_KDF, SALT_BYTES, deriveKeyAndVerifier, randomBytes, wrapDek } from '../crypto/crypto.service'
import { ForbiddenError, ValidationError, isUniqueViolation } from '../domain/errors'
import { isRoleName, type OpenVault, type RoleName, type UserWrap, type VaultUser } from '../domain/types'
import { Permission, canUser } from '../rbac'
import { assertEmail, assertPassword, normalizeEmail } from './auth.service'
import { writeAudit } from './audit.service'

export type NewUserInput = {
  email: string
  password: string
  roleName: RoleName
  groupId: number | null
}

function adminCount(vault: OpenVault): number {
  return Number(
    vault.db.queryValue(
      `SELECT COUNT(*) FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'Admin'`,
    ) ?? 0,
  )
}

function roleId(vault: OpenVault, name: string): number {
  const value = vault.db.queryValue('SELECT id FROM roles WHERE name = ?', [name])
  if (value == null) throw new ValidationError('ROLE')
  return Number(value)
}

function assertGroup(vault: OpenVault, groupId: number | null, roleName: RoleName): number | null {
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

export function listUsers(vault: OpenVault): VaultUser[] {
  if (!canUser(vault.user, Permission.MANAGE_USERS) && !canUser(vault.user, Permission.READ_TRANSACTIONS)) {
    throw new ForbiddenError()
  }
  if (vault.user.roleName !== 'Admin' && vault.user.groupId == null) return []
  const rows =
    vault.user.roleName === 'Admin'
      ? vault.db.query(
          `SELECT u.id, u.email, r.name AS role_name, u.group_id, g.name AS group_name, u.created_at
           FROM users u
           JOIN roles r ON r.id = u.role_id
           LEFT JOIN groups g ON g.id = u.group_id
           ORDER BY u.email`,
        )
      : vault.db.query(
          `SELECT u.id, u.email, r.name AS role_name, u.group_id, g.name AS group_name, u.created_at
           FROM users u
           JOIN roles r ON r.id = u.role_id
           LEFT JOIN groups g ON g.id = u.group_id
           WHERE u.group_id = ?
           ORDER BY u.email`,
          [vault.user.groupId],
        )
  return rows.map((row) => ({
    id: String(row.id),
    email: String(row.email),
    roleName: String(row.role_name),
    groupId: row.group_id == null ? null : Number(row.group_id),
    groupName: row.group_name == null ? null : String(row.group_name),
    createdAt: String(row.created_at),
  }))
}

export async function createUser(vault: OpenVault, input: NewUserInput): Promise<void> {
  if (!canUser(vault.user, Permission.MANAGE_USERS)) throw new ForbiddenError()
  if (!isRoleName(input.roleName)) throw new ValidationError('ROLE')
  const email = normalizeEmail(input.email)
  assertEmail(email)
  assertPassword(input.password)
  const groupId = assertGroup(vault, input.groupId, input.roleName)
  const salt = randomBytes(SALT_BYTES)
  const { key, verifier } = await deriveKeyAndVerifier(input.password, salt, CURRENT_KDF)
  const wrapped = await wrapDek(vault.dek, key)
  const userId = crypto.randomUUID()
  try {
    vault.db.withTransaction(() => {
      vault.db.exec(
        `INSERT INTO users (id, email, password_hash, salt, role_id, group_id, must_change_password, password_changed_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
        [userId, email, verifier, bytesToBase64(salt), roleId(vault, input.roleName), groupId, new Date().toISOString()],
      )
      writeAudit(vault.db, vault.user.id, 'USER_CREATED', 'user', userId, {
        email,
        role: input.roleName,
        groupId,
      })
    })
  } catch (error) {
    if (isUniqueViolation(error)) throw new ValidationError('DUPLICATE_EMAIL')
    throw error
  }
  const wrap: UserWrap = {
    userId,
    email,
    kdf: { ...CURRENT_KDF },
    salt,
    iv: wrapped.iv,
    wrappedDek: wrapped.cipherText,
  }
  const index = vault.wraps.findIndex((item) => item.userId === userId)
  if (index >= 0) vault.wraps[index] = wrap
  else vault.wraps.push(wrap)
}

export async function resetUserPassword(vault: OpenVault, userId: string, password: string): Promise<void> {
  if (!canUser(vault.user, Permission.MANAGE_USERS)) throw new ForbiddenError()
  if (userId === vault.user.id) throw new ValidationError('USE_ACCOUNT')
  assertPassword(password)
  const existing = vault.db.queryOne('SELECT id, email FROM users WHERE id = ?', [userId])
  if (!existing) throw new ValidationError('REQUIRED')
  const email = String(existing.email)
  const salt = randomBytes(SALT_BYTES)
  const { key, verifier } = await deriveKeyAndVerifier(password, salt, CURRENT_KDF)
  const wrapped = await wrapDek(vault.dek, key)
  vault.db.withTransaction(() => {
    vault.db.exec(
      'UPDATE users SET password_hash = ?, salt = ?, must_change_password = 1, password_changed_at = ? WHERE id = ?',
      [verifier, bytesToBase64(salt), new Date().toISOString(), userId],
    )
    writeAudit(vault.db, vault.user.id, 'USER_PASSWORD_RESET', 'user', userId, { email })
  })
  const wrap: UserWrap = {
    userId,
    email,
    kdf: { ...CURRENT_KDF },
    salt,
    iv: wrapped.iv,
    wrappedDek: wrapped.cipherText,
  }
  const index = vault.wraps.findIndex((item) => item.userId === userId || item.email === email)
  if (index >= 0) vault.wraps[index] = wrap
  else vault.wraps.push(wrap)
}

export function updateUser(
  vault: OpenVault,
  userId: string,
  input: { roleName: RoleName; groupId: number | null },
): void {
  if (!canUser(vault.user, Permission.MANAGE_USERS)) throw new ForbiddenError()
  if (!isRoleName(input.roleName)) throw new ValidationError('ROLE')
  const existing = vault.db.queryOne(
    `SELECT u.id, r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
    [userId],
  )
  if (!existing) throw new ValidationError('REQUIRED')
  if (String(existing.role_name) === 'Admin' && input.roleName !== 'Admin' && adminCount(vault) <= 1) {
    throw new ValidationError('LAST_ADMIN')
  }
  const groupId = assertGroup(vault, input.groupId, input.roleName)
  vault.db.withTransaction(() => {
    vault.db.exec('UPDATE users SET role_id = ?, group_id = ? WHERE id = ?', [
      roleId(vault, input.roleName),
      groupId,
      userId,
    ])
    writeAudit(vault.db, vault.user.id, 'USER_UPDATED', 'user', userId, {
      role: input.roleName,
      groupId,
    })
  })
  if (vault.user.id === userId) {
    vault.user.roleName = input.roleName
    vault.user.roleId = roleId(vault, input.roleName)
    vault.user.groupId = groupId
    const permissions = vault.db.queryValue('SELECT permissions FROM roles WHERE name = ?', [input.roleName])
    try {
      const parsed = JSON.parse(String(permissions)) as unknown
      vault.user.permissions = Array.isArray(parsed) ? parsed.map(String) : []
    } catch {
      vault.user.permissions = []
    }
  }
}

export function deleteUser(vault: OpenVault, userId: string): void {
  if (!canUser(vault.user, Permission.MANAGE_USERS)) throw new ForbiddenError()
  if (vault.user.id === userId) throw new ValidationError('SELF')
  const existing = vault.db.queryOne(
    `SELECT u.email, r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
    [userId],
  )
  if (!existing) throw new ValidationError('REQUIRED')
  if (String(existing.role_name) === 'Admin' && adminCount(vault) <= 1) throw new ValidationError('LAST_ADMIN')
  const records = Number(
    vault.db.queryValue('SELECT COUNT(*) FROM transactions WHERE user_id = ?', [userId]) ?? 0,
  )
  if (records > 0) throw new ValidationError('HAS_RECORDS')
  const email = String(existing.email)
  vault.db.withTransaction(() => {
    writeAudit(vault.db, vault.user.id, 'USER_DELETED', 'user', userId, { email })
    vault.db.exec('DELETE FROM safe_events WHERE owner_user_id = ?', [userId])
    vault.db.exec('DELETE FROM secure_items WHERE owner_user_id = ?', [userId])
    vault.db.exec('DELETE FROM safes WHERE owner_user_id = ?', [userId])
    vault.db.exec('DELETE FROM user_keys WHERE user_id = ?', [userId])
    vault.db.exec('DELETE FROM users WHERE id = ?', [userId])
  })
  const index = vault.wraps.findIndex((wrap) => wrap.userId === userId)
  if (index >= 0) vault.wraps.splice(index, 1)
}
