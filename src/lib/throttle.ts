import { bytesToHex } from '../crypto/encoding'
import { readAux, writeAux } from '../db/storage'
import { AppError } from '../domain/errors'
import { sha256 } from './sha256'

/** `check` counts sign-ins where the password was right but the sign-in check was not passed; it never locks anything. */
export type ThrottleScope = 'login' | 'code' | 'totp' | 'safe' | 'check'

type Entry = { n: number; first: number; last: number }
type State = Record<string, Entry>
type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>

/** A second, asynchronous copy of the counters (IndexedDB in the browser), so clearing local storage alone does not reset them. */
export type ThrottleMirror = { load: () => Promise<unknown>; save: (state: State) => Promise<void> }

export const THROTTLE_KEY = 'moliya.guard.v1'
export const THROTTLE_MIRROR_KEY = 'guard.throttle.v1'
export const FREE_FAILURES = 5
export const GLOBAL_FREE_FAILURES = 20
export const BASE_LOCKOUT_MS = 30_000
export const MAX_LOCKOUT_MS = 15 * 60_000
export const ENTRY_TTL_MS = 24 * 60 * 60_000
export const MAX_ENTRIES = 64

export class ThrottledError extends AppError {
  constructor(readonly waitMs: number) {
    super('THROTTLED')
    this.name = 'ThrottledError'
  }
}

export function lockoutMs(failures: number, free: number): number {
  if (failures < free) return 0
  return Math.min(BASE_LOCKOUT_MS * 2 ** (failures - free), MAX_LOCKOUT_MS)
}

function emailKey(scope: ThrottleScope, email: string): string {
  const digest = bytesToHex(sha256(new TextEncoder().encode(`moliya-throttle|${email.trim().toLowerCase()}`)))
  return `${scope}|${digest.slice(0, 16)}`
}

function globalKey(scope: ThrottleScope): string {
  return `${scope}|*`
}

function browserStorage(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function isEntry(value: unknown): value is Entry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return [entry.n, entry.first, entry.last].every((field) => Number.isSafeInteger(field) && (field as number) >= 0)
}

function parseState(value: unknown): State {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const state: State = {}
  for (const [key, entry] of Object.entries(value)) if (/^[a-z]+\|(?:\*|[0-9a-f]{16})$/.test(key) && isEntry(entry)) state[key] = { n: entry.n, first: entry.first, last: entry.last }
  return state
}

/** Keeps the larger count and the widest time span of each entry, so no copy can lower another. */
function merge(...states: State[]): State {
  const merged: State = {}
  for (const state of states) {
    for (const [key, entry] of Object.entries(state)) {
      const known = merged[key]
      merged[key] = known ? { n: Math.max(known.n, entry.n), first: Math.min(known.first, entry.first), last: Math.max(known.last, entry.last) } : { ...entry }
    }
  }
  return merged
}

export type SignInFailures = { failures: number; since: string | null }

export type Throttle = {
  wait: (scope: ThrottleScope, email: string) => number
  fail: (scope: ThrottleScope, email: string) => number
  /** Counts an event for this email only, without touching the global counter. */
  note: (scope: ThrottleScope, email: string) => void
  peek: (scope: ThrottleScope, email: string) => SignInFailures
  succeed: (scope: ThrottleScope, email: string) => SignInFailures
  /** Resolves once the mirror copy has been merged in. */
  ready: Promise<void>
}

