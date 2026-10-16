import {
  GCM_TAG_BYTES,
  IV_BYTES,
  LEGACY_KDF,
  SALT_BOUNDS,
  WRAPPED_DEK_BYTES,
  WRAP_AAD_V1,
  isKdfParams,
  type KdfParams,
} from '../crypto/crypto.service'
import { Base64Decoder, Base64Error } from '../crypto/base64-stream'
import { base64ToBytes, bytesToBase64, cloneBuffer, cloneBytes } from '../crypto/encoding'
import { copyArgon2Params, isArgon2Params, type Argon2Params } from '../crypto/kdf'
import { CorruptRecordError, FormatTooNewError, ValidationError } from '../domain/errors'
import { LIMITS } from '../lib/limits'
import { parseJsonSafely } from '../lib/safe-json'
import { isAuditHead, type AuditHead } from './audit-chain'
import { CHUNK_KEY, MAX_CHUNKS, chunkCiphertextSizes, chunkCount, isChunkSize, manifestJson, type BodyChunk, type ChunkedBody } from './chunks'
import { copyKeysHeader, readKeysHeader, type KeysHeader } from './keys-header'
import { BACKUP_VERSION, KEYS_BACKUP_VERSION, KEYS_RECORD_VERSION, KEYS_SCHEMA_VERSION, RECORD_VERSION, SCHEMA_VERSION } from './versions'

export const BACKUP_FORMAT = 'moliya-vault'
export const RECORD_ID = 'primary'

export type PayloadCipher = { name: 'AES-GCM'; length: 256 }

export const PAYLOAD_CIPHER: PayloadCipher = { name: 'AES-GCM', length: 256 }

export type WrapRecord = {
  userId: string
  email: string
  kdf: KdfParams
  salt: ArrayBuffer
  iv: ArrayBuffer
  wrappedDek: ArrayBuffer
  aad?: typeof WRAP_AAD_V1
}

export type GrantKind = 'INVITE' | 'RESET'

/** PBKDF2 for a 1.6 vault's codes, Argon2id for a per-person-keys vault's invites. */
export type GrantKdf = KdfParams | Argon2Params

export type GrantRecord = {
  id: string
  kind: GrantKind
  email: string
  kdf: GrantKdf
  salt: ArrayBuffer
  iv: ArrayBuffer
  wrappedDek: ArrayBuffer
  expiresAt?: string
}

/** Record versions 1–2: the whole database is one ciphertext. */
export type PlainBody = { iv: ArrayBuffer; ciphertext: ArrayBuffer }

type RecordFields = {
  id: typeof RECORD_ID
  appVersion: string
  schemaVersion: number
  createdAt: string | null
  updatedAt: string
  cipher: PayloadCipher
  /** Always empty in a version 3 record: each member's key is in `keys.identities` and `keys.dekWraps`. */
  wraps: WrapRecord[]
  grants?: GrantRecord[]
  /** The audit log's last entry when the record was sealed (1.4.2+). Advisory: lets a reader notice a shortened or rewritten log. */
  audit?: AuditHead
}

/** A 1.x record (versions 1–2 are both read into this form). */
export type LegacyRecord = RecordFields & { version: typeof RECORD_VERSION; keys?: undefined; body: PlainBody }

/** A per-person-keys record (version 3), its body in chunks (docs/design/v2.0-key-redesign.md, 3.9). */
export type KeysRecord = RecordFields & { version: typeof KEYS_RECORD_VERSION; keys: KeysHeader; body: ChunkedBody }

export type VaultRecord = LegacyRecord | KeysRecord

export type DecodedRecord = {
  record: VaultRecord
  sourceVersion: number
}

export type DecodedBackup = DecodedRecord & {
  appVersion: string | null
  exportedAt: string | null
}

type BackupWrapJson = {
  userId: string
  email: string
  kdf: KdfParams
  salt: string
  iv: string
  wrappedDek: string
  aad?: typeof WRAP_AAD_V1
}

