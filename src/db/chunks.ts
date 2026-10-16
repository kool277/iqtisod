import { canonicalize } from '../crypto/canonical'
import { GCM_TAG_BYTES, IV_BYTES, randomBytes } from '../crypto/crypto.service'
import { bytesToBase64, bytesToHex, copyToBuffer } from '../crypto/encoding'
import { CorruptRecordError } from '../domain/errors'
import { SqlDatabase } from './sqlite'

/**
 * The chunked body of a version 3 record (docs/design/v2.0-key-redesign.md, 3.9). The SQLite image is cut into
 * fixed-size chunks, each encrypted on its own under the epoch DEK, and the list of their IVs (the manifest) is sealed
 * under the same key, so a body is accepted only whole and only as a DEK holder wrote it.
 */

const KIB = 1024
const MIB = 1024 * KIB

/** What the writer uses: 256 SQLite pages of 4 KiB. */
export const CHUNK_BYTES = MIB
/** Readers accept any power of two in this range; the golden fixture uses small chunks so a small file has many. */
export const CHUNK_SIZE_BOUNDS = { min: 4 * KIB, max: 64 * MIB } as const
/** Keeps the manifest small: 4 GiB of 1 MiB chunks, far above what the engine can hold. */
export const MAX_CHUNKS = 4096

export const CHUNK_LABEL = 'moliya/v2/chunk'
export const BODY_LABEL = 'moliya/v2/body'

/** IndexedDB keys of chunk values are 128 random bits in hex, picked when the chunk is written. */
export const CHUNK_KEY = /^[0-9a-f]{32}$/

export type BodyContext = { vaultId: string; epoch: number }

/**
 * One chunk as a record holds it. `key` is where IndexedDB keeps its ciphertext (absent in a record read from a file,
 * until it is stored); `ciphertext` is present when this record carries the bytes (absent for a chunk a save reuses).
 */
export type BodyChunk = { iv: ArrayBuffer; key?: string; ciphertext?: ArrayBuffer }

export type BodySeal = { iv: ArrayBuffer; tag: ArrayBuffer }

export type ChunkedBody = {
  chunkSize: number
  /** Bytes of the SQLite image. */
  length: number
  chunks: BodyChunk[]
  seal: BodySeal
}

/** What an open vault remembers about its stored body: each chunk's IV, storage key and plaintext hash. Memory only. */
export type ChunkState = {
  context: BodyContext
  chunkSize: number
  chunks: { iv: ArrayBuffer; key: string; hash: string }[]
}

export function isChunkSize(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= CHUNK_SIZE_BOUNDS.min &&
    (value as number) <= CHUNK_SIZE_BOUNDS.max &&
    ((value as number) & ((value as number) - 1)) === 0
  )
}

export function chunkCount(length: number, chunkSize: number): number {
  return Math.ceil(length / chunkSize)
}

/** Plaintext bytes of chunk `index`; its ciphertext is {@link GCM_TAG_BYTES} longer. */
export function chunkPlainBytes(length: number, chunkSize: number, index: number): number {
  return Math.min(chunkSize, length - index * chunkSize)
}

/** All chunks' ciphertext together, as a backup file carries it. */
export function bodyCiphertextBytes(length: number, chunkSize: number): number {
  return length + GCM_TAG_BYTES * chunkCount(length, chunkSize)
}

/** The ciphertext size of each chunk, in order. */
export function chunkCiphertextSizes(length: number, chunkSize: number): number[] {
  return Array.from({ length: chunkCount(length, chunkSize) }, (_, index) => chunkPlainBytes(length, chunkSize, index) + GCM_TAG_BYTES)
}

export function newChunkKey(): string {
  return bytesToHex(randomBytes(16))
}

/** The manifest as it is sealed and signed: base64 IVs in chunk order. */
export function manifestJson(body: { chunkSize: number; length: number; chunks: readonly { iv: ArrayBuffer }[] }): {
  chunkSize: number
  length: number
  chunks: string[]
} {
  return { chunkSize: body.chunkSize, length: body.length, chunks: body.chunks.map((chunk) => bytesToBase64(new Uint8Array(chunk.iv))) }
}

const encoder = new TextEncoder()

function concat(head: Uint8Array, tail: Uint8Array): Uint8Array {
  const out = new Uint8Array(head.length + tail.length)
  out.set(head)
  out.set(tail, head.length)
  return out
}

export function chunkAad(context: BodyContext, index: number, chunkSize: number): Uint8Array {
  return encoder.encode(`${CHUNK_LABEL}|${context.vaultId}|${context.epoch}|${index}|${chunkSize}`)
}

export function sealAad(context: BodyContext, body: { chunkSize: number; length: number; chunks: readonly { iv: ArrayBuffer }[] }): Uint8Array {
  return concat(encoder.encode(`${BODY_LABEL}|${context.vaultId}|${context.epoch}|`), encoder.encode(canonicalize(manifestJson(body))))
}

/** A GMAC: AES-GCM of nothing, with the manifest as additional data. Only the tag is kept. */
export async function sealManifest(dek: CryptoKey, context: BodyContext, body: { chunkSize: number; length: number; chunks: readonly { iv: ArrayBuffer }[] }): Promise<BodySeal> {
  const iv = randomBytes(IV_BYTES)
  const tag = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: copyToBuffer(iv), additionalData: copyToBuffer(sealAad(context, body)) }, dek, new ArrayBuffer(0))
  return { iv: copyToBuffer(iv), tag }
}

/** Throws {@link CorruptRecordError} unless the manifest is exactly the one sealed under this key, vault and epoch. */
export async function checkSeal(dek: CryptoKey, context: BodyContext, body: ChunkedBody): Promise<void> {
  try {
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: body.seal.iv, additionalData: copyToBuffer(sealAad(context, body)) }, dek, body.seal.tag)
  } catch {
    throw new CorruptRecordError()
  }
}

