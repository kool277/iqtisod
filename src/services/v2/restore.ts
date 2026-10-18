import { readRosterDoc, verifyRosterChain, type RosterDoc } from '../../crypto/roster'
import type { KeysRecord } from '../../db/envelope'
import { AuthError, ValidationError } from '../../domain/errors'
import type { OpenVault } from '../../domain/types'
import { parseJsonSafely } from '../../lib/safe-json'
import { revokeGrant } from '../grant.service'
import { openGrantRows } from '../grant-store'
import { userStatus } from '../user-profile'
import { suspendUser } from '../user.service'
import { readPeople, readRosterDocs } from './roster-store'
import { noteRosterTail, resetRosterSeen, rosterSeen, rosterTailDocs, type KeysSession } from './session'
import { unlockKeysVault } from './vault'

/**
 * Restoring a backup with per-person keys over the vault (docs/design/v2.0-key-redesign.md, 4.9 and 4.10). The backup
 * must pass the checks of a sign-in first, signed in as the person restoring it. One older than this browser has seen
 * replaces the vault only when they choose so, and the people removed since are then taken out again, with a new key.
 */

/** Someone the newer roster versions this browser kept took out: a member, or an invite they revoked. */
export type RestoreRemoval = { id: string; email: string; invite: boolean }

export type KeysBackupCheck = {
  /** The backup, signed in to as the person restoring it. The caller closes it. */
  vault: OpenVault & { keys: KeysSession }
  /** Set for a backup older than this browser has seen; `removals` is null when this browser cannot tell who left. */
  older: { seen: number; version: number; removals: RestoreRemoval[] | null } | null
}

function parsed(text: string): unknown {
  try {
    return parseJsonSafely(text, { maxChars: 262_144 })
  } catch {
    return undefined
  }
}

/**
 * Signs in to `record` with the person's email and password and runs every check of design 3.8 against this browser's
 * pins. A founder other than the pinned one blocks it like a sign-in; a roster older than this browser has seen does
 * not, but is reported, with who was removed since.
 */
export async function checkKeysBackup(record: KeysRecord, email: string, password: string): Promise<KeysBackupCheck> {
  let vault: OpenVault & { keys: KeysSession }
  try {
    vault = await unlockKeysVault(record, email, password, { acceptRollback: true })
  } catch (error) {
    if (error instanceof AuthError) throw new ValidationError('BACKUP_KEYS_PASSWORD')
    throw error
  }
  if (!vault.keys.acceptedRollback) return { vault, older: null }
  try {
    return { vault, older: { seen: rosterSeen(vault.keys.vaultId), version: vault.keys.roster.version, removals: await removedSince(vault) } }
  } catch (error) {
    vault.db.close()
    throw error
  }
}

/**
 * Who the roster versions this browser kept took out after the backup's latest version, or null when they do not
 * continue the backup's own chain: missing versions, another vault, or any version that does not verify.
 */
async function removedSince(vault: OpenVault & { keys: KeysSession }): Promise<RestoreRemoval[] | null> {
  const { db, keys } = vault
  const docs = await readRosterDocs(db)
  const latest = docs?.at(-1)
  if (!docs || !latest) return null
  const newer = rosterTailDocs(keys.vaultId)
    .map((text) => readRosterDoc(parsed(text)))
    .filter((doc): doc is RosterDoc => doc !== null && doc.version > latest.version)
    .sort((left, right) => left.version - right.version)
  if (newer.length === 0 || newer[0].version !== latest.version + 1) return null
  // Signed the way every version must be, each linked to the one before, back through the backup's own versions.
  const chain = await verifyRosterChain([...docs, ...newer], keys.vaultId)
  if ('problem' in chain) return null
  const now = new Map(chain.latest.members.map((member) => [member.id, member]))
  const people = new Map(readPeople(db).map((person) => [person.id, person]))
  return latest.members.flatMap((member): RestoreRemoval[] => {
    if (member.status === 'removed' || member.id === keys.memberId || now.get(member.id)?.status !== 'removed') return []
    if (member.status === 'invited') return [{ id: member.id, email: member.email, invite: true }]
    const person = people.get(member.id)
    return person?.status === 'ACTIVE' ? [{ id: member.id, email: person.email, invite: false }] : []
  })
}

/**
 * Takes out again, in the restored backup, the people removed since: each member is suspended (which makes a new key
 * if they held this one), each invite revoked. Suspension keeps their records and can be undone.
 */
export function takeOutAgain(vault: OpenVault & { keys: KeysSession }, removals: readonly RestoreRemoval[]): void {
  for (const removal of removals) {
    if (removal.invite) {
      const grant = openGrantRows(vault.db).find((row) => (row.kind === 'INVITE' ? row.id : row.userId) === removal.id)
      if (grant) revokeGrant(vault, grant.id)
    } else if (userStatus(vault.db, removal.id) === 'ACTIVE') {
      suspendUser(vault, removal.id)
    }
  }
}

/** After a restored older copy is stored, this browser expects its roster from now on, and keeps its versions. */
export function adoptRestored(vault: OpenVault & { keys: KeysSession }, record: KeysRecord): void {
  resetRosterSeen(record.keys.vaultId, record.keys.roster.version)
  noteRosterTail(vault, record.keys.roster.version)
}
