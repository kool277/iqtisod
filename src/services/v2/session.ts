import type { DekWrap } from '../../crypto/ecies'
import type { IdentityBlob, IdentityKeys } from '../../crypto/identity'
import type { FounderRef } from '../../crypto/roster'
import type { ChunkState } from '../../db/chunks'
import type { KeysRecord } from '../../db/envelope'
import type { RosterRef } from '../../db/keys-header'
import type { OpenVault } from '../../domain/types'
import { readPreference, writePreference } from '../../lib/preference'

/** What an open per-person-keys vault holds besides the database (docs/design/v2.0-key-redesign.md, 3.6 and 4.3). */
export type KeysSession = {
  vaultId: string
  epoch: number
  founder: FounderRef
  /** The signed-in person: their user id is their member id. */
  memberId: string
  /** Their private keys, imported non-extractable. */
  identity: IdentityKeys
  /** Every member's sealed identity and DEK wrap, as the header will carry them. */
  identities: Record<string, IdentityBlob>
  dekWraps: Record<string, DekWrap>
  /** The latest signed roster version in the database. */
  roster: RosterRef
  /** The stored body this session compares a save against; null until the vault has been written once. */
  chunks: ChunkState | null
  /** The founder key was not pinned in this browser before this sign-in: the person is shown its fingerprint first. */
  firstSeen: boolean
  /** An admin chose to open a copy whose roster is older than this browser had seen; the browser then expects it. */
  acceptedRollback?: boolean
}

export function isKeysVault(vault: OpenVault): vault is OpenVault & { keys: KeysSession } {
  return vault.keys !== undefined
}

/** A record from a seal, and the chunk state that becomes the session's once the record is stored. */
const pending = new WeakMap<KeysRecord, ChunkState>()

export function rememberSealed(record: KeysRecord, chunks: ChunkState): void {
  pending.set(record, chunks)
}

/** After `record` was written: later saves compare against the chunks it stored. A no-op for anything else. */
export function commitSealed(vault: OpenVault, record: unknown): void {
  if (!vault.keys || typeof record !== 'object' || record === null) return
  const chunks = pending.get(record as KeysRecord)
  if (chunks) vault.keys.chunks = chunks
}

// Per-device trust anchors (design 3.8 and 5.3): the founder key pinned on first sign-in, and the newest roster
// version this browser has seen, so a vault with a different founder or an older roster is caught.

const founderKey = (vaultId: string) => `moliya.v2.founder.${vaultId}`
const rosterSeenKey = (vaultId: string) => `moliya.v2.rosterSeen.${vaultId}`

export function pinnedFounder(vaultId: string): string | null {
  return readPreference(founderKey(vaultId))
}

export function pinFounder(vaultId: string, sigPub: string): void {
  writePreference(founderKey(vaultId), sigPub)
}

export function rosterSeen(vaultId: string): number {
  const value = Number(readPreference(rosterSeenKey(vaultId)))
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}

/** Only ever raises the mark, except through {@link resetRosterSeen}. */
export function noteRosterSeen(vaultId: string, version: number): void {
  if (version > rosterSeen(vaultId)) writePreference(rosterSeenKey(vaultId), String(version))
}

/** An admin who chose to open an older copy anyway: this browser now expects that copy's version. */
export function resetRosterSeen(vaultId: string, version: number): void {
  writePreference(rosterSeenKey(vaultId), String(version))
}

/** Pins the founder (on a first sign-in) and raises the roster mark, once a sign-in has fully succeeded. */
export function confirmKeysSession(vault: OpenVault): void {
  const keys = vault.keys
  if (!keys) return
  if (keys.firstSeen) pinFounder(keys.vaultId, keys.founder.sigPub)
  keys.firstSeen = false
  if (keys.acceptedRollback) resetRosterSeen(keys.vaultId, keys.roster.version)
  else noteRosterSeen(keys.vaultId, keys.roster.version)
  keys.acceptedRollback = false
}
