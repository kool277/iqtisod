import { cloneBuffer, cloneBytes } from '../crypto/encoding'
import { ConflictError, CorruptRecordError, ValidationError } from '../domain/errors'
import type { GrantWrap, UserWrap } from '../domain/types'
import { readPreference, writePreference } from '../lib/preference'
import { APP_VERSION } from '../lib/version'
import type { AuditHead } from './audit-chain'
import { CHUNK_KEY, newChunkKey, type ChunkedBody } from './chunks'
import {
  PAYLOAD_CIPHER,
  RECORD_ID,
  decodeStoredRecord,
  encodeStoredRecord,
  envelopeProblem,
  peopleOf,
  storedForm,
  type DecodedRecord,
  type KeysRecord,
  type LegacyRecord,
  type VaultRecord,
} from './envelope'
import type { KeysHeader } from './keys-header'
import { KEYS_RECORD_VERSION, RECORD_VERSION } from './versions'

export type { VaultRecord } from './envelope'

const DB_NAME = 'moliya'
const STORE = 'vault'
const ARCHIVE_PREFIX = 'archive:'
/** A version 3 record's chunks, one IndexedDB value each (docs/design/v2.0-key-redesign.md, 3.9). */
const CHUNK_PREFIX = 'chunk:'
/** The chunk keys an archived version 3 record uses. Sorts before `archive:`, so archive listings never see it. */
const ARCHIVE_CHUNKS_PREFIX = 'archive-chunks:'
export const MAX_ARCHIVES = 3

export type LoadedVault = DecodedRecord & { raw: unknown }

export type ArchiveReason = 'upgrade' | 'import'

export type ArchiveEntry = {
  key: string
  reason: ArchiveReason
  archivedAt: string
  archivedBy: string
  sourceVersion: number | null
  sourceAppVersion: string | null
  sourceUpdatedAt: string | null
  raw: unknown
}

/** What {@link readArchive} returns: for an archived version 3 record, also the chunk values it lists. */
export type LoadedArchive = ArchiveEntry & { chunks?: ReadonlyMap<string, unknown> }

/**
 * `raw` is a record as IndexedDB already holds it, so a version 3 record's chunks are already stored. `record` is an
 * in-memory record: its chunk ciphertexts are stored with the archive.
 */
export type ArchiveSource = { reason: ArchiveReason; raw: unknown; record?: undefined } | { reason: ArchiveReason; record: VaultRecord; raw?: undefined }

export type WriteOptions = {
  expectedStamp?: string | null
  archive?: ArchiveSource
}

type ChunkPins = { archive: string; chunks: string[] }

function prefixRange(prefix: string): IDBKeyRange {
  return IDBKeyRange.bound(prefix, `${prefix}\uffff`)
}

/** The chunk storage keys a stored record lists; empty for anything that is not a well-formed version 3 record. */
function storedChunkKeys(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null || (raw as Record<string, unknown>).version !== KEYS_RECORD_VERSION) return []
  const body = (raw as Record<string, unknown>).body
  const chunks = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).chunks : undefined
  if (!Array.isArray(chunks)) return []
  return chunks.flatMap((chunk) => {
    const key = typeof chunk === 'object' && chunk !== null ? (chunk as Record<string, unknown>).key : undefined
    return typeof key === 'string' && CHUNK_KEY.test(key) ? [key] : []
  })
}

/** Gives every chunk without a storage key (a record read from a file) a new one. */
function withChunkKeys(record: VaultRecord): VaultRecord {
  if (record.version !== KEYS_RECORD_VERSION || record.body.chunks.every((chunk) => chunk.key !== undefined)) return record
  const body: ChunkedBody = { ...record.body, chunks: record.body.chunks.map((chunk) => (chunk.key !== undefined ? chunk : { ...chunk, key: newChunkKey() })) }
  return { ...record, body }
}

/** Chunk values a record carries, by storage key. */
function chunkValues(record: VaultRecord): Map<string, ArrayBuffer> {
  const values = new Map<string, ArrayBuffer>()
  if (record.version !== KEYS_RECORD_VERSION) return values
  for (const chunk of record.body.chunks) if (chunk.key !== undefined && chunk.ciphertext !== undefined) values.set(chunk.key, chunk.ciphertext)
  return values
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB failed to open'))
  })
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

export function stampOf(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = (raw as Record<string, unknown>).updatedAt
  return typeof value === 'string' ? value : null
}

function versionOf(raw: unknown): number | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = (raw as Record<string, unknown>).version
  return typeof value === 'number' ? value : null
}

