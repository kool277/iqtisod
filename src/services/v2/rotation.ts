import { ForbiddenError } from '../../domain/errors'
import type { OpenVault } from '../../domain/types'
import { writeAudit } from '../audit.service'
import { endGrant, grantAuditAction, openGrantRows } from '../grant-store'
import { latestRosterDoc, readBindings } from './roster-store'
import type { KeysSession } from './session'

/**
 * Key rotation (docs/design/v2.0-key-redesign.md, 4.5). Taking out someone who held this epoch's DEK starts the next
 * epoch at once: the session switches to the key it made ahead, every open code is revoked because each wraps the old
 * key, and the next save wraps the new key to everyone who stays, signs the roster version of the new epoch and
 * re-encrypts every chunk. Anyone who never held the current key (an invite never redeemed, someone still waiting
 * for a new invite after the upgrade) leaves without one.
 */

/** Whether taking `userId` out of the vault needs a new epoch. */
export function rotationNeeded(vault: OpenVault, userId: string): boolean {
  const keys = vault.keys
  return keys !== undefined && (keys.holders.includes(userId) || keys.dekWraps[userId] !== undefined)
}

/**
 * Throws unless this session can sign the roster version of the next epoch, and has its key ready. Checked before the
 * removal changes anything: an epoch that no roster version names would block the vault for everyone.
 */
export function assertCanRotate(vault: OpenVault & { keys: KeysSession }): void {
  const { keys } = vault
  const entry = latestRosterDoc(vault.db)?.members.find((member) => member.id === keys.memberId)
  if (entry?.role !== 'Admin' || !keys.nextDek) throw new ForbiddenError()
  if (entry.status === 'active' && entry.sigPub === keys.identity.sigPub) return
  // An invited Admin signs the version that admits them (see maySignRoster in vault.ts).
  const binding = entry.status === 'invited' ? readBindings(vault.db)?.find((item) => item.memberId === keys.memberId) : undefined
  if (entry.status === 'invited' && binding?.sigPub === keys.identity.sigPub && binding.inviteSigPub === entry.inviteSigPub) return
  throw new ForbiddenError()
}

export type RotationRecord = { from: number; to: number; revoked: string[] }

/**
 * Runs inside the removal's transaction: revokes every open code and records the new epoch. The session switches with
 * {@link switchEpoch} once the transaction has committed.
 */
export function recordRotation(vault: OpenVault & { keys: KeysSession }, at: string): RotationRecord {
  const from = vault.keys.epoch
  const revoked: string[] = []
  for (const grant of openGrantRows(vault.db)) {
    if (!endGrant(vault.db, grant.id, 'REVOKED', vault.user.id, at)) continue
    writeAudit(vault.db, vault.user.id, grantAuditAction(grant.kind, 'REVOKED'), 'grant', grant.id, { email: grant.email, reason: 'ROTATION' })
    revoked.push(grant.id)
  }
  writeAudit(vault.db, vault.user.id, 'EPOCH_ROTATED', 'vault', 'primary', { from, to: from + 1, codesRevoked: revoked.length })
  return { from, to: from + 1, revoked }
}

/**
 * The session moves to the next epoch: the key made ahead becomes the DEK, no wrap of the old key is kept (every code
 * in the envelope wraps it), and nobody holds the new key until the next save wraps it to everyone who stays.
 */
export function switchEpoch(vault: OpenVault & { keys: KeysSession }, rotation: RotationRecord): void {
  const { keys } = vault
  if (!keys.nextDek || keys.epoch !== rotation.from) throw new Error('No key ready for the next epoch')
  vault.grants = []
  vault.dek = keys.nextDek
  keys.nextDek = null
  keys.epoch = rotation.to
  keys.dekWraps = {}
  keys.holders = []
}
