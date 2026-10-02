import { setSetting } from '../db/settings'
import type { SqlDatabase } from '../db/sqlite'
import type { UserStatus } from '../domain/types'
import { LIMITS } from '../lib/limits'

/** Absent means active. A suspended or former member has no password copy in the envelope and cannot sign in. */
export type { UserStatus }

export type UserProfile = {
  displayName: string | null
  updatedAt: string | null
  lastSignInAt: string | null
  status: UserStatus
  statusAt: string | null
}

/**
 * One `settings` row per person, so the schema stays at version 4 and older versions open the vault unchanged
 * (they ignore the rows; a suspended person still has no password copy there).
 */
export const PROFILE_PREFIX = 'user_profile:'

const EMPTY: UserProfile = { displayName: null, updatedAt: null, lastSignInAt: null, status: 'ACTIVE', statusAt: null }
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

function when(value: unknown): string | null {
  return typeof value === 'string' && ISO.test(value) ? value : null
}

export function parseProfile(text: string | null): UserProfile {
  if (!text || text.length > 1024) return { ...EMPTY }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ...EMPTY }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...EMPTY }
  const value = raw as Record<string, unknown>
  const name = typeof value.displayName === 'string' ? value.displayName.trim().slice(0, LIMITS.nameChars) : ''
  return {
    displayName: name || null,
    updatedAt: when(value.updatedAt),
    lastSignInAt: when(value.lastSignInAt),
    status: value.status === 'SUSPENDED' || value.status === 'FORMER' ? value.status : 'ACTIVE',
    statusAt: when(value.statusAt),
  }
}

function serialize(profile: UserProfile): string {
  const out: Record<string, string> = {}
  if (profile.displayName) out.displayName = profile.displayName
  if (profile.updatedAt) out.updatedAt = profile.updatedAt
  if (profile.lastSignInAt) out.lastSignInAt = profile.lastSignInAt
  if (profile.status !== 'ACTIVE') out.status = profile.status
  if (profile.statusAt) out.statusAt = profile.statusAt
  return JSON.stringify(out)
}

export function readProfile(db: SqlDatabase, userId: string): UserProfile {
  const value = db.queryValue('SELECT value FROM settings WHERE key = ?', [PROFILE_PREFIX + userId])
  return parseProfile(value == null ? null : String(value))
}

export function readProfiles(db: SqlDatabase): Map<string, UserProfile> {
  const rows = db.query('SELECT key, value FROM settings WHERE substr(key, 1, ?) = ?', [PROFILE_PREFIX.length, PROFILE_PREFIX])
  return new Map(rows.map((row) => [String(row.key).slice(PROFILE_PREFIX.length), parseProfile(String(row.value))]))
}

export function writeProfile(db: SqlDatabase, userId: string, patch: Partial<UserProfile>): UserProfile {
  const next = { ...readProfile(db, userId), ...patch }
  const text = serialize(next)
  if (text === '{}') dropProfile(db, userId)
  else setSetting(db, PROFILE_PREFIX + userId, text)
  return next
}

export function dropProfile(db: SqlDatabase, userId: string): void {
  db.exec('DELETE FROM settings WHERE key = ?', [PROFILE_PREFIX + userId])
}

export function userStatus(db: SqlDatabase, userId: string): UserStatus {
  return readProfile(db, userId).status
}

/** Sign-ins are recorded at most this often, so opening the vault repeatedly does not rewrite it each time. */
export const SIGN_IN_RESOLUTION_MS = 10 * 60_000

/** Notes a completed sign-in. Returns whether anything changed, so the caller knows to save. */
export function noteSignIn(db: SqlDatabase, userId: string, now = new Date()): boolean {
  const previous = readProfile(db, userId).lastSignInAt
  if (previous && now.getTime() - Date.parse(previous) < SIGN_IN_RESOLUTION_MS && now.getTime() >= Date.parse(previous)) return false
  writeProfile(db, userId, { lastSignInAt: now.toISOString() })
  return true
}
