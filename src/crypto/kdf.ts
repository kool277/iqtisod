/** Argon2id parameters, stored with every v2 password wrap so they can be raised later (RFC 9106, version 0x13). */
export type Argon2Params = { name: 'Argon2id'; m: number; t: number; p: number; len: 32; v: 19 }

export const ARGON2_DEFAULT: Argon2Params = { name: 'Argon2id', m: 65_536, t: 3, p: 1, len: 32, v: 19 }

/** Anything outside these bounds is refused before any memory is allocated, so a crafted file cannot ask for gigabytes. */
export const ARGON2_BOUNDS = { m: { min: 19_456, max: 262_144 }, t: { min: 2, max: 10 }, p: { min: 1, max: 4 } } as const

function within(value: unknown, bounds: { min: number; max: number }): boolean {
  return Number.isSafeInteger(value) && (value as number) >= bounds.min && (value as number) <= bounds.max
}

export function isArgon2Params(value: unknown): value is Argon2Params {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const kdf = value as Record<string, unknown>
  return (
    kdf.name === 'Argon2id' &&
    within(kdf.m, ARGON2_BOUNDS.m) &&
    within(kdf.t, ARGON2_BOUNDS.t) &&
    within(kdf.p, ARGON2_BOUNDS.p) &&
    kdf.len === 32 &&
    kdf.v === 19
  )
}

export function copyArgon2Params(kdf: Argon2Params): Argon2Params {
  return { name: 'Argon2id', m: kdf.m, t: kdf.t, p: kdf.p, len: 32, v: 19 }
}

export function argon2BelowDefault(kdf: Argon2Params): boolean {
  return kdf.m < ARGON2_DEFAULT.m || kdf.t < ARGON2_DEFAULT.t
}
