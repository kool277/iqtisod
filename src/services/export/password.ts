import { deriveKey } from '../../crypto/crypto.service'
import { unwrapUserDek } from '../../crypto/user-wrap'
import { ValidationError } from '../../domain/errors'
import type { OpenVault } from '../../domain/types'
import { passwordProblem as signInPasswordProblem, violatesContext } from '../../lib/password-policy'
import type { Protection } from './options'

export const EXPORT_PASSWORD_MIN = 14
export const GENERATOR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const GENERATOR_GROUPS = 6
export const GENERATOR_GROUP_SIZE = 4

export type Strength = 'weak' | 'fair' | 'strong'

const FAIR_BITS = 60
const STRONG_BITS = 80

export function isPrintableAscii(text: string): boolean {
  return /^[\x20-\x7e]*$/.test(text)
}

function poolSize(text: string): number {
  let pool = 0
  if (/[a-z]/.test(text)) pool += 26
  if (/[A-Z]/.test(text)) pool += 26
  if (/[0-9]/.test(text)) pool += 10
  if (/[^a-zA-Z0-9]/.test(text)) pool += 33
  return pool
}

export function estimateBits(password: string): number {
  const pool = poolSize(password)
  if (pool === 0) return 0
  const perChar = Math.log2(pool)
  const seen = new Map<string, number>()
  let bits = 0
  let previous: number | null = null
  let lastDelta: number | null = null
  for (const char of password) {
    const code = char.charCodeAt(0)
    const delta = previous === null ? null : code - previous
    const count = (seen.get(char) ?? 0) + 1
    seen.set(char, count)
    let weight = 1
    if (delta === 0) weight = 0
    else if (delta === 1 || delta === -1) weight = delta === lastDelta ? 0.25 : 0.5
    else if (count > 2) weight = 0.5
    bits += weight * perChar
    previous = code
    lastDelta = delta
  }
  return bits
}

export function estimateStrength(password: string): Strength {
  const bits = estimateBits(password)
  if (bits >= STRONG_BITS) return 'strong'
  if (bits >= FAIR_BITS) return 'fair'
  return 'weak'
}

/**
 * ZIP AES derives its key with a fixed 1,000 rounds of PBKDF2-SHA1, so an offline guess costs almost nothing:
 * only a strong password (such as the generated 120-bit one) holds up. SQLCipher uses 256,000 rounds, so fair is allowed.
 */
export function passwordProblem(password: string, confirm?: string, protection?: Protection): string | null {
  if (password.length < EXPORT_PASSWORD_MIN) return 'EXPORT_PASSWORD_SHORT'
  if (!isPrintableAscii(password)) return 'EXPORT_PASSWORD_ASCII'
  const strength = estimateStrength(password)
  if (strength === 'weak') return 'EXPORT_PASSWORD_WEAK'
  if (protection === 'zip' && strength !== 'strong') return 'EXPORT_PASSWORD_ZIP_WEAK'
  if (confirm !== undefined && confirm !== password) return 'EXPORT_PASSWORD_MISMATCH'
  return null
}

export function assertExportPassword(password: string, confirm?: string, protection?: Protection): void {
  const problem = passwordProblem(password, confirm, protection)
  if (problem) throw new ValidationError(problem)
}

export type ExportPasswordContext = { vaultName: string | null; emails: readonly string[] }

/** The sign-in password rules that need the common-password list or the vault's names. */
export async function commonExportPasswordProblem(password: string, context: ExportPasswordContext): Promise<string | null> {
  const problem = await signInPasswordProblem(password, { vaultName: context.vaultName })
  if (problem === 'PASSWORD_COMMON') return 'EXPORT_PASSWORD_COMMON'
  if (problem === 'PASSWORD_CONTEXT' || context.emails.some((email) => violatesContext(password, { email }))) return 'EXPORT_PASSWORD_CONTEXT'
  return null
}

export function generateExportPassword(random: (length: number) => Uint8Array = defaultRandom): string {
  const bytes = random(GENERATOR_GROUPS * GENERATOR_GROUP_SIZE)
  const chars = Array.from(bytes, (byte) => GENERATOR_ALPHABET[byte % GENERATOR_ALPHABET.length])
  const groups: string[] = []
  for (let index = 0; index < chars.length; index += GENERATOR_GROUP_SIZE) {
    groups.push(chars.slice(index, index + GENERATOR_GROUP_SIZE).join(''))
  }
  bytes.fill(0)
  return groups.join('-')
}

function defaultRandom(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

export async function isSignInPassword(vault: OpenVault, password: string): Promise<boolean> {
  const wrap = vault.wraps.find((item) => item.userId === vault.user.id)
  if (!wrap) return false
  try {
    await unwrapUserDek(wrap, await deriveKey(password, wrap.salt, wrap.kdf))
    return true
  } catch {
    return false
  }
}