function appVersionOf(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  if (typeof record.appVersion === 'string') return record.appVersion
  return record.version === 1 ? '1.0.0' : null
}

async function readRaw(key: string): Promise<unknown> {
  const database = await openDatabase()
  try {
    return await requestValue(database.transaction(STORE, 'readonly').objectStore(STORE).get(key))
  } finally {
    database.close()
  }
}

/** Small device-local values kept beside the vault (`guard.*`), such as the sign-in throttle mirror. */
const AUX_PREFIX = 'guard.'

export async function readAux(key: string): Promise<unknown> {
  if (!key.startsWith(AUX_PREFIX)) throw new Error('Not an auxiliary key')
  return readRaw(key)
}

export async function writeAux(key: string, value: unknown): Promise<void> {
  if (!key.startsWith(AUX_PREFIX)) throw new Error('Not an auxiliary key')
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite')
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB write aborted'))
      transaction.objectStore(STORE).put(value, key)
    })
  } finally {
    database.close()
  }
}

export async function readVaultRaw(): Promise<unknown> {
  return readRaw(RECORD_ID)
}

/** Reads a record and, for version 3, every chunk it lists, in one transaction: always one consistent save. */
async function readWithChunks(key: string, rawOf: (value: unknown) => unknown = (value) => value): Promise<{ value: unknown; chunks: Map<string, unknown> }> {
  const database = await openDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readonly')
      const store = transaction.objectStore(STORE)
      const chunks = new Map<string, unknown>()
      let value: unknown
      transaction.oncomplete = () => resolve({ value, chunks })
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB read aborted'))
      const request = store.get(key)
      request.onsuccess = () => {
        value = request.result
        for (const chunk of storedChunkKeys(rawOf(value))) {
          const part = store.get(`${CHUNK_PREFIX}${chunk}`)
          part.onsuccess = () => {
            if (part.result !== undefined) chunks.set(chunk, part.result)
          }
        }
      }
    })
  } finally {
    database.close()
  }
}

export async function readVault(): Promise<LoadedVault | null> {
  const { value: raw, chunks } = await readWithChunks(RECORD_ID)
  if (raw === undefined) return null
  return { ...decodeStoredRecord(raw, chunks), raw }
}

/**
 * Writes `record` as the vault, in one transaction with everything that goes with it: the compare-and-swap check of
 * `expectedStamp`, an archive, the chunk values a version 3 record needs that are not stored yet, and the sweep of
 * chunks that neither the vault nor an archive lists any more. A record that lists a chunk which is neither stored nor
 * carried is refused, so `primary` never points at a missing chunk.
 */