type BackupGrantJson = {
  id: string
  kind: GrantKind
  email: string
  kdf: GrantKdf
  salt: string
  iv: string
  wrappedDek: string
  expiresAt?: string
}

type BackupFields = {
  format: typeof BACKUP_FORMAT
  appVersion: string
  schemaVersion: number
  createdAt: string | null
  updatedAt: string
  exportedAt: string
  cipher: PayloadCipher
  grants?: BackupGrantJson[]
  audit?: AuditHead
}

export type BackupFileV2 = BackupFields & {
  version: typeof BACKUP_VERSION
  wraps: BackupWrapJson[]
  body: { iv: string; ciphertext: string }
}

/** The chunk ciphertexts are concatenated in order in `ciphertext`, which stays the body's last key. */
export type BackupBodyV3 = {
  chunkSize: number
  length: number
  chunks: string[]
  seal: { iv: string; tag: string }
  ciphertext: string
}

export type BackupFileV3 = BackupFields & { version: typeof KEYS_BACKUP_VERSION } & KeysHeader & { body: BackupBodyV3 }

type Invalid = () => Error

function asObject(value: unknown, invalid: Invalid): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}

function asString(value: unknown, invalid: Invalid): string {
  if (typeof value !== 'string' || value.length === 0) throw invalid()
  return value
}

function asOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function binary(value: unknown, invalid: Invalid): Uint8Array {
  if (value instanceof ArrayBuffer) return cloneBytes(value)
  if (ArrayBuffer.isView(value)) return cloneBytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
  throw invalid()
}

/**
 * The stored ciphertext is the record's largest part by far. IndexedDB hands every read its own copy, so the decoded
 * record keeps that buffer instead of cloning it; ciphertext buffers are never written to.
 */
function sharedBinary(value: unknown, invalid: Invalid): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return binary(value, invalid)
}

const BASE64_TEXT = /^[A-Za-z0-9+/]*={0,2}$/

function base64(value: unknown, invalid: Invalid): Uint8Array {
  const text = asString(value, invalid)
  if (!BASE64_TEXT.test(text) || text.length % 4 !== 0) throw invalid()
  try {
    return base64ToBytes(text)
  } catch {
    throw invalid()
  }
}

function checkLength(bytes: Uint8Array, min: number, max: number, invalid: Invalid): ArrayBuffer {
  if (bytes.byteLength < min || bytes.byteLength > max) throw invalid()
  return cloneBuffer(bytes)
}

/** Like {@link checkLength}, but keeps a buffer the reader already owns whole. */
function checkLengthOwned(bytes: Uint8Array, min: number, max: number, invalid: Invalid): ArrayBuffer {
  if (bytes.byteLength < min || bytes.byteLength > max) throw invalid()
  const whole = bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
  return whole ? (bytes.buffer as ArrayBuffer) : cloneBuffer(bytes)
}

function readKdf(value: unknown, invalid: Invalid): KdfParams {
  if (!isKdfParams(value)) throw invalid()
  return { name: value.name, hash: value.hash, iterations: value.iterations }
}

function copyGrantKdf(kdf: GrantKdf): GrantKdf {
  return kdf.name === 'Argon2id' ? copyArgon2Params(kdf) : { name: kdf.name, hash: kdf.hash, iterations: kdf.iterations }
}

function readCipher(value: unknown, invalid: Invalid): PayloadCipher {
  const cipher = asObject(value, invalid)
  if (cipher.name !== 'AES-GCM' || cipher.length !== 256) throw invalid()
  return { ...PAYLOAD_CIPHER }
}

function readVersion(value: unknown, supported: number, invalid: Invalid): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw invalid()
  if ((value as number) > supported) throw new FormatTooNewError()
  return value as number
}

type ByteReader = (value: unknown, invalid: Invalid) => Uint8Array

/** The chunk ciphertexts of a version 3 body, given each one's expected size. */
type ChunkReader = (body: Record<string, unknown>, sizes: readonly number[], invalid: Invalid) => (ArrayBuffer | undefined)[]

