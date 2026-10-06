import { SALT_BOUNDS } from './crypto.service'
import { ARGON2_BOUNDS } from './kdf'

export type Argon2Request = { id: number; secret: Uint8Array; salt: Uint8Array; m: number; t: number; p: number }

/** A UTF-8 password of 256 characters is at most 1024 bytes; anything far larger is not ours. */
export const MAX_SECRET_BYTES = 4096

function within(value: unknown, bounds: { min: number; max: number }): value is number {
  return Number.isSafeInteger(value) && (value as number) >= bounds.min && (value as number) <= bounds.max
}

function plainBytes(value: unknown, min: number, max: number): value is Uint8Array {
  return value instanceof Uint8Array && value.buffer instanceof ArrayBuffer && value.byteLength >= min && value.byteLength <= max
}

/**
 * A dedicated worker hears only the page that started it, whose messages carry an empty origin (or the page's own,
 * in some engines). Anything else, or any message not shaped exactly like a request, is dropped unanswered.
 */
export function readArgon2Request(event: { origin: string; data: unknown }, ownOrigin: string): Argon2Request | null {
  if (event.origin !== '' && event.origin !== ownOrigin) return null
  const data = event.data
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const keys = Object.keys(data).sort().join(',')
  if (keys !== 'id,m,p,salt,secret,t') return null
  const { id, secret, salt, m, t, p } = data as Record<string, unknown>
  if (!within(id, { min: 1, max: Number.MAX_SAFE_INTEGER })) return null
  if (!plainBytes(secret, 1, MAX_SECRET_BYTES) || !plainBytes(salt, SALT_BOUNDS.min, SALT_BOUNDS.max)) return null
  if (!within(m, ARGON2_BOUNDS.m) || !within(t, ARGON2_BOUNDS.t) || !within(p, ARGON2_BOUNDS.p)) return null
  return { id, secret, salt, m, t, p }
}
