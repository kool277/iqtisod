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
import { base64ToBytes, bytesToBase64, cloneBuffer, cloneBytes } from '../crypto/encoding'
import { copyArgon2Params, isArgon2Params, type Argon2Params } from '../crypto/kdf'
import { CorruptRecordError, FormatTooNewError, ValidationError } from '../domain/errors'
import { LIMITS } from '../lib/limits'
import { parseJsonSafely } from '../lib/safe-json'
import { isAuditHead, type AuditHead } from './audit-chain'
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

export type VaultRecord = {
  id: typeof RECORD_ID
  version: typeof RECORD_VERSION | typeof KEYS_RECORD_VERSION
  appVersion: string
  schemaVersion: number
  createdAt: string | null
  updatedAt: string
  cipher: PayloadCipher
  wraps: WrapRecord[]
  grants?: GrantRecord[]
  /** The audit log's last entry when the record was sealed (1.4.2+). Advisory: lets a reader notice a shortened or rewritten log. */
  audit?: AuditHead
  /** Version 3 only. Its `wraps` is then always empty: each member's key is in `keys.identities` and `keys.dekWraps`. */
  keys?: KeysHeader
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
  grants?: BackupGrantJson[]
  audit?: AuditHead
  body: { iv: string; ciphertext: string }
}

export type BackupFileV3 = Omit<BackupFileV2, 'version' | 'wraps'> & { version: typeof KEYS_BACKUP_VERSION } & KeysHeader

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

function readBody(value: unknown, bytes: ByteReader, invalid: Invalid): VaultRecord['body'] {
  const body = asObject(value, invalid)
  return {
    iv: checkLength(bytes(body.iv, invalid), IV_BYTES, IV_BYTES, invalid),
    ciphertext: checkLength(bytes(body.ciphertext, invalid), GCM_TAG_BYTES + 1, LIMITS.ciphertextBytes, invalid),
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
  bytes: ByteReader,
  invalid: Invalid,
  updatedAtFallback: () => string,
): VaultRecord {
  const record = decodeFields(source, version, bytes, invalid, updatedAtFallback)
  if (envelopeProblem(peopleOf(record), record.grants ?? [])) throw invalid()
  return record
}

function decodeFields(
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
      body: readBody(source.body, bytes, invalid),
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
    body: readBody(source.body, bytes, invalid),
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

export function decodeStoredRecord(raw: unknown): DecodedRecord {
  const source = asObject(raw, corrupt)
  const version = readVersion(source.version, KEYS_RECORD_VERSION, corrupt)
  return { record: decode(source, version, binary, corrupt, () => new Date(0).toISOString()), sourceVersion: version }
}

/** A defensive copy of a record in its in-memory form. `storedForm` gives what IndexedDB holds. */
export function encodeStoredRecord(record: VaultRecord): VaultRecord {
  const keys = record.version === KEYS_RECORD_VERSION && record.keys ? copyKeysHeader(record.keys) : null
  return {
    id: RECORD_ID,
    version: keys ? KEYS_RECORD_VERSION : RECORD_VERSION,
    appVersion: record.appVersion,
    schemaVersion: record.schemaVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    cipher: { ...PAYLOAD_CIPHER },
    wraps: keys ? [] : record.wraps.map((wrap) => ({
      userId: wrap.userId,
      email: wrap.email,
      kdf: { name: wrap.kdf.name, hash: wrap.kdf.hash, iterations: wrap.kdf.iterations },
      salt: cloneBuffer(wrap.salt),
      iv: cloneBuffer(wrap.iv),
      wrappedDek: cloneBuffer(wrap.wrappedDek),
      ...(wrap.aad ? { aad: wrap.aad } : {}),
    })),
    ...optionalGrants(
      record.grants?.map((grant) => ({
        id: grant.id,
        kind: grant.kind,
        email: grant.email,
        kdf: copyGrantKdf(grant.kdf),
        salt: cloneBuffer(grant.salt),
        iv: cloneBuffer(grant.iv),
        wrappedDek: cloneBuffer(grant.wrappedDek),
        ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
      })),
    ),
    ...(record.audit ? { audit: { seq: record.audit.seq, hash: record.audit.hash } } : {}),
    ...(keys ? { keys } : {}),
    body: {
      iv: cloneBuffer(record.body.iv),
      ciphertext: cloneBuffer(record.body.ciphertext),
    },
  }
}

/** The IndexedDB form. A version 3 record carries its header fields at the top level and has no `wraps`. */
export function storedForm(record: VaultRecord): object {
  const { wraps, keys, body, ...rest } = encodeStoredRecord(record)
  return keys ? { ...rest, ...keys, body } : { ...rest, wraps, body }
}

export function parseBackupJson(value: unknown): DecodedBackup {
  const source = asObject(value, badBackup)
  if (source.format !== BACKUP_FORMAT) throw badBackup()
  const version = readVersion(source.version, KEYS_BACKUP_VERSION, badBackup)
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
    parsed = parseJsonSafely(text)
  } catch {
    throw badBackup()
  }
  return parseBackupJson(parsed)
}

export function toBackupJson(record: VaultRecord, exportedAt: string): BackupFileV2 | BackupFileV3 {
  const v2 = toBackupJsonV2(record, exportedAt)
  if (record.version !== KEYS_RECORD_VERSION || !record.keys) return v2
  const { wraps: _wraps, version: _version, body, ...rest } = v2
  return { ...rest, version: KEYS_BACKUP_VERSION, ...copyKeysHeader(record.keys), body }
}

function toBackupJsonV2(record: VaultRecord, exportedAt: string): BackupFileV2 {
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
      ...(wrap.aad ? { aad: wrap.aad } : {}),
    })),
    ...optionalGrants(
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
    ),
    ...(record.audit ? { audit: { seq: record.audit.seq, hash: record.audit.hash } } : {}),
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