/** Small fields, the ciphertext, which may be read without a copy, and a version 3 body's chunks. */
type Readers = { bytes: ByteReader; ciphertext: ByteReader; chunks: ChunkReader; stored: boolean }

function readWrapAad(value: unknown, invalid: Invalid): { aad?: typeof WRAP_AAD_V1 } {
  if (value === undefined) return {}
  if (value !== WRAP_AAD_V1) throw invalid()
  return { aad: WRAP_AAD_V1 }
}

/** Accepts only the canonical `Date.toISOString()` form. */
export function isIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

function readExpiry(value: unknown, invalid: Invalid): { expiresAt?: string } {
  if (value === undefined) return {}
  if (!isIsoInstant(value)) throw invalid()
  return { expiresAt: value }
}

/**
 * Two wraps for one person or one email let a relabelled wrap shadow the real one, and the decoder refuses more
 * than the limits, so a record that breaks these rules must never be read or written.
 */
export function envelopeProblem(wraps: readonly { userId: string; email: string }[], grants: readonly { id: string; email: string }[]): string | null {
  if (wraps.length === 0 || wraps.length > LIMITS.wraps) return 'WRAP_COUNT'
  if (grants.length > LIMITS.grants) return 'GRANT_COUNT'
  if (new Set(wraps.map((wrap) => wrap.userId)).size !== wraps.length) return 'WRAP_DUPLICATE'
  if (new Set(wraps.map((wrap) => wrap.email.toLowerCase())).size !== wraps.length) return 'WRAP_DUPLICATE'
  if (new Set(grants.map((grant) => grant.id)).size !== grants.length) return 'GRANT_DUPLICATE'
  if (new Set(grants.map((grant) => grant.email.toLowerCase())).size !== grants.length) return 'GRANT_DUPLICATE'
  return null
}

function readWraps(value: unknown, fallbackKdf: KdfParams | null, bytes: ByteReader, invalid: Invalid): WrapRecord[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > LIMITS.wraps) throw invalid()
  return value.map((item) => {
    const wrap = asObject(item, invalid)
    return {
      userId: asString(wrap.userId, invalid),
      email: asString(wrap.email, invalid),
      kdf: fallbackKdf ?? readKdf(wrap.kdf, invalid),
      salt: checkLength(bytes(wrap.salt, invalid), SALT_BOUNDS.min, SALT_BOUNDS.max, invalid),
      iv: checkLength(bytes(wrap.iv, invalid), IV_BYTES, IV_BYTES, invalid),
      wrappedDek: checkLength(bytes(wrap.wrappedDek, invalid), WRAPPED_DEK_BYTES, WRAPPED_DEK_BYTES, invalid),
      ...(fallbackKdf ? {} : readWrapAad(wrap.aad, invalid)),
    }
  })
}

function readGrants(value: unknown, bytes: ByteReader, invalid: Invalid, argon2 = false): GrantRecord[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > LIMITS.grants) throw invalid()
  const grants = value.map((item) => {
    const grant = asObject(item, invalid)
    if (grant.kind !== 'INVITE' && grant.kind !== 'RESET') throw invalid()
    const email = asString(grant.email, invalid)
    if (email.length > LIMITS.emailChars) throw invalid()
    return {
      id: asString(grant.id, invalid),
      kind: grant.kind as GrantKind,
      email,
      kdf: argon2 ? readArgon2(grant.kdf, invalid) : readKdf(grant.kdf, invalid),
      salt: checkLength(bytes(grant.salt, invalid), SALT_BOUNDS.min, SALT_BOUNDS.max, invalid),
      iv: checkLength(bytes(grant.iv, invalid), IV_BYTES, IV_BYTES, invalid),
      wrappedDek: checkLength(bytes(grant.wrappedDek, invalid), WRAPPED_DEK_BYTES, WRAPPED_DEK_BYTES, invalid),
      ...(argon2 ? { expiresAt: readExpiry(grant.expiresAt ?? null, invalid).expiresAt } : readExpiry(grant.expiresAt, invalid)),
    }
  })
  return grants.length > 0 ? grants : undefined
}

