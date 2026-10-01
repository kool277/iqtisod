import { bytesToBase64 } from '../crypto/encoding'
import { CURRENT_KDF, SALT_BYTES, deriveKeyAndVerifier, randomBytes } from '../crypto/crypto.service'
import { newUserWrap } from '../crypto/user-wrap'
import { ForbiddenError, ValidationError, isUniqueViolation } from '../domain/errors'
import { isRoleName, type OpenVault, type RoleName, type VaultUser } from '../domain/types'
import { LIMITS } from '../lib/limits'
import { assertNewPassword } from '../lib/password-policy'
import { Permission, canUser } from '../rbac'
import { assertEmail, normalizeEmail } from './auth.service'
import { writeAudit } from './audit.service'
import { dropEnvelopeGrant, endGrant, openGrantRows } from './grant-store'
import { dropTotp } from './totp.service'

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

export function roleIdByName(vault: OpenVault, name: RoleName): number {
  return roleId(vault, name)
}

export function checkUserGroup(vault: OpenVault, groupId: number | null, roleName: RoleName): number | null {
  return assertGroup(vault, groupId, roleName)
}

export function listUsers(vault: OpenVault): VaultUser[] {
  if (!canUser(vault.user, Permission.MANAGE_USERS) && !canUser(vault.user, Permission.READ_TRANSACTIONS)) {
    throw new ForbiddenError()
  }
  if (vault.user.roleName !== 'Admin' && vault.user.groupId == null) return []
  const rows =
    vault.user.roleName === 'Admin'
      ? vault.db.query(
          `SELECT u.id, u.email, r.name AS role_name, u.group_id, g.name AS group_name, u.created_at,
                  EXISTS (SELECT 1 FROM user_totp t WHERE t.user_id = u.id) AS sign_in_check
           FROM users u
           JOIN roles r ON r.id = u.role_id
           LEFT JOIN groups g ON g.id = u.group_id
           ORDER BY u.email`,
        )
      : vault.db.query(
          `SELECT u.id, u.email, r.name AS role_name, u.group_id, g.name AS group_name, u.created_at,
                  EXISTS (SELECT 1 FROM user_totp t WHERE t.user_id = u.id) AS sign_in_check
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
    signInCheck: Number(row.sign_in_check) === 1,
  }))
}

export async function createUser(vault: OpenVault, input: NewUserInput): Promise<void> {
  if (!canUser(vault.user, Permission.MANAGE_USERS)) throw new ForbiddenError()
  if (!isRoleName(input.roleName)) throw new ValidationError('ROLE')
  const email = normalizeEmail(input.email)
  assertEmail(email)
  await assertNewPassword(input.password, { email, vaultName: vault.vaultName })
  if (vault.wraps.length >= LIMITS.wraps) throw new ValidationError('MEMBER_LIMIT')
  const groupId = assertGroup(vault, input.groupId, input.roleName)
  const salt = randomBytes(SALT_BYTES)
  const { key, verifier } = await deriveKeyAndVerifier(input.password, salt, CURRENT_KDF)
  const userId = crypto.randomUUID()
  const wrap = await newUserWrap(vault.dek, key, { userId, email, kdf: { ...CURRENT_KDF }, salt })
  const replaced = openGrantRows(vault.db).filter((grant) => grant.kind === 'INVITE' && grant.email === email)
  try {
    vault.db.withTransaction(() => {
      const at = new Date().toISOString()
      for (const grant of replaced) {
        endGrant(vault.db, grant.id, 'REPLACED', vault.user.id, at)
        writeAudit(vault.db, vault.user.id, 'INVITE_REVOKED', 'grant', grant.id, { email, reason: 'REPLACED' })
      }
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
  for (const grant of replaced) dropEnvelopeGrant(vault, grant.id)
  const index = vault.wraps.findIndex((item) => item.userId === userId)
  if (index >= 0) vault.wraps[index] = wrap
  else vault.wraps.push(wrap)
}

export async function resetUserPassword(vault: OpenVault, userId: string, password: string): Promise<void> {
  if (!canUser(vault.user, Permission.MANAGE_USERS)) throw new ForbiddenError()
  if (userId === vault.user.id) throw new ValidationError('USE_ACCOUNT')
  const existing = vault.db.queryOne('SELECT id, email FROM users WHERE id = ?', [userId])
  if (!existing) throw new ValidationError('REQUIRED')
  const email = String(existing.email)
  await assertNewPassword(password, { email, vaultName: vault.vaultName })
  const resets = openGrantRows(vault.db).filter((grant) => grant.kind === 'RESET' && grant.userId === userId)
  const salt = randomBytes(SALT_BYTES)
  const { key, verifier } = await deriveKeyAndVerifier(password, salt, CURRENT_KDF)
  const wrap = await newUserWrap(vault.dek, key, { userId, email, kdf: { ...CURRENT_KDF }, salt })
  vault.db.withTransaction(() => {
    vault.db.exec(
      'UPDATE users SET password_hash = ?, salt = ?, must_change_password = 1, password_changed_at = ? WHERE id = ?',
      [verifier, bytesToBase64(salt), new Date().toISOString(), userId],
    )
    writeAudit(vault.db, vault.user.id, 'USER_PASSWORD_RESET', 'user', userId, { email })
    dropTotp(vault.db, vault.user.id, userId, 'PASSWORD_RESET')
    const at = new Date().toISOString()
    for (const grant of resets) {
      endGrant(vault.db, grant.id, 'REPLACED', vault.user.id, at)
      writeAudit(vault.db, vault.user.id, 'RESET_REVOKED', 'grant', grant.id, { email, reason: 'REPLACED' })
    }
  })
  for (const grant of resets) dropEnvelopeGrant(vault, grant.id)
  const index = vault.wraps.findIndex((item) => item.userId === userId)
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
  const grants = openGrantRows(vault.db).filter((grant) => grant.userId === userId)
  vault.db.withTransaction(() => {
    writeAudit(vault.db, vault.user.id, 'USER_DELETED', 'user', userId, { email })
    vault.db.exec('DELETE FROM safe_events WHERE owner_user_id = ?', [userId])
    vault.db.exec('DELETE FROM secure_items WHERE owner_user_id = ?', [userId])
    vault.db.exec('DELETE FROM safes WHERE owner_user_id = ?', [userId])
    vault.db.exec('DELETE FROM user_keys WHERE user_id = ?', [userId])
    vault.db.exec('DELETE FROM users WHERE id = ?', [userId])
  })
  for (const grant of grants) dropEnvelopeGrant(vault, grant.id)
  const index = vault.wraps.findIndex((wrap) => wrap.userId === userId)
  if (index >= 0) vault.wraps.splice(index, 1)
}
