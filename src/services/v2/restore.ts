import { verifyRosterChain, type RosterDoc } from '../../crypto/roster'
import { assertSuite } from '../../crypto/suite'
import type { KeysRecord } from '../../db/envelope'
import { AuthError, ValidationError } from '../../domain/errors'
import type { OpenVault } from '../../domain/types'
import { revokeGrant } from '../grant.service'
import { openGrantRows } from '../grant-store'
import { userStatus } from '../user-profile'
import { suspendUser } from '../user.service'
import { readBindings, readPeople, readRosterDocs } from './roster-store'
import { keepRosterTail, resetRosterSeen, rosterSeen, rosterTailOf, type KeysSession } from './session'
import { chainHashes, keptTail, tailPosition } from './tail'
import { unlockKeysVault } from './vault'

/**
 * Restoring a backup with per-person keys over the vault (docs/design/v2.0-key-redesign.md, 4.9 and 4.10). The backup
 * must pass the checks of a sign-in first, signed in as the person restoring it. One behind what this browser saw (older,
 * or forked from it) replaces the vault only when they choose so, and everyone whose access in it ended since is taken
 * out again, with a new key.
 */

/**
 * Someone whose access in the backup ended in the roster versions this browser kept: removed, or given new keys, since.
 * `invite` is an invite they never redeemed, which is revoked; anyone else holds keys in the backup and is suspended.
 */
export type RestoreRemoval = { id: string; email: string; invite: boolean }

export type KeysBackupCheck = {
  /** The backup, signed in to as the person restoring it. The caller closes it. */
  vault: OpenVault & { keys: KeysSession }
  /** Set for a backup behind what this browser saw; `removals` is null when this browser cannot tell who left. */
  older: { seen: number; version: number; removals: RestoreRemoval[] | null } | null
}

/**
 * Signs in to `record` with the person's email and password and runs every check of design 3.8 against this browser's
 * pins. A founder other than the pinned one blocks it like a sign-in; a roster behind what this browser saw does not,
 * but is reported, with who must be taken out again.
 */
export async function checkKeysBackup(record: KeysRecord, email: string, password: string): Promise<KeysBackupCheck> {
  await assertSuite()
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
 * Who must be taken out again, from the kept roster versions after the newest one this backup shares with them; null
 * when they cannot tell: they do not reach what this browser saw, do not continue a version the backup has, or do not
 * verify as its continuation.
 */
async function removedSince(vault: OpenVault & { keys: KeysSession }): Promise<RestoreRemoval[] | null> {
  const { db, keys } = vault
  const docs = await readRosterDocs(db)
  const latest = docs?.at(-1)
  if (!docs || !latest) return null
  const tail = await keptTail(keys.vaultId)
  const position = tailPosition(latest.version, chainHashes(db), tail, rosterSeen(keys.vaultId))
  const newest = tail.docs.at(-1)
  if (!position.behind || position.common === null || !newest || newest.version < rosterSeen(keys.vaultId)) return null
  const common = position.common
  // Signed the way every version must be, each linked to the one before, back through the versions both share.
  const chain = await verifyRosterChain([...docs.slice(0, common), ...tail.docs.filter((doc) => doc.version > common)], keys.vaultId)
  if ('problem' in chain) return null
  return endedAccess(vault, latest, chain.latest)
}

/**
 * Everyone with access in the backup whose access the newer version no longer gives: anyone holding keys there who is
 * not active with the same keys now, and any open invite there that is not still open or redeemed now.
 */
function endedAccess(vault: OpenVault & { keys: KeysSession }, latest: RosterDoc, now: RosterDoc): RestoreRemoval[] {
  const bindings = new Map((readBindings(vault.db) ?? []).map((binding) => [binding.memberId, binding]))
  const people = new Map(readPeople(vault.db).map((person) => [person.id, person]))
  const current = new Map(now.members.map((member) => [member.id, member]))
  return latest.members.flatMap((member): RestoreRemoval[] => {
    if (member.status === 'removed' || member.id === vault.keys.memberId) return []
    const later = current.get(member.id)
    const binding = member.status === 'invited' ? bindings.get(member.id) : undefined
    const held = member.status === 'active' ? { encPub: member.encPub, sigPub: member.sigPub } : binding && binding.inviteSigPub === member.inviteSigPub ? binding : null
    if (held) {
      if (later?.status === 'active' && later.encPub === held.encPub && later.sigPub === held.sigPub) return []
      const person = people.get(member.id)
      return person?.status === 'ACTIVE' ? [{ id: member.id, email: person.email, invite: false }] : []
    }
    if (member.status !== 'invited' || later?.status === 'active' || (later?.status === 'invited' && later.inviteSigPub === member.inviteSigPub)) return []
    return [{ id: member.id, email: member.email, invite: true }]
  })
}

/**
 * Takes out again, in the restored backup, everyone whose access ended since: each who holds keys is suspended (which
 * makes a new key, since they held this one), each open invite revoked. Suspension keeps their records and can be undone.
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

/**
 * What this browser keeps once a restored copy is stored: it expects that copy's roster from then on, and keeps its
 * versions. Read now, so the restored session can be closed before the vault is written.
 */
export function adoptionOf(vault: OpenVault & { keys: KeysSession }, record: KeysRecord): () => void {
  const docs = rosterTailOf(vault.db, record.keys.roster.version)
  return () => {
    resetRosterSeen(record.keys.vaultId, record.keys.roster.version)
    keepRosterTail(record.keys.vaultId, docs)
  }
}
