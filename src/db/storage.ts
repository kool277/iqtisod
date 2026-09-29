import { cloneBuffer, cloneBytes } from '../crypto/encoding'
import { ConflictError } from '../domain/errors'
import type { UserWrap } from '../domain/types'
import { APP_VERSION } from '../lib/version'
import {
  PAYLOAD_CIPHER,
  RECORD_ID,
  decodeStoredRecord,
  encodeStoredRecord,
  type DecodedRecord,
  type VaultRecord,
} from './envelope'
import { RECORD_VERSION } from './versions'

export type { VaultRecord } from './envelope'

const DB_NAME = 'moliya'
const STORE = 'vault'
const ARCHIVE_PREFIX = 'archive:'
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

export type WriteOptions = {
  expectedStamp?: string | null
  archive?: { reason: ArchiveReason; raw: unknown }
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

export async function readVaultRaw(): Promise<unknown> {
  return readRaw(RECORD_ID)
}

export async function readVault(): Promise<LoadedVault | null> {
  const raw = await readRaw(RECORD_ID)
  if (raw === undefined) return null
  return { ...decodeStoredRecord(raw), raw }
}

export async function writeVault(record: VaultRecord, options: WriteOptions = {}): Promise<void> {
  const stored = encodeStoredRecord(record)
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite')
      const store = transaction.objectStore(STORE)
      let conflict = false
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(conflict ? new ConflictError() : (transaction.error ?? new Error('IndexedDB write aborted')))
      const current = store.get(RECORD_ID)
      current.onsuccess = () => {
        if (options.expectedStamp !== undefined) {
          const currentStamp = current.result === undefined ? null : stampOf(current.result)
          if (currentStamp !== options.expectedStamp) {
            conflict = true
            transaction.abort()
            return
          }
        }
        if (options.archive) {
          const archivedAt = new Date().toISOString()
          const entry: ArchiveEntry = {
            key: `${ARCHIVE_PREFIX}${archivedAt}:${options.archive.reason}`,
            reason: options.archive.reason,
            archivedAt,
            archivedBy: APP_VERSION,
            sourceVersion: versionOf(options.archive.raw),
            sourceAppVersion: appVersionOf(options.archive.raw),
            sourceUpdatedAt: stampOf(options.archive.raw),
            raw: options.archive.raw,
          }
          const keys = store.getAllKeys(IDBKeyRange.bound(ARCHIVE_PREFIX, `${ARCHIVE_PREFIX}\uffff`))
          keys.onsuccess = () => {
            const existing = (keys.result as string[]).sort()
            for (const key of existing.slice(0, Math.max(0, existing.length - (MAX_ARCHIVES - 1)))) store.delete(key)
            store.put(entry, entry.key)
            store.put(stored, RECORD_ID)
          }
          return
        }
        store.put(stored, RECORD_ID)
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

export async function readArchive(key: string): Promise<ArchiveEntry | null> {
  if (!key.startsWith(ARCHIVE_PREFIX)) return null
  const value = await readRaw(key)
  return value === undefined ? null : (value as ArchiveEntry)
}

export function wrapsFromRecord(record: VaultRecord): UserWrap[] {
  return record.wraps.map((wrap) => ({
    userId: wrap.userId,
    email: wrap.email,
    kdf: { ...wrap.kdf },
    salt: cloneBytes(wrap.salt),
    iv: cloneBytes(wrap.iv),
    wrappedDek: cloneBuffer(wrap.wrappedDek),
  }))
}

export function recordFromSession(input: {
  wraps: UserWrap[]
  iv: Uint8Array
  ciphertext: ArrayBuffer
  schemaVersion: number
  createdAt: string | null
  updatedAt: string
}): VaultRecord {
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
    })),
    body: { iv: cloneBuffer(input.iv), ciphertext: cloneBuffer(input.ciphertext) },
  })
}
