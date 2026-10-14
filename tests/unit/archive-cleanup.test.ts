import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ARCHIVES_CLEAN_KEY, readArchive, stripArchivedGrantsOnce } from '../../src/db/storage'

/** An archive as builds before 1.4.2 wrote it: the record together with its one-time code wraps. */
async function putOldArchive(key: string): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('moliya', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('vault')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('vault', 'readwrite')
      const raw = { version: 2, appVersion: '1.4.1', grants: [{ id: 'g1' }], body: {} }
      transaction.objectStore('vault').put({ key, reason: 'upgrade', archivedAt: '2026-01-01T00:00:00.000Z', archivedBy: '1.4.1', sourceVersion: 2, sourceAppVersion: '1.4.1', sourceUpdatedAt: null, raw }, key)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
  } finally {
    database.close()
  }
}

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key)
    },
    setItem: (key, value) => {
      values.set(key, String(value))
    },
  }
}

/** The archive as stored. `readArchive` drops code wraps on the way out, so it cannot show what is on disk. */
async function storedRaw(key: string): Promise<unknown> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('moliya', 1)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction('vault').objectStore('vault').get(key)
      request.onsuccess = () => resolve((request.result as { raw: unknown }).raw)
      request.onerror = () => reject(request.error)
    })
  } finally {
    database.close()
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('stripArchivedGrantsOnce', () => {
  it('removes code wraps from old archives once, then stops reading every archive at each start', async () => {
    vi.stubGlobal('localStorage', memoryStorage())
    await putOldArchive('archive:2026-01-01T00:00:00.000Z:upgrade')
    await stripArchivedGrantsOnce()
    expect(await storedRaw('archive:2026-01-01T00:00:00.000Z:upgrade')).not.toHaveProperty('grants')
    expect(localStorage.getItem(ARCHIVES_CLEAN_KEY)).toBe('yes')

    // Only a build older than 1.4.2 could write such an archive again; later starts no longer look.
    await putOldArchive('archive:2026-01-02T00:00:00.000Z:upgrade')
    await stripArchivedGrantsOnce()
    expect(await storedRaw('archive:2026-01-02T00:00:00.000Z:upgrade')).toHaveProperty('grants')
    // Downloads still never carry them: readArchive drops code wraps from whatever it reads.
    expect((await readArchive('archive:2026-01-02T00:00:00.000Z:upgrade'))?.raw).not.toHaveProperty('grants')
  })

  it('keeps cleaning at every start where local storage is blocked', async () => {
    vi.stubGlobal('localStorage', undefined)
    await putOldArchive('archive:2026-01-03T00:00:00.000Z:upgrade')
    await stripArchivedGrantsOnce()
    expect(await storedRaw('archive:2026-01-03T00:00:00.000Z:upgrade')).not.toHaveProperty('grants')
  })
})