export async function writeVault(record: VaultRecord, options: WriteOptions = {}): Promise<void> {
  const keyed = withChunkKeys(record)
  const stored = storedForm(keyed)
  const values = chunkValues(keyed)
  const archive = options.archive?.record ? withChunkKeys(options.archive.record) : null
  const archiveRaw = archive ? storedForm(archive) : options.archive?.raw
  const archiveValues = archive ? chunkValues(archive) : new Map<string, ArrayBuffer>()
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite')
      const store = transaction.objectStore(STORE)
      let failure: Error | null = null
      const fail = (error: Error) => {
        failure = error
        transaction.abort()
      }
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('IndexedDB write aborted'))
      const current = store.get(RECORD_ID)
      current.onsuccess = () => {
        if (options.expectedStamp !== undefined) {
          const currentStamp = current.result === undefined ? null : stampOf(current.result)
          if (currentStamp !== options.expectedStamp) return fail(new ConflictError())
        }
        const chunkKeys = store.getAllKeys(prefixRange(CHUNK_PREFIX))
        const pinKeys = store.getAllKeys(prefixRange(ARCHIVE_CHUNKS_PREFIX))
        const pins = store.getAll(prefixRange(ARCHIVE_CHUNKS_PREFIX))
        const archiveKeys = store.getAllKeys(prefixRange(ARCHIVE_PREFIX))
        // Requests in one transaction complete in order, so all four are done here.
        archiveKeys.onsuccess = () => {
          const existing = new Set((chunkKeys.result as string[]).map((key) => key.slice(CHUNK_PREFIX.length)))
          const live = new Set(archiveKeys.result as string[])
          const pinned = new Map<string, ChunkPins>()
          ;(pinKeys.result as string[]).forEach((key, index) => pinned.set(key, pins.result[index] as ChunkPins))
          if (options.archive) {
            const archivedAt = new Date().toISOString()
            const key = `${ARCHIVE_PREFIX}${archivedAt}:${options.archive.reason}`
            const entry: ArchiveEntry = {
              key,
              reason: options.archive.reason,
              archivedAt,
              archivedBy: APP_VERSION,
              sourceVersion: versionOf(archiveRaw),
              sourceAppVersion: appVersionOf(archiveRaw),
              sourceUpdatedAt: stampOf(archiveRaw),
              raw: withoutGrants(archiveRaw),
            }
            const sorted = [...live].sort()
            for (const old of sorted.slice(0, Math.max(0, sorted.length - (MAX_ARCHIVES - 1)))) {
              store.delete(old)
              live.delete(old)
            }
            store.put(entry, key)
            live.add(key)
            const listed = storedChunkKeys(archiveRaw)
            if (listed.length > 0) {
              const pinKey = `${ARCHIVE_CHUNKS_PREFIX}${key.slice(ARCHIVE_PREFIX.length)}`
              const pin: ChunkPins = { archive: key, chunks: listed }
              store.put(pin, pinKey)
              pinned.set(pinKey, pin)
            }
            for (const [chunk, value] of archiveValues) {
              if (existing.has(chunk)) continue
              store.put(value, `${CHUNK_PREFIX}${chunk}`)
              existing.add(chunk)
            }
          }
          for (const [chunk, value] of values) {
            if (existing.has(chunk)) continue
            store.put(value, `${CHUNK_PREFIX}${chunk}`)
            existing.add(chunk)
          }
          const referenced = new Set(storedChunkKeys(stored))
          for (const [pinKey, pin] of pinned) {
            if (!live.has(pin.archive)) {
              store.delete(pinKey)
              continue
            }
            for (const chunk of pin.chunks) referenced.add(chunk)
          }
          for (const chunk of referenced) if (!existing.has(chunk)) return fail(new CorruptRecordError())
          store.put(stored, RECORD_ID)
          for (const chunk of existing) if (!referenced.has(chunk)) store.delete(`${CHUNK_PREFIX}${chunk}`)
        }
      }
    })
  } finally {
    database.close()
  }
}

export async function listArchives(): Promise<Omit<ArchiveEntry, 'raw'>[]> {
  const database = await openDatabase()
  try {
    const store = database.transaction(STORE, 'readonly').objectStore(STORE)
    const values = await requestValue(store.getAll(IDBKeyRange.bound(ARCHIVE_PREFIX, `${ARCHIVE_PREFIX}\uffff`)))
    return (values as ArchiveEntry[])
      .map(({ raw: _raw, ...summary }) => summary)
      .sort((left, right) => right.archivedAt.localeCompare(left.archivedAt))
  } finally {
    database.close()
  }
}

/**
 * A grant wraps the vault key under a one-time code with no expiry check of its own, so a copy of it would let a
 * used, revoked or expired code open the vault offline. Archives therefore never keep grants.
 */
export function withoutGrants(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || !Object.hasOwn(raw, 'grants')) return raw
  const { grants: _grants, ...rest } = raw as Record<string, unknown>
  return rest
}

export async function readArchive(key: string): Promise<LoadedArchive | null> {
  if (!key.startsWith(ARCHIVE_PREFIX)) return null
  const rawOf = (value: unknown) => (typeof value === 'object' && value !== null ? (value as ArchiveEntry).raw : undefined)
  const { value, chunks } = await readWithChunks(key, rawOf)
  if (value === undefined) return null
  const entry = value as ArchiveEntry
  return { ...entry, raw: withoutGrants(entry.raw), ...(chunks.size > 0 ? { chunks } : {}) }
}

/** Removes grants from archives written before 1.4.2. */
export async function stripArchivedGrants(): Promise<number> {
  const database = await openDatabase()
  try {
    return await new Promise<number>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite')
      const store = transaction.objectStore(STORE)
      let changed = 0
      transaction.oncomplete = () => resolve(changed)
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB write aborted'))
      const cursor = store.openCursor(IDBKeyRange.bound(ARCHIVE_PREFIX, `${ARCHIVE_PREFIX}\uffff`))
      cursor.onsuccess = () => {
        const current = cursor.result
        if (!current) return
        const entry = current.value as ArchiveEntry
        const raw = withoutGrants(entry.raw)
        if (raw !== entry.raw) {
          current.update({ ...entry, raw })
          changed += 1
        }
        current.continue()
      }
    })
  } finally {
    database.close()
  }
}

