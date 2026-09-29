import { CURRENT_KDF, SALT_BYTES, deriveKeyAndVerifier, randomBytes, wrapDek } from '../crypto/crypto.service'
import { bytesToBase64 } from '../crypto/encoding'
import { ValidationError } from '../domain/errors'
import type { OpenVault, UserWrap } from '../domain/types'
import { assertNewPassword } from '../lib/password-policy'
import { writeAudit } from './audit.service'
import { verifyOwnPassword } from './auth.service'
import { preparePasswordRewrap } from './safe.service'
import { prepareTotpRewrap } from './totp.service'

export async function changeOwnPassword(vault: OpenVault, current: string, next: string): Promise<{ safesRewrapped: boolean }> {
  if (next === current) throw new ValidationError('SAME_PASSWORD')
  await assertNewPassword(next, { email: vault.user.email, vaultName: vault.vaultName })
  await verifyOwnPassword(vault, current)
  const userId = vault.user.id
  const salt = randomBytes(SALT_BYTES)
  const kdf = { ...CURRENT_KDF }
  const { key, verifier } = await deriveKeyAndVerifier(next, salt, kdf)
  const wrapped = await wrapDek(vault.dek, key)
  const rewrap = await preparePasswordRewrap(vault, current, next)
  const totpRewrap = await prepareTotpRewrap(vault, current, next)
  const changedAt = new Date().toISOString()
  vault.db.withTransaction(() => {
    vault.db.exec(
      'UPDATE users SET password_hash = ?, salt = ?, must_change_password = 0, password_changed_at = ? WHERE id = ?',
      [verifier, bytesToBase64(salt), changedAt, userId],
    )
    rewrap?.(vault.db, changedAt)
    totpRewrap?.(vault.db, changedAt)
    writeAudit(vault.db, userId, 'PASSWORD_CHANGED', 'user', userId)
  })
  const wrap: UserWrap = { userId, email: vault.user.email, kdf, salt, iv: wrapped.iv, wrappedDek: wrapped.cipherText }
  const index = vault.wraps.findIndex((item) => item.userId === userId)
  if (index >= 0) vault.wraps[index] = wrap
  else vault.wraps.push(wrap)
  vault.user.mustChangePassword = false
  return { safesRewrapped: rewrap !== null }
}
