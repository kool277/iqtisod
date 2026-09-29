import {
  GCM_TAG_BYTES,
  IV_BYTES,
  LEGACY_KDF,
  SALT_BOUNDS,
  WRAPPED_DEK_BYTES,
  isKdfParams,
  type KdfParams,
} from '../crypto/crypto.service'
import { base64ToBytes, bytesToBase64, cloneBuffer, cloneBytes } from '../crypto/encoding'
import { CorruptRecordError, FormatTooNewError, ValidationError } from '../domain/errors'
import { BACKUP_VERSION, RECORD_VERSION, SCHEMA_VERSION } from './versions'

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
}

export type VaultRecord = {
  id: typeof RECORD_ID
  version: typeof RECORD_VERSION
  appVersion: string
  schemaVersion: number
  createdAt: string | null
  updatedAt: string
  cipher: PayloadCipher
  wraps: WrapRecord[]
  body: { iv: ArrayBuffer; ciphertext: ArrayBuffer }
}

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
}

export type BackupFileV2 = {
  format: typeof BACKUP_FORMAT
  version: typeof BACKUP_VERSION
  appVersion: string
  schemaVersion: number
  createdAt: string | null
  updatedAt: string
  exportedAt: string
  cipher: PayloadCipher
  wraps: BackupWrapJson[]
  body: { iv: string; ciphertext: string }
}

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

function base64(value: unknown, invalid: Invalid): Uint8Array {
  const text = asString(value, invalid)
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) throw invalid()
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

function readKdf(value: unknown, invalid: Invalid): KdfParams {
  if (!isKdfParams(value)) throw invalid()
  return { name: value.name, hash: value.hash, iterations: value.iterations }
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

function readWraps(value: unknown, fallbackKdf: KdfParams | null, bytes: ByteReader, invalid: Invalid): WrapRecord[] {
  if (!Array.isArray(value) || value.length === 0) throw invalid()
  return value.map((item) => {
    const wrap = asObject(item, invalid)
    return {
      userId: asString(wrap.userId, invalid),
      email: asString(wrap.email, invalid),
      kdf: fallbackKdf ?? readKdf(wrap.kdf, invalid),
      salt: checkLength(bytes(wrap.salt, invalid), SALT_BOUNDS.min, SALT_BOUNDS.max, invalid),
      iv: checkLength(bytes(wrap.iv, invalid), IV_BYTES, IV_BYTES, invalid),
      wrappedDek: checkLength(bytes(wrap.wrappedDek, invalid), WRAPPED_DEK_BYTES, WRAPPED_DEK_BYTES, invalid),
    }
  })
}

function readBody(value: unknown, bytes: ByteReader, invalid: Invalid): VaultRecord['body'] {
  const body = asObject(value, invalid)
  return {
    iv: checkLength(bytes(body.iv, invalid), IV_BYTES, IV_BYTES, invalid),
    ciphertext: checkLength(bytes(body.ciphertext, invalid), GCM_TAG_BYTES + 1, Number.MAX_SAFE_INTEGER, invalid),
  }
}

function readSchemaVersion(value: unknown, invalid: Invalid): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw invalid()
  if ((value as number) > SCHEMA_VERSION) throw new FormatTooNewError()
  return value as number
}

function decode(
  source: Record<string, unknown>,
  version: number,
  bytes: ByteReader,
  invalid: Invalid,
  updatedAtFallback: () => string,
): VaultRecord {
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
      body: readBody(source.payload, bytes, invalid),
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
    body: readBody(source.body, bytes, invalid),
  }
}

const corrupt: Invalid = () => new CorruptRecordError()
const badBackup: Invalid = () => new ValidationError('BACKUP')

export function decodeStoredRecord(raw: unknown): DecodedRecord {
  const source = asObject(raw, corrupt)
  const version = readVersion(source.version, RECORD_VERSION, corrupt)
  return { record: decode(source, version, binary, corrupt, () => new Date(0).toISOString()), sourceVersion: version }
}

export function encodeStoredRecord(record: VaultRecord): VaultRecord {
  return {
    id: RECORD_ID,
    version: RECORD_VERSION,
    appVersion: record.appVersion,
    schemaVersion: record.schemaVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    cipher: { ...PAYLOAD_CIPHER },
    wraps: record.wraps.map((wrap) => ({
      userId: wrap.userId,
      email: wrap.email,
      kdf: { name: wrap.kdf.name, hash: wrap.kdf.hash, iterations: wrap.kdf.iterations },
      salt: cloneBuffer(wrap.salt),
      iv: cloneBuffer(wrap.iv),
      wrappedDek: cloneBuffer(wrap.wrappedDek),
    })),
    body: {
      iv: cloneBuffer(record.body.iv),
      ciphertext: cloneBuffer(record.body.ciphertext),
    },
  }
}

export function parseBackupJson(value: unknown): DecodedBackup {
  const source = asObject(value, badBackup)
  if (source.format !== BACKUP_FORMAT) throw badBackup()
  const version = readVersion(source.version, BACKUP_VERSION, badBackup)
  const now = new Date().toISOString()
  const record = decode(source, version, base64, badBackup, () => now)
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
    parsed = JSON.parse(text)
  } catch {
    throw badBackup()
  }
  return parseBackupJson(parsed)
}

export function toBackupJson(record: VaultRecord, exportedAt: string): BackupFileV2 {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    appVersion: record.appVersion,
    schemaVersion: record.schemaVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    exportedAt,
    cipher: { ...PAYLOAD_CIPHER },
    wraps: record.wraps.map((wrap) => ({
      userId: wrap.userId,
      email: wrap.email,
      kdf: { name: wrap.kdf.name, hash: wrap.kdf.hash, iterations: wrap.kdf.iterations },
      salt: bytesToBase64(cloneBytes(wrap.salt)),
      iv: bytesToBase64(cloneBytes(wrap.iv)),
      wrappedDek: bytesToBase64(cloneBytes(wrap.wrappedDek)),
    })),
    body: {
      iv: bytesToBase64(cloneBytes(record.body.iv)),
      ciphertext: bytesToBase64(cloneBytes(record.body.ciphertext)),
    },
  }
}

export function storedToBackupJson(raw: unknown, exportedAt: string): object {
  const { record, sourceVersion } = decodeStoredRecord(raw)
  if (sourceVersion !== 1) return toBackupJson(record, exportedAt)
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
      ciphertext: bytesToBase64(cloneBytes(record.body.ciphertext)),
    },
  }
}