import { describe, expect, it } from 'vitest'
import { CURRENT_KDF, LEGACY_KDF } from '../../src/crypto/crypto.service'
import {
  decodeStoredRecord,
  encodeStoredRecord,
  parseBackupJson,
  parseBackupText,
  toBackupJson,
} from '../../src/db/envelope'
import { BACKUP_VERSION, RECORD_VERSION, SCHEMA_VERSION } from '../../src/db/versions'
import { AppError, CorruptRecordError, FormatTooNewError } from '../../src/domain/errors'
import { fixtureByPath, v1StoredRecordFromBackup } from '../support/fixtures'

const v1Text = fixtureByPath('v1/business-uzs').text
const v2Text = fixtureByPath('v2/ledger-v2').text

function codeOf(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (error) {
    return error instanceof AppError ? error.code : 'unexpected'
  }
}

function mutate(text: string, change: (value: Record<string, any>) => void): Record<string, unknown> {
  const value = JSON.parse(text) as Record<string, any>
  change(value)
  return value
}

describe('vault envelope', () => {
  it('reads a 1.0.0 backup, taking the KDF from the file', () => {
    const parsed = parseBackupText(v1Text)
    expect(parsed.sourceVersion).toBe(1)
    expect(parsed.appVersion).toBe('1.0.0')
    expect(parsed.record.version).toBe(RECORD_VERSION)
    expect(parsed.record.schemaVersion).toBe(1)
    expect(parsed.record.wraps.every((wrap) => wrap.kdf.iterations === LEGACY_KDF.iterations)).toBe(true)
  })

  it('reads a 1.1.0 backup with per-user KDF parameters', () => {
    const parsed = parseBackupText(v2Text)
    expect(parsed.sourceVersion).toBe(2)
    expect(parsed.appVersion).toBe('1.1.0')
    expect(parsed.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(parsed.record.wraps.every((wrap) => wrap.kdf.iterations === CURRENT_KDF.iterations)).toBe(true)
  })

  it('accepts any in-bounds KDF parameters, not just the ones in use today', () => {
    const custom = mutate(v2Text, (value) => {
      value.wraps[0].kdf = { name: 'PBKDF2', hash: 'SHA-512', iterations: 2_000_000 }
    })
    expect(parseBackupJson(custom).record.wraps[0].kdf).toEqual({ name: 'PBKDF2', hash: 'SHA-512', iterations: 2_000_000 })
    const legacy = mutate(v1Text, (value) => {
      value.kdf.iterations = 310_000
    })
    expect(parseBackupJson(legacy).record.wraps[0].kdf.iterations).toBe(310_000)
  })

  it('round-trips the current backup format', () => {
    const { record } = parseBackupText(v2Text)
    const again = parseBackupJson(JSON.parse(JSON.stringify(toBackupJson(record, '2026-10-01T00:00:00.000Z'))))
    expect(again.record).toEqual(record)
    expect(toBackupJson(record, 'x')).toMatchObject({ version: BACKUP_VERSION, schemaVersion: SCHEMA_VERSION })
  })

  it('refuses files and records written by a newer version', () => {
    expect(codeOf(() => parseBackupJson(mutate(v2Text, (value) => (value.version = BACKUP_VERSION + 1))))).toBe('FORMAT_TOO_NEW')
    expect(codeOf(() => parseBackupJson(mutate(v2Text, (value) => (value.schemaVersion = SCHEMA_VERSION + 1))))).toBe('FORMAT_TOO_NEW')
    const stored = encodeStoredRecord(parseBackupText(v2Text).record)
    expect(() => decodeStoredRecord({ ...stored, version: RECORD_VERSION + 1 })).toThrow(FormatTooNewError)
    expect(() => decodeStoredRecord({ ...stored, schemaVersion: SCHEMA_VERSION + 1 })).toThrow(FormatTooNewError)
  })

  it('rejects damaged or tampered backups', () => {
    const cases: [string, (value: Record<string, any>) => void][] = [
      ['wrong format', (value) => (value.format = 'other')],
      ['version zero', (value) => (value.version = 0)],
      ['too few iterations', (value) => (value.wraps[0].kdf.iterations = 1000)],
      ['too many iterations', (value) => (value.wraps[0].kdf.iterations = 50_000_000)],
      ['unknown hash', (value) => (value.wraps[0].kdf.hash = 'MD5')],
      ['short salt', (value) => (value.wraps[0].salt = 'AAAA')],
      ['bad base64', (value) => (value.wraps[0].iv = '***')],
      ['short wrapped key', (value) => (value.wraps[0].wrappedDek = 'AAAA')],
      ['no wraps', (value) => (value.wraps = [])],
      ['v1 body name in v2', (value) => ((value.payload = value.body), delete value.body)],
      ['unknown cipher', (value) => (value.cipher = { name: 'AES-CBC', length: 256 })],
      ['missing app version', (value) => delete value.appVersion],
    ]
    for (const [label, change] of cases) expect(codeOf(() => parseBackupJson(mutate(v2Text, change))), label).toBe('BACKUP')
    expect(codeOf(() => parseBackupJson(mutate(v1Text, (value) => (value.kdf.iterations = 1000))))).toBe('BACKUP')
    expect(codeOf(() => parseBackupText('{'))).toBe('BACKUP')
  })

  it('reads the IndexedDB record 1.0.0 stored and flags damaged records', () => {
    const raw = v1StoredRecordFromBackup(v1Text)
    const decoded = decodeStoredRecord(raw)
    expect(decoded.sourceVersion).toBe(1)
    expect(decoded.record.updatedAt).toBe(raw.updatedAt)
    expect(() => decodeStoredRecord({ ...raw, payload: undefined })).toThrow(CorruptRecordError)
    expect(() => decodeStoredRecord('garbage')).toThrow(CorruptRecordError)
  })

  it('stores records under a body key 1.0.0 cannot misread', () => {
    const stored = encodeStoredRecord(parseBackupText(v2Text).record) as unknown as Record<string, unknown>
    expect(stored.version).toBe(RECORD_VERSION)
    expect(stored).not.toHaveProperty('payload')
    expect(stored).toHaveProperty('body')
  })
})