export async function encryptChunk(dek: CryptoKey, context: BodyContext, index: number, chunkSize: number, plain: Uint8Array): Promise<{ iv: ArrayBuffer; ciphertext: ArrayBuffer }> {
  const iv = copyToBuffer(randomBytes(IV_BYTES))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: copyToBuffer(chunkAad(context, index, chunkSize)) },
    dek,
    plain as Uint8Array<ArrayBuffer>,
  )
  return { iv, ciphertext }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)))
}

/** Checks the sizes a body must have before anything is decrypted. */
export function bodyShapeProblem(body: ChunkedBody): boolean {
  if (!isChunkSize(body.chunkSize) || !Number.isSafeInteger(body.length) || body.length < 1) return true
  const count = chunkCount(body.length, body.chunkSize)
  if (count > MAX_CHUNKS || body.chunks.length !== count) return true
  return body.chunks.some(
    (chunk, index) =>
      chunk.iv.byteLength !== IV_BYTES ||
      (chunk.ciphertext !== undefined && chunk.ciphertext.byteLength !== chunkPlainBytes(body.length, body.chunkSize, index) + GCM_TAG_BYTES),
  )
}

/**
 * Checks the seal, then decrypts the chunks one at a time straight into SQLite's heap, so no plaintext copy of the
 * whole vault exists. Every chunk must carry its ciphertext. Returns the open database (not yet schema-checked) and
 * the state a later save compares against. A body that fails any check is refused before SQLite reads a byte.
 */
export async function openChunkedBody(body: ChunkedBody, dek: CryptoKey, context: BodyContext): Promise<{ db: SqlDatabase; state: ChunkState }> {
  if (bodyShapeProblem(body) || body.chunks.some((chunk) => chunk.ciphertext === undefined)) throw new CorruptRecordError()
  await checkSeal(dek, context, body)
  const hashes: string[] = []
  const db = await SqlDatabase.openFilled(body.length, async (put) => {
    for (let index = 0; index < body.chunks.length; index += 1) {
      const chunk = body.chunks[index]
      let plain: Uint8Array
      try {
        plain = new Uint8Array(
          await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: chunk.iv, additionalData: copyToBuffer(chunkAad(context, index, body.chunkSize)) },
            dek,
            chunk.ciphertext!,
          ),
        )
      } catch {
        throw new CorruptRecordError()
      }
      try {
        if (plain.byteLength !== chunkPlainBytes(body.length, body.chunkSize, index)) throw new CorruptRecordError()
        hashes.push(await sha256Hex(plain))
        put(index * body.chunkSize, plain)
      } finally {
        plain.fill(0)
      }
    }
  })
  return {
    db,
    state: {
      context: { ...context },
      chunkSize: body.chunkSize,
      chunks: body.chunks.map((chunk, index) => ({ iv: chunk.iv, key: chunk.key ?? '', hash: hashes[index] })),
    },
  }
}

/**
 * Encrypts the database as a chunked body. Chunks whose plaintext hash matches `previous` (same vault, epoch and chunk
 * size, already stored) keep their IV and storage key and carry no ciphertext; the rest are encrypted under a fresh IV
 * and a new storage key. `full` encrypts every chunk, for a body that must stand on its own (a backup, an archive).
 *
 * The image is copied out once, because the app can write to the database while this runs between chunks; the copy
 * is wiped before this returns.
 */
export async function sealChunkedBody(
  db: SqlDatabase,
  dek: CryptoKey,
  context: BodyContext,
  previous: ChunkState | null,
  options: { full?: boolean; chunkSize?: number } = {},
): Promise<{ body: ChunkedBody; state: ChunkState }> {
  // Always the writer's size: a body read from a file may use any size the readers accept, and a small one would stop
  // fitting in MAX_CHUNKS as the vault grows. A body in another size is rewritten whole once.
  const chunkSize = options.chunkSize ?? CHUNK_BYTES
  if (!isChunkSize(chunkSize)) throw new Error('Unsupported chunk size')
  const usable =
    previous !== null &&
    !options.full &&
    previous.chunkSize === chunkSize &&
    previous.context.vaultId === context.vaultId &&
    previous.context.epoch === context.epoch
  const image = db.export()
  try {
    const length = image.byteLength
    const count = chunkCount(length, chunkSize)
    if (length < 1 || count > MAX_CHUNKS) throw new Error('Database size is outside what a record can hold')
    const chunks: BodyChunk[] = []
    const state: ChunkState = { context: { ...context }, chunkSize, chunks: [] }
    for (let index = 0; index < count; index += 1) {
      const plain = image.subarray(index * chunkSize, Math.min(length, (index + 1) * chunkSize))
      const hash = await sha256Hex(plain)
      const before = usable ? previous.chunks[index] : undefined
      if (before && before.key !== '' && before.hash === hash) {
        chunks.push({ iv: before.iv, key: before.key })
        state.chunks.push({ ...before })
        continue
      }
      const sealed = await encryptChunk(dek, context, index, chunkSize, plain)
      const key = newChunkKey()
      chunks.push({ iv: sealed.iv, key, ciphertext: sealed.ciphertext })
      state.chunks.push({ iv: sealed.iv, key, hash })
    }
    const seal = await sealManifest(dek, context, { chunkSize, length, chunks })
    return { body: { chunkSize, length, chunks, seal }, state }
  } finally {
    image.fill(0)
  }
}

/** The chunks a stored record lists, by storage key. */
export function chunkKeysOf(body: Pick<ChunkedBody, 'chunks'>): string[] {
  return body.chunks.map((chunk) => chunk.key).filter((key): key is string => typeof key === 'string')
}