function readArgon2(value: unknown, invalid: Invalid): Argon2Params {
  if (!isArgon2Params(value)) throw invalid()
  return copyArgon2Params(value)
}

function readBody(value: unknown, readers: Readers, invalid: Invalid): PlainBody {
  const body = asObject(value, invalid)
  return {
    iv: checkLength(readers.bytes(body.iv, invalid), IV_BYTES, IV_BYTES, invalid),
    ciphertext: checkLengthOwned(readers.ciphertext(body.ciphertext, invalid), GCM_TAG_BYTES + 1, LIMITS.ciphertextBytes, invalid),
  }
}

/**
 * A version 3 body: its size, chunk size and seal, each chunk's IV, and (stored form) each chunk's storage key. The
 * ciphertexts come from `readers.chunks`: the IndexedDB values for a stored record, `ciphertext` for a file.
 */
function readChunkedBody(value: unknown, readers: Readers, invalid: Invalid): ChunkedBody {
  const body = asObject(value, invalid)
  const { chunkSize, length } = body
  if (!isChunkSize(chunkSize) || !Number.isSafeInteger(length) || (length as number) < 1) throw invalid()
  if ((length as number) + GCM_TAG_BYTES > LIMITS.ciphertextBytes) throw invalid()
  const count = chunkCount(length as number, chunkSize)
  if (count > MAX_CHUNKS || !Array.isArray(body.chunks) || body.chunks.length !== count) throw invalid()
  const seal = asObject(body.seal, invalid)
  const sizes = chunkCiphertextSizes(length as number, chunkSize)
  const entries = body.chunks.map((item): Omit<BodyChunk, 'ciphertext'> => {
    if (!readers.stored) return { iv: checkLength(readers.bytes(item, invalid), IV_BYTES, IV_BYTES, invalid) }
    const chunk = asObject(item, invalid)
    if (typeof chunk.key !== 'string' || !CHUNK_KEY.test(chunk.key)) throw invalid()
    return { iv: checkLength(readers.bytes(chunk.iv, invalid), IV_BYTES, IV_BYTES, invalid), key: chunk.key }
  })
  if (readers.stored && new Set(entries.map((entry) => entry.key)).size !== entries.length) throw invalid()
  const ciphertexts = readers.chunks(body, sizes, invalid)
  return {
    chunkSize,
    length: length as number,
    chunks: entries.map((entry, index) => {
      const ciphertext = ciphertexts[index]
      if (ciphertext !== undefined && ciphertext.byteLength !== sizes[index]) throw invalid()
      return ciphertext === undefined ? entry : { ...entry, ciphertext }
    }),
    seal: {
      iv: checkLength(readers.bytes(seal.iv, invalid), IV_BYTES, IV_BYTES, invalid),
      tag: checkLength(readers.bytes(seal.tag, invalid), GCM_TAG_BYTES, GCM_TAG_BYTES, invalid),
    },
  }
}

function readSchemaVersion(value: unknown, invalid: Invalid, keys = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw invalid()
  if ((value as number) > (keys ? KEYS_SCHEMA_VERSION : SCHEMA_VERSION)) throw new FormatTooNewError()
  if (keys && value !== KEYS_SCHEMA_VERSION) throw invalid()
  return value as number
}

function decode(
  source: Record<string, unknown>,
  version: number,
  readers: Readers,
  invalid: Invalid,
  updatedAtFallback: () => string,
): VaultRecord {
  const record = decodeFields(source, version, readers, invalid, updatedAtFallback)
  if (envelopeProblem(peopleOf(record), record.grants ?? [])) throw invalid()
  return record
}

