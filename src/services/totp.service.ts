import { deriveTotpKek, recoveryCodeHash } from '../crypto/access-crypto'
import { CURRENT_KDF, SALT_BYTES, isKdfParams, randomBytes, type KdfParams } from '../crypto/crypto.service'
import { base64ToBytes, bytesToBase64 } from '../crypto/encoding'
import { aad, openJson, sealJson } from '../crypto/safe-crypto'
import type { SqlDatabase } from '../db/sqlite'
import { AuthError, ForbiddenError, ValidationError } from '../domain/errors'
import type { OpenVault } from '../domain/types'
import { TOTP_SECRET_BYTES, base32Decode, base32Encode, importTotpKey, isTotpCode, otpauthUri, verifyTotp } from '../lib/totp'
import { Permission, canUser } from '../rbac'
import { writeAudit } from './audit.service'
import { verifyOwnPassword } from './auth.service'

export const RECOVERY_CODE_COUNT = 10
const RECOVERY_BYTES = 10
const RECOVERY_CHARS = 16
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

type TotpRow = {
  kdf: KdfParams
  salt: Uint8Array
  iv: string
  ciphertext: string
  lastStep: number
  recoverySalt: Uint8Array
  recoveryHashes: string[]
}

export type TotpSetup = { secret: string; uri: string }

/** Held between the password step and the code step of a sign-in. Never persisted. */
export type TotpChallenge = { userId: string; key: CryptoKey }

function readRow(db: SqlDatabase, userId: string): TotpRow | null {
  const row = db.queryOne('SELECT * FROM user_totp WHERE user_id = ?', [userId])
  if (!row) return null
  let kdf: unknown
  let hashes: unknown
  try {
    kdf = JSON.parse(String(row.kdf))
    hashes = JSON.parse(String(row.recovery_hashes))
  } catch {
    throw new AuthError()
  }
  if (!isKdfParams(kdf) || !Array.isArray(hashes)) throw new AuthError()
  return {
    kdf,
    salt: base64ToBytes(String(row.kdf_salt)),
    iv: String(row.secret_iv),
    ciphertext: String(row.secret_ciphertext),
    lastStep: Number(row.last_step),
    recoverySalt: base64ToBytes(String(row.recovery_salt)),
    recoveryHashes: hashes.map(String),
  }
}

export function hasSignInCheck(db: SqlDatabase, userId: string): boolean {
  return db.queryValue('SELECT 1 FROM user_totp WHERE user_id = ?', [userId]) != null
}

function formatRecovery(bytes: Uint8Array): string {
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  let chars = ''
  for (let index = RECOVERY_CHARS - 1; index >= 0; index -= 1) chars += CROCKFORD[Number((value >> BigInt(index * 5)) & 31n)]
  return chars
}

export function normalizeRecoveryCode(text: string): string | null {
  if (text.length > 64) return null
  const compact = text
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  if (compact.length !== RECOVERY_CHARS) return null
  for (const char of compact) if (!CROCKFORD.includes(char)) return null
  return compact
}

export function beginTotpSetup(account: string): TotpSetup {
  const bytes = randomBytes(TOTP_SECRET_BYTES)
  try {
    return { secret: base32Encode(bytes), uri: otpauthUri(bytes, account) }
  } finally {
    bytes.fill(0)
  }
}

async function sealSecret(secret: string, password: string, userId: string): Promise<{ kdf: KdfParams; salt: Uint8Array; iv: string; ct: string }> {
  const salt = randomBytes(SALT_BYTES)
  const kdf = { ...CURRENT_KDF }
  const kek = await deriveTotpKek(password, salt, kdf)
  const sealed = await sealJson({ secret }, kek, aad('moliya.totp', userId))
  return { kdf, salt, iv: sealed.iv, ct: sealed.ct }
}

async function openSecret(row: TotpRow, password: string, userId: string): Promise<string> {
  const kek = await deriveTotpKek(password, row.salt, row.kdf)
  const value = await openJson<{ secret?: unknown }>({ iv: row.iv, ct: row.ciphertext }, kek, aad('moliya.totp', userId))
  if (typeof value.secret !== 'string') throw new AuthError()
  return value.secret
}

