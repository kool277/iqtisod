import type { DekWrap } from '../crypto/ecies'
import type { IdentityBlob } from '../crypto/identity'
import { isArgon2Params } from '../crypto/kdf'
import { SUITE, type Suite } from '../crypto/suite'
import { FormatTooNewError } from '../domain/errors'
import { LIMITS } from '../lib/limits'

export type FounderRef = { memberId: string; sigPub: string; fingerprint: string }
export type RosterRef = { version: number; hash: string }
export type HeaderSig = { by: string; alg: 'Ed25519'; value: string }

/** The per-person-keys part of a version 3 record. Every value is JSON, stored the same way in IndexedDB and in backups. */
export type KeysHeader = {
  suite: Suite
  vaultId: string
  epoch: number
  founder: FounderRef
  roster: RosterRef
  identities: Record<string, IdentityBlob>
  dekWraps: Record<string, DekWrap>
  sig: HeaderSig
}

export const KEYS_HEADER_FIELDS = ['suite', 'vaultId', 'epoch', 'founder', 'roster', 'identities', 'dekWraps', 'sig'] as const

const ID = /^[A-Za-z0-9_-]{1,64}$/
const HEX64 = /^[0-9a-f]{64}$/

type Check = (value: unknown) => boolean

const str = (max: number): Check => (value) => typeof value === 'string' && value.length > 0 && value.length <= max
const id: Check = (value) => typeof value === 'string' && ID.test(value)
const int: Check = (value) => Number.isSafeInteger(value) && (value as number) >= 1
const b64 =
  (bytes: number | null, maxChars = 4096): Check =>
  (value) => {
    if (typeof value !== 'string' || value.length % 4 !== 0 || value.length > maxChars || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false
    const size = (value.length / 4) * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0)
    return bytes === null || size === bytes
  }

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True when `value` is a plain object with exactly these keys and every check passes. */
function shape(value: unknown, checks: Record<string, Check>): value is Record<string, unknown> {
  if (!isPlain(value)) return false
  const keys = Object.keys(value)
  // Own keys only: `in` would also match toString, valueOf and the rest of Object.prototype.
  return keys.length === Object.keys(checks).length && keys.every((key) => Object.hasOwn(checks, key) && checks[key](value[key]))
}

const pub = b64(32)

const isIdentityBlob = (memberId: string): Check => (value) =>
  shape(value, {
    v: (v) => v === 2,
    suite: (v) => v === SUITE,
    memberId: (v) => v === memberId,
    email: str(LIMITS.emailChars),
    kdf: (v) => isArgon2Params(v) && Object.keys(v).length === 6,
    salt: b64(16),
    iv: b64(12),
    sealed: b64(null, 1024),
    encPub: pub,
    sigPub: pub,
  })

const isDekWrap = (memberId: string): Check => (value) =>
  shape(value, {
    v: (v) => v === 2,
    suite: (v) => v === SUITE,
    epoch: int,
    memberId: (v) => v === memberId,
    epk: pub,
    salt: b64(32),
    iv: b64(12),
    ct: b64(48),
  })

function isMap(value: unknown, entry: (key: string) => Check, min: number): boolean {
  if (!isPlain(value)) return false
  const keys = Object.keys(value)
  return keys.length >= min && keys.length <= LIMITS.wraps && keys.every((key) => ID.test(key) && entry(key)(value[key]))
}

const HEADER_CHECKS: Record<(typeof KEYS_HEADER_FIELDS)[number], Check> = {
  suite: (v) => v === SUITE,
  vaultId: id,
  epoch: int,
  founder: (v) => shape(v, { memberId: id, sigPub: pub, fingerprint: (f) => typeof f === 'string' && /^[0-9a-f]{32}$/.test(f) }),
  roster: (v) => shape(v, { version: int, hash: (h) => typeof h === 'string' && HEX64.test(h) }),
  identities: (v) => isMap(v, isIdentityBlob, 1),
  dekWraps: (v) => isMap(v, isDekWrap, 1),
  sig: (v) => shape(v, { by: id, alg: (a) => a === 'Ed25519', value: b64(64) }),
}

/**
 * Refuses, as made by a newer version, a header that names a suite, an identity or wrap version, or a KDF that a later
 * release may add, so that it is not reported as damaged (data-format.md, "Changing a format"). Anything else is left to
 * {@link readKeysHeader}.
 */
export function assertKnownKeysFormat(source: Record<string, unknown>): void {
  const later = (value: unknown, known: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 64 && value !== known
  const newer = (value: unknown, current: number) => Number.isSafeInteger(value) && (value as number) > current
  const entries = (value: unknown) => (isPlain(value) ? Object.values(value).filter(isPlain) : [])
  if (later(source.suite, SUITE)) throw new FormatTooNewError()
  for (const blob of entries(source.identities)) {
    if (newer(blob.v, 2) || later(blob.suite, SUITE) || (isPlain(blob.kdf) && later(blob.kdf.name, 'Argon2id'))) throw new FormatTooNewError()
  }
  for (const wrap of entries(source.dekWraps)) if (newer(wrap.v, 2) || later(wrap.suite, SUITE)) throw new FormatTooNewError()
}

/** Reads the header fields out of a record or backup object, or returns null when any is malformed. */
export function readKeysHeader(source: Record<string, unknown>): KeysHeader | null {
  for (const field of KEYS_HEADER_FIELDS) if (!HEADER_CHECKS[field](source[field])) return null
  const header = copyKeysHeader(source as unknown as KeysHeader)
  const emails = Object.values(header.identities).map((blob) => blob.email.toLowerCase())
  if (new Set(emails).size !== emails.length) return null
  return header
}

export function copyKeysHeader(keys: KeysHeader): KeysHeader {
  const out = {} as Record<string, unknown>
  for (const field of KEYS_HEADER_FIELDS) out[field] = JSON.parse(JSON.stringify(keys[field])) as unknown
  return out as KeysHeader
}