function decodeFields(
  source: Record<string, unknown>,
  version: number,
  readers: Readers,
  invalid: Invalid,
  updatedAtFallback: () => string,
): VaultRecord {
  const { bytes } = readers
  if (version === 1) {
    const kdf = source.kdf === undefined ? LEGACY_KDF : readKdf(source.kdf, invalid)
    return {
      id: RECORD_ID,
      version: RECORD_VERSION,
      appVersion: asOptionalString(source.appVersion) ?? '1.0.0',
      schemaVersion: 1,
      createdAt: null,
      updatedAt: asOptionalString(source.updatedAt) ?? updatedAtFallback(),
      cipher: { ...PAYLOAD_CIPHER },
      wraps: readWraps(source.wraps, kdf, bytes, invalid),
      body: readBody(source.payload, readers, invalid),
    }
  }
  if (version === KEYS_RECORD_VERSION) {
    if (source.wraps !== undefined) throw invalid()
    const keys = readKeysHeader(source)
    if (!keys) throw invalid()
    return {
      id: RECORD_ID,
      version: KEYS_RECORD_VERSION,
      appVersion: asString(source.appVersion, invalid),
      schemaVersion: readSchemaVersion(source.schemaVersion, invalid, true),
      createdAt: asOptionalString(source.createdAt),
      updatedAt: asString(source.updatedAt, invalid),
      cipher: readCipher(source.cipher, invalid),
      wraps: [],
      ...optionalGrants(readGrants(source.grants, bytes, invalid, true)),
      ...readAudit(source.audit),
      keys,
      body: readChunkedBody(source.body, readers, invalid),
    }
  }
  return {
    id: RECORD_ID,
    version: RECORD_VERSION,
    appVersion: asString(source.appVersion, invalid),
    schemaVersion: readSchemaVersion(source.schemaVersion, invalid),
    createdAt: asOptionalString(source.createdAt),
    updatedAt: asOptionalString(source.updatedAt) ?? updatedAtFallback(),
    cipher: readCipher(source.cipher, invalid),
    wraps: readWraps(source.wraps, null, bytes, invalid),
    ...optionalGrants(readGrants(source.grants, bytes, invalid)),
    ...readAudit(source.audit),
    body: readBody(source.body, readers, invalid),
  }
}

/** Who can open the record: its password wraps, or for version 3 its sealed identities. */
export function peopleOf(record: { wraps: readonly { userId: string; email: string }[]; keys?: KeysHeader }): readonly { userId: string; email: string }[] {
  if (!record.keys) return record.wraps
  return Object.values(record.keys.identities).map((blob) => ({ userId: blob.memberId, email: blob.email }))
}

/** Advisory metadata: a malformed value is dropped rather than refusing the vault. */
function readAudit(value: unknown): { audit?: AuditHead } {
  return isAuditHead(value) ? { audit: { seq: value.seq, hash: value.hash } } : {}
}

function optionalGrants<T>(grants: T[] | undefined): { grants?: T[] } {
  return grants && grants.length > 0 ? { grants } : {}
}

const corrupt: Invalid = () => new CorruptRecordError()
const badBackup: Invalid = () => new ValidationError('BACKUP')

/**
 * Decodes the record kept under `primary`. A version 3 record lists its chunks by storage key: given `chunkValues`
 * (what IndexedDB holds under those keys), every chunk must be there with the right size; without it the record
 * carries no ciphertext, which is enough to read its header.
 */
export function decodeStoredRecord(raw: unknown, chunkValues?: ReadonlyMap<string, unknown>): DecodedRecord {
  const source = asObject(raw, corrupt)
  const version = readVersion(source.version, KEYS_RECORD_VERSION, corrupt)
  const chunks: ChunkReader = (body, sizes, invalid) => {
    if (!chunkValues) return sizes.map(() => undefined)
    return (body.chunks as { key: string }[]).map((chunk) => {
      const value = chunkValues.get(chunk.key)
      if (!(value instanceof ArrayBuffer)) throw invalid()
      return value
    })
  }
  const readers: Readers = { bytes: binary, ciphertext: sharedBinary, chunks, stored: true }
  return { record: decode(source, version, readers, corrupt, () => new Date(0).toISOString()), sourceVersion: version }
}