/** Set once the archives in this browser hold no code wraps; every build since 1.4.2 archives without them. */
export const ARCHIVES_CLEAN_KEY = 'moliya.archives.noGrants.v1'

/**
 * {@link stripArchivedGrants} until it has finished once in this browser. It reads every archive whole, which for a
 * large vault is hundreds of MB at each start, and the app starts again after every lock.
 */
export async function stripArchivedGrantsOnce(): Promise<void> {
  if (readPreference(ARCHIVES_CLEAN_KEY) === 'yes') return
  await stripArchivedGrants()
  writePreference(ARCHIVES_CLEAN_KEY, 'yes')
}

export function wrapsFromRecord(record: VaultRecord): UserWrap[] {
  return record.wraps.map((wrap) => ({
    userId: wrap.userId,
    email: wrap.email,
    kdf: { ...wrap.kdf },
    salt: cloneBytes(wrap.salt),
    iv: cloneBytes(wrap.iv),
    wrappedDek: cloneBuffer(wrap.wrappedDek),
    ...(wrap.aad ? { aad: wrap.aad } : {}),
  }))
}

export function grantsFromRecord(record: VaultRecord): GrantWrap[] {
  return (record.grants ?? []).map((grant) => ({
    id: grant.id,
    kind: grant.kind,
    email: grant.email,
    kdf: { ...grant.kdf },
    salt: cloneBytes(grant.salt),
    iv: cloneBytes(grant.iv),
    wrappedDek: cloneBuffer(grant.wrappedDek),
    ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
  }))
}

export function recordFromSession(input: {
  wraps: UserWrap[]
  grants?: GrantWrap[]
  iv: Uint8Array
  ciphertext: ArrayBuffer
  schemaVersion: number
  createdAt: string | null
  updatedAt: string
  audit?: AuditHead
}): LegacyRecord {
  const problem = envelopeProblem(input.wraps, input.grants ?? [])
  if (problem === 'WRAP_COUNT') throw new ValidationError('MEMBER_LIMIT')
  if (problem) throw new CorruptRecordError()
  return encodeStoredRecord({
    id: RECORD_ID,
    version: RECORD_VERSION,
    appVersion: APP_VERSION,
    schemaVersion: input.schemaVersion,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    cipher: { ...PAYLOAD_CIPHER },
    wraps: input.wraps.map((wrap) => ({
      userId: wrap.userId,
      email: wrap.email,
      kdf: { ...wrap.kdf },
      salt: cloneBuffer(wrap.salt),
      iv: cloneBuffer(wrap.iv),
      wrappedDek: cloneBuffer(wrap.wrappedDek),
      ...(wrap.aad ? { aad: wrap.aad } : {}),
    })),
    grants: grantRecords(input.grants),
    ...(input.audit ? { audit: input.audit } : {}),
    body: { iv: cloneBuffer(input.iv), ciphertext: input.ciphertext },
  }) as LegacyRecord
}

/** A version 3 record from an open per-person-keys vault. `keys.sig` must already cover everything but the wraps. */
export function keysRecordFromSession(input: {
  grants?: GrantWrap[]
  schemaVersion: number
  createdAt: string | null
  updatedAt: string
  appVersion?: string
  audit?: AuditHead
  keys: KeysHeader
  body: ChunkedBody
}): KeysRecord {
  const grants = grantRecords(input.grants)
  const problem = envelopeProblem(peopleOf({ wraps: [], keys: input.keys }), grants)
  if (problem === 'WRAP_COUNT') throw new ValidationError('MEMBER_LIMIT')
  if (problem) throw new CorruptRecordError()
  return encodeStoredRecord({
    id: RECORD_ID,
    version: KEYS_RECORD_VERSION,
    appVersion: input.appVersion ?? APP_VERSION,
    schemaVersion: input.schemaVersion,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    cipher: { ...PAYLOAD_CIPHER },
    wraps: [],
    ...(grants.length > 0 ? { grants } : {}),
    ...(input.audit ? { audit: input.audit } : {}),
    keys: input.keys,
    body: input.body,
  }) as KeysRecord
}

function grantRecords(grants: GrantWrap[] | undefined): VaultRecord['grants'] & object {
  return (grants ?? []).map((grant) => ({
    id: grant.id,
    kind: grant.kind,
    email: grant.email,
    kdf: { ...grant.kdf },
    salt: cloneBuffer(grant.salt),
    iv: cloneBuffer(grant.iv),
    wrappedDek: cloneBuffer(grant.wrappedDek),
    ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
  }))
}