export function createThrottle(options: { storage?: KeyValueStore | null; now?: () => number; mirror?: ThrottleMirror | null } = {}): Throttle {
  const storage = options.storage === undefined ? browserStorage() : options.storage
  const mirror = options.mirror ?? null
  const now = options.now ?? Date.now
  let memory: State = {}
  // Once a write fails, storage no longer reflects new failures, so count in memory for this tab.
  let persistent = storage !== null
  // Entries cleared by a success; a stale copy elsewhere must not bring them back.
  const cleared = new Map<string, number>()

  const load = (): State => {
    let stored: State = {}
    if (storage && persistent) {
      try {
        stored = parseState(JSON.parse(storage.getItem(THROTTLE_KEY) ?? '{}'))
      } catch {
        stored = {}
      }
    }
    return merge(memory, withoutCleared(stored))
  }

  const withoutCleared = (state: State): State => {
    const kept: State = {}
    for (const [key, entry] of Object.entries(state)) if (entry.last > (cleared.get(key) ?? -1)) kept[key] = entry
    return kept
  }

  const save = (state: State) => {
    const current = now()
    const kept = Object.entries(state)
      .filter(([, entry]) => current - entry.last < ENTRY_TTL_MS)
      .sort(([, left], [, right]) => right.last - left.last)
      .slice(0, MAX_ENTRIES)
    memory = Object.fromEntries(kept)
    if (mirror) void mirror.save(memory).catch(() => undefined)
    if (!storage || !persistent) return
    try {
      storage.setItem(THROTTLE_KEY, JSON.stringify(memory))
    } catch {
      persistent = false
    }
  }

  const ready = mirror
    ? mirror
        .load()
        .then((value) => {
          memory = merge(memory, withoutCleared(parseState(value)))
        })
        .catch(() => undefined)
    : Promise.resolve()

  const live = (state: State, key: string): Entry | null => {
    const entry = state[key]
    if (!entry) return null
    return now() - entry.last >= ENTRY_TTL_MS ? null : entry
  }

  const remaining = (entry: Entry | null, free: number): number => {
    if (!entry) return 0
    const elapsed = Math.max(0, now() - entry.last)
    return Math.max(0, lockoutMs(entry.n, free) - elapsed)
  }

  const wait = (scope: ThrottleScope, email: string): number => {
    const state = load()
    const own = live(state, emailKey(scope, email))
    // Failures spread over other addresses must not lock out an account that has none of its own.
    const global = own ? remaining(live(state, globalKey(scope)), GLOBAL_FREE_FAILURES) : 0
    return Math.max(remaining(own, FREE_FAILURES), global)
  }

  const bump = (state: State, key: string) => {
    const current = now()
    const entry = live(state, key)
    state[key] = entry ? { n: entry.n + 1, first: entry.first, last: Math.max(current, entry.last) } : { n: 1, first: current, last: current }
  }

  const summary = (entry: Entry | null): SignInFailures => ({ failures: entry?.n ?? 0, since: entry ? new Date(entry.first).toISOString() : null })

  return {
    wait,
    ready,
    fail(scope, email) {
      const state = load()
      bump(state, emailKey(scope, email))
      bump(state, globalKey(scope))
      save(state)
      return wait(scope, email)
    },
    note(scope, email) {
      const state = load()
      bump(state, emailKey(scope, email))
      save(state)
    },
    peek(scope, email) {
      return summary(live(load(), emailKey(scope, email)))
    },
    succeed(scope, email) {
      const state = load()
      const key = emailKey(scope, email)
      const entry = live(state, key)
      const at = now()
      cleared.set(key, Math.max(at, entry?.last ?? at))
      cleared.set(globalKey(scope), Math.max(at, state[globalKey(scope)]?.last ?? at))
      delete state[key]
      delete state[globalKey(scope)]
      memory = {}
      save(state)
      return summary(entry)
    },
  }
}

/** Mirrors the counters into the vault's IndexedDB database, beside the record. */
export function indexedDbThrottleMirror(): ThrottleMirror | null {
  if (typeof indexedDB === 'undefined') return null
  return { load: () => readAux(THROTTLE_MIRROR_KEY), save: (state) => writeAux(THROTTLE_MIRROR_KEY, state) }
}

export function formatWait(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}:${String(seconds % 60).padStart(2, '0')}` : `0:${String(seconds).padStart(2, '0')}`
}
