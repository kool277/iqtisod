import { bytesToHex } from '../crypto/encoding'
import { AppError } from '../domain/errors'
import { sha256 } from './sha256'

export type ThrottleScope = 'login' | 'code' | 'totp' | 'safe'

type Entry = { n: number; first: number; last: number }
type State = Record<string, Entry>
type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>

export const THROTTLE_KEY = 'moliya.guard.v1'
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

export type Throttle = {
  wait: (scope: ThrottleScope, email: string) => number
  fail: (scope: ThrottleScope, email: string) => number
  succeed: (scope: ThrottleScope, email: string) => { failures: number; since: string | null }
}

export function createThrottle(options: { storage?: KeyValueStore | null; now?: () => number } = {}): Throttle {
  const storage = options.storage === undefined ? browserStorage() : options.storage
  const now = options.now ?? Date.now
  let memory: State = {}

  const load = (): State => {
    if (!storage) return memory
    try {
      const parsed = JSON.parse(storage.getItem(THROTTLE_KEY) ?? '{}') as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
      const state: State = {}
      for (const [key, value] of Object.entries(parsed)) if (isEntry(value)) state[key] = value
      return state
    } catch {
      return memory
    }
  }

  const save = (state: State) => {
    const current = now()
    const kept = Object.entries(state)
      .filter(([, entry]) => current - entry.last < ENTRY_TTL_MS)
      .sort(([, left], [, right]) => right.last - left.last)
      .slice(0, MAX_ENTRIES)
    memory = Object.fromEntries(kept)
    if (!storage) return
    try {
      storage.setItem(THROTTLE_KEY, JSON.stringify(memory))
    } catch {
      // Private browsing or a full quota: the in-memory copy still throttles this tab.
    }
  }

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
    return Math.max(remaining(live(state, emailKey(scope, email)), FREE_FAILURES), remaining(live(state, globalKey(scope)), GLOBAL_FREE_FAILURES))
  }

  const bump = (state: State, key: string) => {
    const current = now()
    const entry = live(state, key)
    state[key] = entry ? { n: entry.n + 1, first: entry.first, last: Math.max(current, entry.last) } : { n: 1, first: current, last: current }
  }

  return {
    wait,
    fail(scope, email) {
      const state = load()
      bump(state, emailKey(scope, email))
      bump(state, globalKey(scope))
      save(state)
      return wait(scope, email)
    },
    succeed(scope, email) {
      const state = load()
      const key = emailKey(scope, email)
      const entry = live(state, key)
      delete state[key]
      delete state[globalKey(scope)]
      save(state)
      return { failures: entry?.n ?? 0, since: entry ? new Date(entry.first).toISOString() : null }
    },
  }
}

export function formatWait(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}:${String(seconds % 60).padStart(2, '0')}` : `0:${String(seconds).padStart(2, '0')}`
}