function copyGrants(grants: readonly GrantRecord[] | undefined): { grants?: GrantRecord[] } {
  return optionalGrants(
    grants?.map((grant) => ({
      id: grant.id,
      kind: grant.kind,
      email: grant.email,
      kdf: copyGrantKdf(grant.kdf),
      salt: cloneBuffer(grant.salt),
      iv: cloneBuffer(grant.iv),
      wrappedDek: cloneBuffer(grant.wrappedDek),
      ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
    })),
  )
}

/** Copies a chunked body's small fields; ciphertexts are shared, like a 1.x body's. */
export function copyChunkedBody(body: ChunkedBody): ChunkedBody {
  return {
    chunkSize: body.chunkSize,
    length: body.length,
    chunks: body.chunks.map((chunk) => ({
      iv: cloneBuffer(chunk.iv),
      ...(chunk.key !== undefined ? { key: chunk.key } : {}),
      ...(chunk.ciphertext !== undefined ? { ciphertext: chunk.ciphertext } : {}),
    })),
    seal: { iv: cloneBuffer(body.seal.iv), tag: cloneBuffer(body.seal.tag) },
  }
}

/** A defensive copy of a record in its in-memory form. `storedForm` gives what IndexedDB holds. */
export function encodeStoredRecord(record: VaultRecord): VaultRecord {
  const fields = {
    id: RECORD_ID,
    appVersion: record.appVersion,
    schemaVersion: record.schemaVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    cipher: { ...PAYLOAD_CIPHER },
  } as const
  if (record.version === KEYS_RECORD_VERSION) {
    return {
      ...fields,
      version: KEYS_RECORD_VERSION,
      wraps: [],
      ...copyGrants(record.grants),
      ...(record.audit ? { audit: { seq: record.audit.seq, hash: record.audit.hash } } : {}),
      keys: copyKeysHeader(record.keys),
      body: copyChunkedBody(record.body),
    }
  }
  return {
    ...fields,
    version: RECORD_VERSION,
    wraps: record.wraps.map((wrap) => ({
      userId: wrap.userId,
      email: wrap.email,
      kdf: { name: wrap.kdf.name, hash: wrap.kdf.hash, iterations: wrap.kdf.iterations },
      salt: cloneBuffer(wrap.salt),
      iv: cloneBuffer(wrap.iv),
      wrappedDek: cloneBuffer(wrap.wrappedDek),
      ...(wrap.aad ? { aad: wrap.aad } : {}),
    })),
    ...copyGrants(record.grants),
    ...(record.audit ? { audit: { seq: record.audit.seq, hash: record.audit.hash } } : {}),
    body: {
      iv: cloneBuffer(record.body.iv),
      // Shared, not cloned: ciphertext buffers are never written to, and IndexedDB copies what it stores.
      ciphertext: record.body.ciphertext,
    },
  }
}

/**
 * The IndexedDB form of `primary`. A version 3 record carries its header fields at the top level, has no `wraps`, and
 * lists its chunks by storage key; their ciphertexts are separate values (see `storage.ts`), so every chunk must
 * have a key by now.
 */
export function storedForm(record: VaultRecord): object {
  const copy = encodeStoredRecord(record)
  if (copy.version !== KEYS_RECORD_VERSION) {
    const { keys: _keys, ...rest } = copy
    return rest
  }
  const { wraps: _wraps, keys, body, ...rest } = copy
  return {
    ...rest,
    ...keys,
    body: {
      chunkSize: body.chunkSize,
      length: body.length,
      chunks: body.chunks.map((chunk) => {
        if (chunk.key === undefined) throw new Error('Chunk has no storage key')
        return { iv: chunk.iv, key: chunk.key }
      }),
      seal: body.seal,
    },
  }
}

/**
 * A ciphertext a streaming reader decoded on its own, and the placeholder string it left in the JSON instead.
 * Only `body.ciphertext` (`payload.ciphertext` in version 1) may hold the placeholder, and it must, exactly once.
 * For a version 3 file the reader may hand over the chunks already split (`chunks`).
 */
