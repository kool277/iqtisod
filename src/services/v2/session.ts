import type { DekWrap } from '../../crypto/ecies'
import type { IdentityBlob, IdentityKeys } from '../../crypto/identity'
import type { FounderRef } from '../../crypto/roster'
import type { ChunkState } from '../../db/chunks'
import type { KeysRecord } from '../../db/envelope'
import type { RosterRef } from '../../db/keys-header'
import { KEYS_RECORD_VERSION } from '../../db/versions'
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
  /**
   * Everyone who holds or held this epoch's DEK: active in a roster version of this epoch, or holding a key binding.
   * Taking any of them out of the vault makes a new epoch (design 4.5); anyone else never had this key.
   */
  holders: string[]
  /** Made ahead, so that a removal can switch to the next epoch's key at once, before any save. */
  nextDek: CryptoKey | null
  /** From the identity a sign-in just opened, for its sign-in check (design 4.7); used once, and dropped when it ends. */
  signInTotpKey?: CryptoKey
}

export function isKeysVault(vault: OpenVault): vault is OpenVault & { keys: KeysSession } {
  return vault.keys !== undefined
}

/** A record from a seal, and the chunk state that becomes the session's once the record is stored. */
const pending = new WeakMap<KeysRecord, ChunkState>()

export function rememberSealed(record: KeysRecord, chunks: ChunkState): void {
  pending.set(record, chunks)
}

/**
 * After `record` was written: later saves compare against the chunks it stored, and this browser has now seen the roster
 * version it names, so an older copy put back later is caught (design 3.8 step 3). A no-op for anything else.
 */
export function commitSealed(vault: OpenVault, record: unknown): void {
  if (!vault.keys || typeof record !== 'object' || record === null) return
  const chunks = pending.get(record as KeysRecord)
  if (!chunks) return
  vault.keys.chunks = chunks
  const { keys } = record as KeysRecord
  noteRosterSeen(keys.vaultId, keys.roster.version)
  noteRosterTail(vault, keys.roster.version)
}

/**
 * For the first save of a new epoch, what `writeVault` needs to archive the record it replaces: the members of the new
 * epoch, whose access that archive keeps. Undefined for any other save.
 */
export function rotationOf(vault: OpenVault, record: unknown): { keep: string[] } | undefined {
  const stored = vault.keys?.chunks?.context.epoch
  if (stored === undefined || typeof record !== 'object' || record === null) return undefined
  const sealed = record as Partial<KeysRecord>
  if (sealed.version !== KEYS_RECORD_VERSION || !sealed.keys || sealed.keys.epoch <= stored) return undefined
  return { keep: Object.keys(sealed.keys.dekWraps) }
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
  keys.signInTotpKey = undefined
  noteRosterTail(vault, keys.roster.version)
}

const rosterTailKey = (vaultId: string) => `moliya.v2.rosterTail.${vaultId}`
/** How many of the newest roster versions this browser keeps (design 4.10), within a size budget for localStorage. */
export const ROSTER_TAIL_VERSIONS = 20
const ROSTER_TAIL_CHARS = 1_000_000

/**
 * Keeps the newest signed roster versions of the vault this browser just saved or signed in to, up to `version`, as
 * the canonical JSON the database stores. A backup older than them can then be restored with the people removed since
 * taken out again (design 4.10). They are signed, so they are checked when read, not trusted.
 */
export function noteRosterTail(vault: OpenVault, version: number): void {
  if (!vault.keys) return
  keepRosterTail(vault.keys.vaultId, rosterTailOf(vault.db, version))
}

/** The newest roster versions up to `version`, oldest first, as {@link noteRosterTail} keeps them. */
export function rosterTailOf(db: OpenVault['db'], version: number): string[] {
  const rows = db.query('SELECT doc FROM roster_versions WHERE version <= ? ORDER BY version DESC LIMIT ?', [version, ROSTER_TAIL_VERSIONS])
  const docs: string[] = []
  let chars = 0
  for (const row of rows) {
    const doc = String(row.doc)
    if (chars + doc.length > ROSTER_TAIL_CHARS) break
    chars += doc.length
    docs.unshift(doc)
  }
  return docs
}

export function keepRosterTail(vaultId: string, docs: readonly string[]): void {
  writePreference(rosterTailKey(vaultId), JSON.stringify(docs))
}

/** The roster versions {@link noteRosterTail} kept, unparsed; empty when there are none or they are unreadable. */
export function rosterTailDocs(vaultId: string): string[] {
  try {
    const parsed = JSON.parse(readPreference(rosterTailKey(vaultId)) ?? '[]') as unknown
    return Array.isArray(parsed) ? parsed.filter((doc): doc is string => typeof doc === 'string') : []
  } catch {
    return []
  }
}
