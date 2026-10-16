import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { Base64Decoder, Base64Error } from '../../src/crypto/base64-stream'
import { generateDek } from '../../src/crypto/crypto.service'
import { base64BlobOfParts, bytesToBase64 } from '../../src/crypto/encoding'
import { SUITE } from '../../src/crypto/suite'
import {
  bodyCiphertextBytes,
  chunkCount,
  chunkKeysOf,
  openChunkedBody,
  sealChunkedBody,
  type BodyContext,
  type ChunkedBody,
} from '../../src/db/chunks'
import { ciphertextParts, decodeStoredRecord, parseBackupJson, parseBackupText, storedForm, toBackupJson, type KeysRecord } from '../../src/db/envelope'
import { readKeysHeader } from '../../src/db/keys-header'
import { SqlDatabase } from '../../src/db/sqlite'
import { readBackupFile } from '../../src/db/backup-reader'
import { listArchives, readArchive, readVault, readVaultRaw, writeVault } from '../../src/db/storage'
import { archiveFileBlob, backupFileBlob } from '../../src/services/backup.service'
import { KEYS_RECORD_VERSION, KEYS_SCHEMA_VERSION } from '../../src/db/versions'
import { ConflictError, CorruptRecordError } from '../../src/domain/errors'

const KIB = 1024
const CONTEXT: BodyContext = { vaultId: 'vault-1', epoch: 1 }

const open: SqlDatabase[] = []
function track(db: SqlDatabase): SqlDatabase {
  open.push(db)
  return db
}

afterEach(async () => {
  for (const db of open.splice(0)) db.close()
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('moliya')
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
  })
})