export type CiphertextSlot = { placeholder: string; bytes: Uint8Array } | { placeholder: string; chunks: ArrayBuffer[] }

/** Splits one buffer of concatenated chunk ciphertexts into a buffer per chunk. */
function splitChunks(bytes: Uint8Array, sizes: readonly number[], invalid: Invalid): ArrayBuffer[] {
  const total = sizes.reduce((sum, size) => sum + size, 0)
  if (bytes.byteLength !== total) throw invalid()
  let offset = 0
  return sizes.map((size) => {
    const chunk = bytes.slice(offset, offset + size).buffer
    offset += size
    return chunk
  })
}

/** Base64 of all chunks decoded straight into a buffer per chunk. */
function decodeChunks(text: string, sizes: readonly number[], invalid: Invalid): ArrayBuffer[] {
  if (!BASE64_TEXT.test(text) || text.length % 4 !== 0) throw invalid()
  const targets = sizes.map((size) => new Uint8Array(size))
  const decoder = new Base64Decoder(targets)
  try {
    decoder.pushString(text)
    if (decoder.finish() !== sizes.reduce((sum, size) => sum + size, 0)) throw invalid()
  } catch (error) {
    if (error instanceof Base64Error) throw invalid()
    throw error
  }
  return targets.map((target) => target.buffer)
}

export function parseBackupJson(value: unknown, slot?: CiphertextSlot): DecodedBackup {
  const source = asObject(value, badBackup)
  if (source.format !== BACKUP_FORMAT) throw badBackup()
  const version = readVersion(source.version, KEYS_BACKUP_VERSION, badBackup)
  const now = new Date().toISOString()
  let filled = false
  const ciphertext: ByteReader = (field, invalid) => {
    if (!slot || field !== slot.placeholder) return base64(field, invalid)
    if (filled || !('bytes' in slot)) throw invalid()
    filled = true
    return slot.bytes
  }
  const chunks: ChunkReader = (body, sizes, invalid) => {
    const field = body.ciphertext
    if (!slot || field !== slot.placeholder) return decodeChunks(asString(field, invalid), sizes, invalid)
    if (filled) throw invalid()
    filled = true
    if ('bytes' in slot) return splitChunks(slot.bytes, sizes, invalid)
    if (slot.chunks.length !== sizes.length || slot.chunks.some((chunk, index) => chunk.byteLength !== sizes[index])) throw invalid()
    return slot.chunks
  }
  const record = decode(source, version, { bytes: base64, ciphertext, chunks, stored: false }, badBackup, () => now)
  if (slot && !filled) throw badBackup()
  if (version === 1) record.updatedAt = now
  return {
    record,
    sourceVersion: version,
    appVersion: version === 1 ? '1.0.0' : record.appVersion,
    exportedAt: asOptionalString(source.exportedAt),
  }
}

export function parseBackupText(text: string): DecodedBackup {
  let parsed: unknown
  try {
    parsed = parseJsonSafely(text)
  } catch {
    throw badBackup()
  }
  return parseBackupJson(parsed)
}

function backupFields(record: VaultRecord, exportedAt: string): BackupFields {
  return {
    format: BACKUP_FORMAT,
    appVersion: record.appVersion,
    schemaVersion: record.schemaVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    exportedAt,
    cipher: { ...PAYLOAD_CIPHER },
  }
}

function backupGrants(record: VaultRecord): { grants?: BackupGrantJson[] } {
  return optionalGrants(
    record.grants?.map((grant) => ({
      id: grant.id,
      kind: grant.kind,
      email: grant.email,
      kdf: copyGrantKdf(grant.kdf),
      salt: bytesToBase64(cloneBytes(grant.salt)),
      iv: bytesToBase64(cloneBytes(grant.iv)),
      wrappedDek: bytesToBase64(cloneBytes(grant.wrappedDek)),
      ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
    })),
  )
}

