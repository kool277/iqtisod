import { deriveKey, unwrapDek } from '../../crypto/crypto.service'
import { ValidationError } from '../../domain/errors'
import type { OpenVault } from '../../domain/types'

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

export function passwordProblem(password: string, confirm?: string): string | null {
  if (password.length < EXPORT_PASSWORD_MIN) return 'EXPORT_PASSWORD_SHORT'
  if (!isPrintableAscii(password)) return 'EXPORT_PASSWORD_ASCII'
  if (estimateStrength(password) === 'weak') return 'EXPORT_PASSWORD_WEAK'
  if (confirm !== undefined && confirm !== password) return 'EXPORT_PASSWORD_MISMATCH'
  return null
}

export function assertExportPassword(password: string, confirm?: string): void {
  const problem = passwordProblem(password, confirm)
  if (problem) throw new ValidationError(problem)
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
    const key = await deriveKey(password, wrap.salt, wrap.kdf)
    await unwrapDek(wrap.wrappedDek, key, wrap.iv)
    return true
  } catch {
    return false
  }
}