/** A database of roughly `rows` KiB of random blobs. */
async function sampleDatabase(rows = 120): Promise<SqlDatabase> {
  const db = track(await SqlDatabase.openEmpty())
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, data BLOB NOT NULL)')
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${rows}) INSERT INTO t (data) SELECT randomblob(1000) FROM n`)
  return db
}

function image(db: SqlDatabase): Uint8Array {
  return db.export()
}

const b64 = (bytes: number, fill = 7) => Buffer.alloc(bytes, fill).toString('base64')

function fakeKeys() {
  const header = readKeysHeader({
    suite: SUITE,
    vaultId: CONTEXT.vaultId,
    epoch: CONTEXT.epoch,
    founder: { memberId: 'm1', sigPub: b64(32), fingerprint: 'a'.repeat(32) },
    roster: { version: 1, hash: 'b'.repeat(64) },
    identities: {
      m1: {
        v: 2,
        suite: SUITE,
        memberId: 'm1',
        email: 'founder@example.com',
        kdf: { name: 'Argon2id', m: 65_536, t: 3, p: 1, len: 32, v: 19 },
        salt: b64(16),
        iv: b64(12),
        sealed: b64(116),
        encPub: b64(32),
        sigPub: b64(32),
      },
    },
    dekWraps: { m1: { v: 2, suite: SUITE, epoch: 1, memberId: 'm1', epk: b64(32), salt: b64(32), iv: b64(12), ct: b64(48) } },
    sig: { by: 'm1', alg: 'Ed25519', value: b64(64) },
  })
  if (!header) throw new Error('fake header is malformed')
  return header
}

function keysRecord(body: ChunkedBody, updatedAt = '2026-10-16T10:00:00.000Z'): KeysRecord {
  return {
    id: 'primary',
    version: KEYS_RECORD_VERSION,
    appVersion: '2.0.0-alpha.1',
    schemaVersion: KEYS_SCHEMA_VERSION,
    createdAt: '2026-10-16T09:00:00.000Z',
    updatedAt,
    cipher: { name: 'AES-GCM', length: 256 },
    wraps: [],
    keys: fakeKeys(),
    body,
  }
}

async function storeKeys(): Promise<string[]> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('moliya', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('vault')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    return await new Promise<string[]>((resolve, reject) => {
      const request = database.transaction('vault', 'readonly').objectStore('vault').getAllKeys()
      request.onsuccess = () => resolve((request.result as string[]).sort())
      request.onerror = () => reject(request.error)
    })
  } finally {
    database.close()
  }
}

const chunkKeysIn = (keys: string[]) => keys.filter((key) => key.startsWith('chunk:'))

describe('chunked body', () => {
  it('round-trips a database through chunks of several sizes, ending on and off a chunk boundary', async () => {
    const dek = await generateDek()
    const db = await sampleDatabase()
    for (const chunkSize of [4 * KIB, 16 * KIB, 1024 * KIB]) {
      const { body, state } = await sealChunkedBody(db, dek, CONTEXT, null, { chunkSize })
      expect(body.chunks.length).toBe(chunkCount(body.length, chunkSize))
      expect(body.chunks.every((chunk) => chunk.ciphertext !== undefined && chunk.key !== undefined)).toBe(true)
      expect(state.chunks.map((chunk) => chunk.key)).toEqual(chunkKeysOf(body))
      const opened = await openChunkedBody(body, dek, CONTEXT)
      track(opened.db)
      expect(image(opened.db)).toEqual(image(db))
      expect(opened.state.chunks.map((chunk) => chunk.hash)).toEqual(state.chunks.map((chunk) => chunk.hash))
    }
    // SQLite images are whole pages, so 4 KiB chunks end exactly on a chunk boundary.
    expect(image(db).byteLength % (4 * KIB)).toBe(0)
  })

  it('re-encrypts only the chunks a small change touched', async () => {
    const dek = await generateDek()
    const db = await sampleDatabase()
    const first = await sealChunkedBody(db, dek, CONTEXT, null, { chunkSize: 4 * KIB })
    db.exec("UPDATE t SET data = randomblob(1000) WHERE id = 60")
    const second = await sealChunkedBody(db, dek, CONTEXT, first.state)
    const fresh = second.body.chunks.filter((chunk) => chunk.ciphertext !== undefined)
    expect(fresh.length).toBeGreaterThan(0)
    expect(fresh.length).toBeLessThanOrEqual(4)
    expect(second.body.chunks.length).toBe(first.body.chunks.length)
    // Reused chunks keep their IV and storage key; new ones get new ones.
    second.body.chunks.forEach((chunk, index) => {
      const before = first.body.chunks[index]
      if (chunk.ciphertext === undefined) {
        expect(chunk.key).toBe(before.key)
        expect(new Uint8Array(chunk.iv)).toEqual(new Uint8Array(before.iv))
      } else {
        expect(chunk.key).not.toBe(before.key)
        expect(new Uint8Array(chunk.iv)).not.toEqual(new Uint8Array(before.iv))
      }
    })
    // Put together from both saves, the body opens as the changed database.
    const merged: ChunkedBody = {
      ...second.body,
      chunks: second.body.chunks.map((chunk, index) => (chunk.ciphertext ? chunk : { ...chunk, ciphertext: first.body.chunks[index].ciphertext })),
    }
    const opened = await openChunkedBody(merged, dek, CONTEXT)
    track(opened.db)
    expect(image(opened.db)).toEqual(image(db))
  })

  it('encrypts every chunk when asked for a full body or when the epoch or vault changed', async () => {
    const dek = await generateDek()
    const db = await sampleDatabase(30)
    const first = await sealChunkedBody(db, dek, CONTEXT, null, { chunkSize: 4 * KIB })
    for (const [context, options] of [
      [CONTEXT, { full: true }],
      [{ ...CONTEXT, epoch: 2 }, {}],
      [{ ...CONTEXT, vaultId: 'vault-2' }, {}],
    ] as const) {
      const next = await sealChunkedBody(db, dek, context, first.state, options)
      expect(next.body.chunks.every((chunk) => chunk.ciphertext !== undefined)).toBe(true)
    }
  })

  it('refuses any body that is not exactly one save, before SQLite reads it', async () => {
    const dek = await generateDek()
    const db = await sampleDatabase(40)
    const first = await sealChunkedBody(db, dek, CONTEXT, null, { chunkSize: 4 * KIB })
    db.exec('UPDATE t SET data = randomblob(1000) WHERE id = 20')
    const second = await sealChunkedBody(db, dek, CONTEXT, first.state, { full: true })
    const { body } = second
    const changed = body.chunks.findIndex((chunk, index) => chunk.ciphertext!.byteLength > 0 && index > 0 && first.state.chunks[index].hash !== second.state.chunks[index].hash)
    expect(changed).toBeGreaterThan(0)

    const swapped: ChunkedBody = { ...body, chunks: body.chunks.map((chunk, index) => (index === changed ? first.body.chunks[index] : chunk)) }
    const reordered: ChunkedBody = { ...body, chunks: [body.chunks[1], body.chunks[0], ...body.chunks.slice(2)] }
    const last = body.chunks.length - 1
    const dropped: ChunkedBody = { ...body, length: last * body.chunkSize, chunks: body.chunks.slice(0, last) }
    const otherSeal: ChunkedBody = { ...body, seal: first.body.seal }
    const shortChunk: ChunkedBody = {
      ...body,
      chunks: body.chunks.map((chunk, index) => (index === 0 ? { ...chunk, ciphertext: chunk.ciphertext!.slice(0, chunk.ciphertext!.byteLength - 1) } : chunk)),
    }
    const flipped: ChunkedBody = {
      ...body,
      chunks: body.chunks.map((chunk, index) => {
        if (index !== 2) return chunk
        const bytes = new Uint8Array(chunk.ciphertext!.slice(0))
        bytes[5] ^= 1
        return { ...chunk, ciphertext: bytes.buffer }
      }),
    }
    for (const [label, tampered] of Object.entries({ swapped, reordered, dropped, otherSeal, shortChunk, flipped })) {
      await expect(openChunkedBody(tampered, dek, CONTEXT), label).rejects.toBeInstanceOf(CorruptRecordError)
    }
    await expect(openChunkedBody(body, dek, { ...CONTEXT, epoch: 2 })).rejects.toBeInstanceOf(CorruptRecordError)
    await expect(openChunkedBody(body, dek, { ...CONTEXT, vaultId: 'vault-2' })).rejects.toBeInstanceOf(CorruptRecordError)
    await expect(openChunkedBody(body, await generateDek(), CONTEXT)).rejects.toBeInstanceOf(CorruptRecordError)
    const opened = await openChunkedBody(body, dek, CONTEXT)
    track(opened.db)
    expect(image(opened.db)).toEqual(image(db))
  })
})

describe('base64 in pieces', () => {
  it('decodes one string into several buffers as if they were one', () => {
    const source = new Uint8Array(1000).map((_, index) => (index * 37) % 256)
    const text = bytesToBase64(source)
    for (const sizes of [[1000], [1, 999], [2, 2, 996], [500, 499, 1], [333, 334, 333]]) {
      const targets = sizes.map((size) => new Uint8Array(size))
      const decoder = new Base64Decoder(targets)
      decoder.pushString(text)
      expect(decoder.finish()).toBe(1000)
      expect(Buffer.concat(targets)).toEqual(Buffer.from(source))
    }
    const tooSmall = new Base64Decoder([new Uint8Array(500), new Uint8Array(499)])
    expect(() => {
      tooSmall.pushString(text)
      tooSmall.finish()
    }).toThrow(Base64Error)
  })

  it('encodes several parts as one base64 string, whatever their lengths', async () => {
    const parts = [1, 2, 4, 5, 0, 3, 7, 1].map((length, index) => new Uint8Array(length).fill(index + 1))
    const whole = Buffer.concat(parts)
    const blob = base64BlobOfParts('[', parts, ']', 'text/plain')
    expect(await blob.text()).toBe(`[${whole.toString('base64')}]`)
  })
})

describe('version 3 records and backups', () => {
  it('write a backup whose body is the chunks in order, and read it back chunk for chunk', async () => {
    const dek = await generateDek()
    const db = await sampleDatabase(50)
    const { body } = await sealChunkedBody(db, dek, CONTEXT, null, { chunkSize: 8 * KIB })
    const record = keysRecord(body)
    const json = toBackupJson(record, '2026-10-16T11:00:00.000Z') as { body: { ciphertext: string; chunks: string[]; chunkSize: number; length: number } }
    expect(Object.keys(json)[0]).toBe('format')
    expect(Object.keys(json)[1]).toBe('version')
    expect(Object.keys(json).at(-1)).toBe('body')
    expect(Object.keys(json.body).at(-1)).toBe('ciphertext')
    expect(Buffer.from(json.body.ciphertext, 'base64').byteLength).toBe(bodyCiphertextBytes(body.length, body.chunkSize))
    const text = JSON.stringify(json)
    const read = parseBackupText(text)
    expect(read.record.version).toBe(KEYS_RECORD_VERSION)
    const readBody = (read.record as KeysRecord).body
    expect(readBody.chunks.every((chunk) => chunk.key === undefined)).toBe(true)
    expect(ciphertextParts(read.record).map((part) => Buffer.from(part))).toEqual(ciphertextParts(record).map((part) => Buffer.from(part)))
    const opened = await openChunkedBody(readBody, dek, CONTEXT)
    track(opened.db)
    expect(image(opened.db)).toEqual(image(db))

    // The decoded ciphertext must be exactly the manifest's size.
    const short = JSON.parse(text) as typeof json
    short.body.ciphertext = Buffer.from(short.body.ciphertext, 'base64').subarray(0, -3).toString('base64')
    expect(() => parseBackupJson(short)).toThrow()
    const lying = JSON.parse(text) as typeof json
    lying.body.length += 1
    expect(() => parseBackupJson(lying)).toThrow()
  })

  it('stream a backup out chunk by chunk and back in as one buffer per chunk', async () => {
    const dek = await generateDek()
    const db = await sampleDatabase(60)
    const { body } = await sealChunkedBody(db, dek, CONTEXT, null, { chunkSize: 4 * KIB })
    const record = keysRecord(body)
    const blob = backupFileBlob(record, '2026-10-16T11:00:00.000Z')
    expect(await blob.text()).toBe(JSON.stringify(toBackupJson(record, '2026-10-16T11:00:00.000Z')))
    // A version 3 header has strings longer than 64 characters (sealed identities, signatures), so 1 KiB is the floor here.
    for (const options of [{}, { longStringBytes: 1024 }]) {
      const read = await readBackupFile(blob, options)
      const readBody = (read.record as KeysRecord).body
      expect(readBody.chunks.map((chunk) => Buffer.from(chunk.ciphertext!))).toEqual(body.chunks.map((chunk) => Buffer.from(chunk.ciphertext!)))
      const opened = await openChunkedBody(readBody, dek, CONTEXT)
      track(opened.db)
      expect(image(opened.db)).toEqual(image(db))
    }
    // A body one chunk short of what the manifest declares is not a backup.
    const json = JSON.parse(await blob.text()) as { body: { ciphertext: string } }
    json.body.ciphertext = Buffer.from(json.body.ciphertext, 'base64').subarray(0, -(4 * KIB + 16)).toString('base64')
    await expect(readBackupFile(new Blob([JSON.stringify(json)]))).rejects.toThrow()
  })

  it('download an archived version 3 record as a backup', async () => {
    const dek = await generateDek()
    const db = await sampleDatabase(20)
    const first = await sealChunkedBody(db, dek, CONTEXT, null, { chunkSize: 4 * KIB })
    await writeVault(keysRecord(first.body, '2026-10-16T10:00:00.000Z'), { expectedStamp: null })
    const raw = await readVaultRaw()
    db.exec('UPDATE t SET data = randomblob(1000) WHERE id = 4')
    const second = await sealChunkedBody(db, dek, CONTEXT, first.state)
    await writeVault(keysRecord(second.body, '2026-10-16T10:01:00.000Z'), { expectedStamp: '2026-10-16T10:00:00.000Z', archive: { reason: 'upgrade', raw } })
    const [summary] = await listArchives()
    const archived = await readArchive(summary.key)
    const read = await readBackupFile(archiveFileBlob(archived!))
    const opened = await openChunkedBody((read.record as KeysRecord).body, dek, CONTEXT)
    track(opened.db)
    const original = await openChunkedBody(first.body, dek, CONTEXT)
    track(original.db)
    expect(image(opened.db)).toEqual(image(original.db))
  })

  it('store each chunk as its own value, write only new chunks, and sweep the rest', async () => {
    const dek = await generateDek()
    const db = await sampleDatabase(40)
    const first = await sealChunkedBody(db, dek, CONTEXT, null, { chunkSize: 4 * KIB })
    await writeVault(keysRecord(first.body, '2026-10-16T10:00:00.000Z'), { expectedStamp: null })
    const afterFirst = await storeKeys()
    expect(chunkKeysIn(afterFirst)).toEqual(chunkKeysOf(first.body).map((key) => `chunk:${key}`).sort())

    const loaded = await readVault()
    expect(loaded?.record.version).toBe(KEYS_RECORD_VERSION)
    const loadedBody = (loaded!.record as KeysRecord).body
    expect(loadedBody.chunks.every((chunk) => chunk.ciphertext !== undefined)).toBe(true)
    const reopened = await openChunkedBody(loadedBody, dek, CONTEXT)
    track(reopened.db)
    expect(image(reopened.db)).toEqual(image(db))
    // The record kept under `primary` is small: the ciphertext lives in the chunk values.
    expect(JSON.stringify(storedForm(loaded!.record), (_, value) => (value instanceof ArrayBuffer ? value.byteLength : value)).length).toBeLessThan(10_000)

    db.exec('UPDATE t SET data = randomblob(1000) WHERE id = 7')
    const second = await sealChunkedBody(db, dek, CONTEXT, reopened.state)
    await expect(writeVault(keysRecord(second.body, '2026-10-16T10:05:00.000Z'), { expectedStamp: 'stale' })).rejects.toBeInstanceOf(ConflictError)
    expect(await storeKeys()).toEqual(afterFirst)
    await writeVault(keysRecord(second.body, '2026-10-16T10:05:00.000Z'), { expectedStamp: '2026-10-16T10:00:00.000Z' })
    const afterSecond = chunkKeysIn(await storeKeys())
    expect(afterSecond).toEqual(chunkKeysOf(second.body).map((key) => `chunk:${key}`).sort())
    const again = await readVault()
    const againDb = await openChunkedBody((again!.record as KeysRecord).body, dek, CONTEXT)
    track(againDb.db)
    expect(image(againDb.db)).toEqual(image(db))
  })

  it('refuses a record that lists a chunk nobody stored, and leaves the stored vault alone', async () => {
    const dek = await generateDek()
    const db = await sampleDatabase(20)
    const first = await sealChunkedBody(db, dek, CONTEXT, null, { chunkSize: 4 * KIB })
    await writeVault(keysRecord(first.body), { expectedStamp: null })
    const before = await storeKeys()
    const missing: ChunkedBody = { ...first.body, chunks: first.body.chunks.map((chunk, index) => (index === 1 ? { iv: chunk.iv, key: 'f'.repeat(32) } : chunk)) }
    await expect(writeVault(keysRecord(missing, '2026-10-16T10:09:00.000Z'))).rejects.toBeInstanceOf(CorruptRecordError)
    expect(await storeKeys()).toEqual(before)
  })

  it('keep the chunks an archive lists until the archive goes', async () => {
    const dek = await generateDek()
    const db = await sampleDatabase(30)
    const first = await sealChunkedBody(db, dek, CONTEXT, null, { chunkSize: 4 * KIB })
    await writeVault(keysRecord(first.body, '2026-10-16T10:00:00.000Z'), { expectedStamp: null })
    const raw = await readVaultRaw()

    db.exec('UPDATE t SET data = randomblob(1000) WHERE id = 3')
    const second = await sealChunkedBody(db, dek, CONTEXT, first.state)
    await writeVault(keysRecord(second.body, '2026-10-16T10:01:00.000Z'), { expectedStamp: '2026-10-16T10:00:00.000Z', archive: { reason: 'upgrade', raw } })
    const keys = await storeKeys()
    const both = new Set([...chunkKeysOf(first.body), ...chunkKeysOf(second.body)].map((key) => `chunk:${key}`))
    expect(chunkKeysIn(keys)).toEqual([...both].sort())
    expect(keys.filter((key) => key.startsWith('archive-chunks:'))).toHaveLength(1)

    const [summary] = await listArchives()
    const archived = await readArchive(summary.key)
    const archivedRecord = decodeStoredRecord(archived!.raw, archived!.chunks).record as KeysRecord
    const fromArchive = await openChunkedBody(archivedRecord.body, dek, CONTEXT)
    track(fromArchive.db)
    expect(image(fromArchive.db)).not.toEqual(image(db))

    // Three more archives push the first one out; its chunks go with it.
    let stamp = '2026-10-16T10:01:00.000Z'
    for (let index = 0; index < 3; index += 1) {
      // Archive keys carry the time to the millisecond.
      await new Promise((resolve) => setTimeout(resolve, 3))
      const next = `2026-10-16T10:0${index + 2}:00.000Z`
      await writeVault(keysRecord(second.body, next), { expectedStamp: stamp, archive: { reason: 'import', raw: await readVaultRaw() } })
      stamp = next
    }
    const final = await storeKeys()
    expect(chunkKeysIn(final)).toEqual(chunkKeysOf(second.body).map((key) => `chunk:${key}`).sort())
    expect(final.filter((key) => key.startsWith('archive:'))).toHaveLength(3)
    expect(final.filter((key) => key.startsWith('archive-chunks:'))).toHaveLength(3)
  })

  it('archive an in-memory record together with the chunks it carries', async () => {
    const dek = await generateDek()
    const db = await sampleDatabase(20)
    const first = await sealChunkedBody(db, dek, CONTEXT, null, { chunkSize: 4 * KIB })
    await writeVault(keysRecord(first.body, '2026-10-16T10:00:00.000Z'), { expectedStamp: null })
    db.exec('UPDATE t SET data = randomblob(1000) WHERE id = 2')
    const sealed = await sealChunkedBody(db, dek, CONTEXT, first.state)
    const replacement = await sealChunkedBody(await sampleDatabase(10), dek, CONTEXT, null, { chunkSize: 4 * KIB })
    await writeVault(keysRecord(replacement.body, '2026-10-16T10:02:00.000Z'), {
      expectedStamp: '2026-10-16T10:00:00.000Z',
      archive: { reason: 'import', record: keysRecord(sealed.body, '2026-10-16T10:01:00.000Z') },
    })
    const [summary] = await listArchives()
    const archived = await readArchive(summary.key)
    const record = decodeStoredRecord(archived!.raw, archived!.chunks).record as KeysRecord
    const opened = await openChunkedBody(record.body, dek, CONTEXT)
    track(opened.db)
    expect(image(opened.db)).toEqual(image(db))
  })
})
