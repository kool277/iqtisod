import { PBKDF2_ITERATIONS } from '../crypto/crypto.service'
import { cloneBuffer, cloneBytes } from '../crypto/encoding'
import type { UserWrap } from '../domain/types'

const DB_NAME = 'moliya'
const STORE = 'vault'
const RECORD_ID = 'primary'

export type VaultRecord = {
  id: 'primary'
  version: 1
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number }
  wraps: {
    userId: string
    email: string
    salt: ArrayBuffer
    iv: ArrayBuffer
    wrappedDek: ArrayBuffer
  }[]
  payload: {
    iv: ArrayBuffer
    ciphertext: ArrayBuffer
  }
  updatedAt: string
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

export async function readVault(): Promise<VaultRecord | null> {
  const database = await openDatabase()
  try {
    const record = await new Promise<VaultRecord | undefined>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readonly')
      const request = transaction.objectStore(STORE).get(RECORD_ID)
      request.onsuccess = () => resolve(request.result as VaultRecord | undefined)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'))
    })
    return record ? normalizeRecord(record) : null
  } finally {
    database.close()
  }
}

export async function writeVault(record: VaultRecord): Promise<void> {
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite')
      const request = transaction.objectStore(STORE).put(normalizeRecord(record), RECORD_ID)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? request.error ?? new Error('IndexedDB write failed'))
    })
  } finally {
    database.close()
  }
}

export function normalizeRecord(record: VaultRecord): VaultRecord {
  return {
    id: 'primary',
    version: 1,
    kdf: {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations: record.kdf?.iterations ?? PBKDF2_ITERATIONS,
    },
    wraps: (record.wraps ?? []).map((wrap) => ({
      userId: wrap.userId,
      email: wrap.email,
      salt: cloneBuffer(wrap.salt),
      iv: cloneBuffer(wrap.iv),
      wrappedDek: cloneBuffer(wrap.wrappedDek),
    })),
    payload: {
      iv: cloneBuffer(record.payload.iv),
      ciphertext: cloneBuffer(record.payload.ciphertext),
    },
    updatedAt: record.updatedAt,
  }
}

export function wrapsFromRecord(record: VaultRecord): UserWrap[] {
  return record.wraps.map((wrap) => ({
    userId: wrap.userId,
    email: wrap.email,
    salt: cloneBytes(wrap.salt),
    iv: cloneBytes(wrap.iv),
    wrappedDek: cloneBuffer(wrap.wrappedDek),
  }))
}

export function recordFromSession(input: {
  wraps: UserWrap[]
  iv: Uint8Array
  ciphertext: ArrayBuffer
  updatedAt: string
}): VaultRecord {
  return normalizeRecord({
    id: 'primary',
    version: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS },
    wraps: input.wraps.map((wrap) => ({
      userId: wrap.userId,
      email: wrap.email,
      salt: cloneBuffer(wrap.salt),
      iv: cloneBuffer(wrap.iv),
      wrappedDek: cloneBuffer(wrap.wrappedDek),
    })),
    payload: {
      iv: cloneBuffer(input.iv),
      ciphertext: cloneBuffer(input.ciphertext),
    },
    updatedAt: input.updatedAt,
  })
}