/** The bytes a backup's `ciphertext` holds, in order: the one body, or every chunk. Throws if a chunk has none. */
export function ciphertextParts(record: VaultRecord): Uint8Array[] {
  if (record.version !== KEYS_RECORD_VERSION) return [new Uint8Array(record.body.ciphertext)]
  return record.body.chunks.map((chunk) => {
    if (chunk.ciphertext === undefined) throw new Error('Chunk ciphertext is missing')
    return new Uint8Array(chunk.ciphertext)
  })
}

function joinedBase64(parts: readonly Uint8Array[]): string {
  if (parts.length === 1) return bytesToBase64(parts[0])
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const joined = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.byteLength
  }
  return bytesToBase64(joined)
}

/** `ciphertext` stands in for the base64 body, so a caller can stream the real one into the file instead. */
export function toBackupJson(record: VaultRecord, exportedAt: string, ciphertext?: string): BackupFileV2 | BackupFileV3 {
  const fields = backupFields(record, exportedAt)
  // Field order is part of the file: `format` and `version` first, `body` last with `ciphertext` as its last key.
  const head = { format: fields.format }
  const tail = {
    appVersion: fields.appVersion,
    schemaVersion: fields.schemaVersion,
    createdAt: fields.createdAt,
    updatedAt: fields.updatedAt,
    exportedAt: fields.exportedAt,
    cipher: fields.cipher,
  }
  if (record.version !== KEYS_RECORD_VERSION) {
    return {
      ...head,
      version: BACKUP_VERSION,
      ...tail,
      wraps: record.wraps.map((wrap) => ({
        userId: wrap.userId,
        email: wrap.email,
        kdf: { name: wrap.kdf.name, hash: wrap.kdf.hash, iterations: wrap.kdf.iterations },
        salt: bytesToBase64(cloneBytes(wrap.salt)),
        iv: bytesToBase64(cloneBytes(wrap.iv)),
        wrappedDek: bytesToBase64(cloneBytes(wrap.wrappedDek)),
        ...(wrap.aad ? { aad: wrap.aad } : {}),
      })),
      ...backupGrants(record),
      ...(record.audit ? { audit: { seq: record.audit.seq, hash: record.audit.hash } } : {}),
      body: {
        iv: bytesToBase64(cloneBytes(record.body.iv)),
        ciphertext: ciphertext ?? bytesToBase64(new Uint8Array(record.body.ciphertext)),
      },
    }
  }
  const { body } = record
  return {
    ...head,
    version: KEYS_BACKUP_VERSION,
    ...tail,
    ...backupGrants(record),
    ...(record.audit ? { audit: { seq: record.audit.seq, hash: record.audit.hash } } : {}),
    ...copyKeysHeader(record.keys),
    body: {
      ...manifestJson(body),
      seal: { iv: bytesToBase64(cloneBytes(body.seal.iv)), tag: bytesToBase64(cloneBytes(body.seal.tag)) },
      ciphertext: ciphertext ?? joinedBase64(ciphertextParts(record)),
    },
  }
}

export function storedToBackupJson(raw: unknown, exportedAt: string, ciphertext?: string, chunkValues?: ReadonlyMap<string, unknown>): object {
  const { record, sourceVersion } = decodeStoredRecord(raw, chunkValues)
  if (sourceVersion !== 1 || record.version === KEYS_RECORD_VERSION) return toBackupJson(record, exportedAt, ciphertext)
  const kdf = record.wraps[0].kdf
  return {
    format: BACKUP_FORMAT,
    version: 1,
    kdf: { name: kdf.name, hash: kdf.hash, iterations: kdf.iterations },
    wraps: record.wraps.map((wrap) => ({
      userId: wrap.userId,
      email: wrap.email,
      salt: bytesToBase64(cloneBytes(wrap.salt)),
      iv: bytesToBase64(cloneBytes(wrap.iv)),
      wrappedDek: bytesToBase64(cloneBytes(wrap.wrappedDek)),
    })),
    payload: {
      iv: bytesToBase64(cloneBytes(record.body.iv)),
      ciphertext: ciphertext ?? bytesToBase64(new Uint8Array(record.body.ciphertext)),
    },
  }
}
