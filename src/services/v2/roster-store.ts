import { canonicalize } from '../../crypto/canonical'
import { readKeyBinding, readRosterDoc, rosterHash, ROSTER_ROLES, type KeyBinding, type RosterDoc, type RosterRole } from '../../crypto/roster'
import type { SqlDatabase } from '../../db/sqlite'
import { parseJsonSafely } from '../../lib/safe-json'
import { readProfiles } from '../user-profile'

/** The signed roster versions and key bindings live in the encrypted database (schema 5), beside the people they name. */

function parse(text: unknown): unknown {
  if (typeof text !== 'string') return undefined
  try {
    return parseJsonSafely(text, { maxChars: 262_144 })
  } catch {
    return undefined
  }
}

/** Every stored version in order, each checked against the hash stored beside it; null when anything is malformed. */
export async function readRosterDocs(db: SqlDatabase): Promise<RosterDoc[] | null> {
  const rows = db.query('SELECT version, hash, doc FROM roster_versions ORDER BY version')
  const docs: RosterDoc[] = []
  for (const row of rows) {
    const doc = readRosterDoc(parse(row.doc))
    if (!doc || doc.version !== Number(row.version) || (await rosterHash(doc)) !== String(row.hash)) return null
    docs.push(doc)
  }
  return docs
}

export async function latestRosterDoc(db: SqlDatabase): Promise<RosterDoc | null> {
  const row = db.queryOne('SELECT doc FROM roster_versions ORDER BY version DESC LIMIT 1')
  return row ? readRosterDoc(parse(row.doc)) : null
}

/** Appends a signed version; the table refuses updates and deletes. Returns its hash. */
export async function appendRosterDoc(db: SqlDatabase, doc: RosterDoc): Promise<string> {
  const hash = await rosterHash(doc)
  db.exec('INSERT INTO roster_versions (version, hash, doc) VALUES (?, ?, ?)', [doc.version, hash, canonicalize(doc)])
  return hash
}

/** The stored key bindings, or null when one is malformed or filed under another member. */
export function readBindings(db: SqlDatabase): KeyBinding[] | null {
  const bindings: KeyBinding[] = []
  for (const row of db.query('SELECT member_id, doc FROM key_bindings ORDER BY member_id')) {
    const binding = readKeyBinding(parse(row.doc))
    if (!binding || binding.memberId !== String(row.member_id)) return null
    bindings.push(binding)
  }
  return bindings
}

export function writeBinding(db: SqlDatabase, binding: KeyBinding): void {
  db.exec('INSERT OR REPLACE INTO key_bindings (member_id, doc) VALUES (?, ?)', [binding.memberId, canonicalize(binding)])
}

export function deleteBinding(db: SqlDatabase, memberId: string): void {
  db.exec('DELETE FROM key_bindings WHERE member_id = ?', [memberId])
}

export type PersonRow = { id: string; email: string; role: RosterRole | null; group: number | null; status: 'ACTIVE' | 'SUSPENDED' | 'FORMER' }

/** Everyone in `users`, with their role name and status; a role outside the three known ones reads as null. */
export function readPeople(db: SqlDatabase): PersonRow[] {
  const profiles = readProfiles(db)
  return db
    .query('SELECT u.id, u.email, r.name AS role_name, u.group_id FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.id')
    .map((row) => {
      const role = String(row.role_name)
      return {
        id: String(row.id),
        email: String(row.email),
        role: (ROSTER_ROLES as readonly string[]).includes(role) ? (role as RosterRole) : null,
        group: row.group_id == null ? null : Number(row.group_id),
        status: profiles.get(String(row.id))?.status ?? 'ACTIVE',
      }
    })
}