export async function enableTotp(vault: OpenVault, password: string, setup: TotpSetup, code: string, now = Date.now()): Promise<string[]> {
  const userId = vault.user.id
  if (hasSignInCheck(vault.db, userId)) throw new ValidationError('TOTP_ENABLED')
  await verifyOwnPassword(vault, password)
  const key = await importTotpKey(base32Decode(setup.secret))
  const step = await verifyTotp(key, code.trim(), now, 0)
  if (step === null) throw new ValidationError('TOTP_INVALID')
  const sealed = await sealSecret(setup.secret, password, userId)
  const recoverySalt = randomBytes(SALT_BYTES)
  const codes: string[] = []
  const hashes: string[] = []
  for (let index = 0; index < RECOVERY_CODE_COUNT; index += 1) {
    const bytes = randomBytes(RECOVERY_BYTES)
    const canonical = formatRecovery(bytes)
    bytes.fill(0)
    codes.push(canonical.match(/.{4}/g)!.join('-'))
    hashes.push(await recoveryCodeHash(canonical, recoverySalt))
  }
  const at = new Date(now).toISOString()
  vault.db.withTransaction(() => {
    vault.db.exec(
      `INSERT INTO user_totp (user_id, enc_version, kdf, kdf_salt, secret_iv, secret_ciphertext, last_step, recovery_salt, recovery_hashes, created_at, rewrapped_at)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, JSON.stringify(sealed.kdf), bytesToBase64(sealed.salt), sealed.iv, sealed.ct, step, bytesToBase64(recoverySalt), JSON.stringify(hashes), at, at],
    )
    writeAudit(vault.db, userId, 'TOTP_ENABLED', 'user', userId)
  })
  return codes
}

export async function disableTotp(vault: OpenVault, password: string): Promise<void> {
  const userId = vault.user.id
  await verifyOwnPassword(vault, password)
  if (!hasSignInCheck(vault.db, userId)) return
  vault.db.withTransaction(() => {
    vault.db.exec('DELETE FROM user_totp WHERE user_id = ?', [userId])
    writeAudit(vault.db, userId, 'TOTP_DISABLED', 'user', userId)
  })
}

/** Deletes the row inside the caller's transaction. Returns whether one existed. */
export function dropTotp(db: SqlDatabase, actorId: string | null, userId: string, reason: 'ADMIN' | 'PASSWORD_RESET'): boolean {
  if (!hasSignInCheck(db, userId)) return false
  db.exec('DELETE FROM user_totp WHERE user_id = ?', [userId])
  writeAudit(db, actorId, 'TOTP_CLEARED', 'user', userId, { reason })
  return true
}

export function clearUserTotp(vault: OpenVault, userId: string): void {
  if (!canUser(vault.user, Permission.MANAGE_USERS)) throw new ForbiddenError()
  if (userId === vault.user.id) throw new ValidationError('USE_ACCOUNT')
  vault.db.withTransaction(() => {
    if (!dropTotp(vault.db, vault.user.id, userId, 'ADMIN')) throw new ValidationError('REQUIRED')
  })
}

export async function openTotpChallenge(vault: OpenVault, password: string): Promise<TotpChallenge | null> {
  const userId = vault.user.id
  const row = readRow(vault.db, userId)
  if (!row) return null
  let secret: string
  try {
    secret = await openSecret(row, password, userId)
  } catch {
    throw new AuthError()
  }
  return { userId, key: await importTotpKey(base32Decode(secret)) }
}

/** Accepts a current code or an unused recovery code. Returns how the check was passed. */
export async function completeTotpChallenge(
  vault: OpenVault,
  challenge: TotpChallenge,
  input: string,
  now = Date.now(),
): Promise<{ usedRecovery: boolean; recoveryLeft: number }> {
  const userId = challenge.userId
  const row = readRow(vault.db, userId)
  if (!row) throw new AuthError()
  const code = input.replace(/\s/g, '')
  if (isTotpCode(code)) {
    const step = await verifyTotp(challenge.key, code, now, row.lastStep)
    if (step === null) throw new ValidationError('TOTP_INVALID')
    vault.db.exec('UPDATE user_totp SET last_step = ? WHERE user_id = ?', [step, userId])
    return { usedRecovery: false, recoveryLeft: row.recoveryHashes.length }
  }
  const recovery = normalizeRecoveryCode(input)
  if (!recovery) throw new ValidationError('TOTP_INVALID')
  const hash = await recoveryCodeHash(recovery, row.recoverySalt)
  const index = row.recoveryHashes.indexOf(hash)
  if (index < 0) throw new ValidationError('TOTP_INVALID')
  const left = row.recoveryHashes.filter((_, position) => position !== index)
  vault.db.withTransaction(() => {
    vault.db.exec('UPDATE user_totp SET recovery_hashes = ? WHERE user_id = ?', [JSON.stringify(left), userId])
    writeAudit(vault.db, userId, 'TOTP_RECOVERY_USED', 'user', userId, { remaining: left.length })
  })
  return { usedRecovery: true, recoveryLeft: left.length }
}

/** Re-seals the secret under the new password; returns a writer for the caller's transaction, or null. */
export async function prepareTotpRewrap(vault: OpenVault, current: string, next: string): Promise<((db: SqlDatabase, at: string) => void) | null> {
  const userId = vault.user.id
  const row = readRow(vault.db, userId)
  if (!row) return null
  const secret = await openSecret(row, current, userId)
  const sealed = await sealSecret(secret, next, userId)
  return (db, at) => {
    db.exec('UPDATE user_totp SET kdf = ?, kdf_salt = ?, secret_iv = ?, secret_ciphertext = ?, rewrapped_at = ? WHERE user_id = ?', [
      JSON.stringify(sealed.kdf),
      bytesToBase64(sealed.salt),
      sealed.iv,
      sealed.ct,
      at,
      userId,
    ])
  }
}
