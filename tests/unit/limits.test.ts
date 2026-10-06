import { describe, expect, it } from 'vitest'
import { GCM_TAG_BYTES } from '../../src/crypto/crypto.service'
import {
  decodeStoredRecord,
  encodeStoredRecord,
  parseBackupJson,
  parseBackupText,
  toBackupJson,
  type GrantRecord,
  type VaultRecord,
} from '../../src/db/envelope'
import { AppError, CorruptRecordError } from '../../src/domain/errors'
import { ENGINE_MAX_BYTES } from '../../src/lib/capacity'
import { LIMITS, formatMiB } from '../../src/lib/limits'
import { UnsafeJsonError, jsonDepth, parseJsonSafely } from '../../src/lib/safe-json'
import { fixtureByPath } from '../support/fixtures'

const v2Text = fixtureByPath('v2/ledger-v2').text
const v4Text = fixtureByPath('v4/access-household').text

function codeOf(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (error) {
    return error instanceof AppError ? error.code : 'unexpected'
  }
}

function reasonOf(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (error) {
    return error instanceof UnsafeJsonError ? error.reason : 'unexpected'
  }
}

function nested(depth: number): string {
  return `${'['.repeat(depth)}${']'.repeat(depth)}`
}

function baseRecord(): VaultRecord {
  return parseBackupText(v2Text).record
}

function grantFrom(record: VaultRecord, index: number, overrides: Partial<GrantRecord> = {}): GrantRecord {
  const wrap = record.wraps[0]
  return {
    id: `grant-${index}`,
    kind: index % 2 === 0 ? 'INVITE' : 'RESET',
    email: `person${index}@example.com`,
    kdf: { ...wrap.kdf },
    salt: wrap.salt.slice(0),
    iv: wrap.iv.slice(0),
    wrappedDek: wrap.wrappedDek.slice(0),
    ...overrides,
  }
}

function backupWith(change: (value: Record<string, any>) => void): Record<string, unknown> {
  const value = JSON.parse(JSON.stringify(toBackupJson(baseRecord(), '2026-09-29T00:00:00.000Z'))) as Record<string, any>
  change(value)
  return value
}

function backupGrant(record: VaultRecord, index: number): Record<string, unknown> {
  const json = toBackupJson({ ...record, grants: [grantFrom(record, index)] }, 'x')
  return json.grants![0]
}

describe('LIMITS', () => {
  it('pins the security caps', () => {
    expect(LIMITS).toMatchObject({
      emailChars: 254,
      passwordMin: 12,
      passwordMax: 256,
      receiptBytes: 1.5 * 1024 * 1024,
      ciphertextBytes: 640 * 1024 * 1024 + 16,
      sqliteValueBytes: 8 * 1024 * 1024,
      jsonDepth: 8,
      wraps: 256,
      grants: 64,
    })
    expect(formatMiB(LIMITS.importFileBytes)).toBe('72 MB')
  })

  it('caps ciphertext at the largest vault the SQLite engine can hold', () => {
    expect(LIMITS.ciphertextBytes).toBe(ENGINE_MAX_BYTES + GCM_TAG_BYTES)
  })
})

describe('parseJsonSafely', () => {
  it('parses ordinary JSON', () => {
    expect(parseJsonSafely('{"a":[1,2,{"b":"c"}],"d":null}')).toEqual({ a: [1, 2, { b: 'c' }], d: null })
    expect(parseJsonSafely('"text"')).toBe('text')
  })

  it('rejects input longer than the limit', () => {
    expect(reasonOf(() => parseJsonSafely('"12345678"', { maxChars: 9 }))).toBe('SIZE')
    expect(reasonOf(() => parseJsonSafely('"1234567"', { maxChars: 9 }))).toBeNull()
    expect(() => parseJsonSafely(' '.repeat(LIMITS.importFileBytes + 1))).toThrow(UnsafeJsonError)
    expect(reasonOf(() => parseJsonSafely(' '.repeat(LIMITS.importFileBytes + 1)))).toBe('SIZE')
  })

  it('rejects nesting deeper than eight levels', () => {
    expect(parseJsonSafely(nested(LIMITS.jsonDepth))).toBeDefined()
    expect(reasonOf(() => parseJsonSafely(nested(LIMITS.jsonDepth + 1)))).toBe('DEPTH')
    expect(reasonOf(() => parseJsonSafely('{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":{"i":1}}}}}}}}}'))).toBe('DEPTH')
    expect(reasonOf(() => parseJsonSafely(nested(100_000)))).toBe('DEPTH')
    expect(reasonOf(() => parseJsonSafely(nested(3), { maxDepth: 2 }))).toBe('DEPTH')
  })

  it('does not count brackets inside strings, including escaped quotes', () => {
    expect(jsonDepth('{"a":"[[[[[[[[[[[[{{{{{{{{"}')).toBe(1)
    expect(jsonDepth('["\\"[[[[[[[[[[[[["]')).toBe(1)
    expect(jsonDepth('["\\\\",[[]]]')).toBe(3)
    expect(parseJsonSafely(`{"note":"${'['.repeat(50)}"}`)).toEqual({ note: '['.repeat(50) })
  })

  it('rejects prototype-polluting keys at any depth without polluting', () => {
    for (const text of [
      '{"__proto__":{"polluted":true}}',
      '{"a":{"__proto__":{"polluted":true}}}',
      '[{"constructor":{"prototype":{"polluted":true}}}]',
      '{"prototype":1}',
    ]) {
      expect(reasonOf(() => parseJsonSafely(text)), text).toBe('KEY')
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(parseJsonSafely('{"proto":1,"constructors":2}')).toEqual({ proto: 1, constructors: 2 })
  })

  it('reports syntax errors as UnsafeJsonError', () => {
    expect(reasonOf(() => parseJsonSafely('{'))).toBe('SYNTAX')
    expect(reasonOf(() => parseJsonSafely(''))).toBe('SYNTAX')
    expect(reasonOf(() => parseJsonSafely("{'a':1}"))).toBe('SYNTAX')
  })
})

describe('backup text caps', () => {
  it('refuses deeply nested or polluting backup files', () => {
    const deep = v2Text.replace(/^\{/, `{"extra":${nested(LIMITS.jsonDepth)},`)
    expect(codeOf(() => parseBackupText(deep))).toBe('BACKUP')
    const polluted = v2Text.replace(/^\{/, '{"__proto__":{"admin":true},')
    expect(codeOf(() => parseBackupText(polluted))).toBe('BACKUP')
    expect(codeOf(() => parseBackupText(v2Text))).toBeNull()
  })
})

describe('envelope caps', () => {
  it('accepts up to 256 wraps and refuses more', () => {
    const people = (count: number) => (value: Record<string, any>) =>
      (value.wraps = Array.from({ length: count }, (_, index) => ({ ...value.wraps[0], userId: `user-${index}`, email: `p${index}@caps.test` })))
    const ok = backupWith(people(LIMITS.wraps))
    expect(parseBackupJson(ok).record.wraps).toHaveLength(LIMITS.wraps)
    const tooMany = backupWith(people(LIMITS.wraps + 1))
    expect(codeOf(() => parseBackupJson(tooMany))).toBe('BACKUP')

    const stored = encodeStoredRecord(baseRecord())
    expect(() => decodeStoredRecord({ ...stored, wraps: Array.from({ length: LIMITS.wraps + 1 }, () => stored.wraps[0]) })).toThrow(CorruptRecordError)
  })

  it('accepts up to 64 grants and refuses more', () => {
    const record = baseRecord()
    const grants = Array.from({ length: LIMITS.grants + 1 }, (_, index) => backupGrant(record, index))
    expect(parseBackupJson(backupWith((value) => (value.grants = grants.slice(0, LIMITS.grants)))).record.grants).toHaveLength(LIMITS.grants)
    expect(codeOf(() => parseBackupJson(backupWith((value) => (value.grants = grants))))).toBe('BACKUP')

    const stored = encodeStoredRecord({ ...record, grants: Array.from({ length: LIMITS.grants + 1 }, (_, index) => grantFrom(record, index)) })
    expect(stored.grants).toHaveLength(LIMITS.grants + 1)
    expect(() => decodeStoredRecord(stored)).toThrow(CorruptRecordError)
  })

  it('refuses grant emails longer than 254 characters', () => {
    const record = baseRecord()
    const email = (length: number) => `${'a'.repeat(length - '@example.com'.length)}@example.com`
    const withEmail = (length: number) => backupWith((value) => (value.grants = [{ ...backupGrant(record, 0), email: email(length) }]))
    expect(parseBackupJson(withEmail(254)).record.grants![0].email).toHaveLength(254)
    expect(codeOf(() => parseBackupJson(withEmail(255)))).toBe('BACKUP')
    const stored = encodeStoredRecord({ ...record, grants: [grantFrom(record, 0, { email: email(255) })] })
    expect(() => decodeStoredRecord(stored)).toThrow(CorruptRecordError)
  })

  it('refuses malformed grants', () => {
    const record = baseRecord()
    const cases: [string, (grant: Record<string, unknown>) => void][] = [
      ['unknown kind', (grant) => (grant.kind = 'ADMIN')],
      ['lower-case kind', (grant) => (grant.kind = 'invite')],
      ['missing kind', (grant) => delete grant.kind],
      ['empty email', (grant) => (grant.email = '')],
      ['missing id', (grant) => delete grant.id],
      ['weak kdf', (grant) => (grant.kdf = { name: 'PBKDF2', hash: 'SHA-256', iterations: 1000 })],
      ['short salt', (grant) => (grant.salt = 'AAAA')],
      ['short wrapped key', (grant) => (grant.wrappedDek = 'AAAA')],
      ['bad base64 iv', (grant) => (grant.iv = '****************')],
    ]
    for (const [label, change] of cases) {
      const grant = backupGrant(record, 0)
      change(grant)
      expect(codeOf(() => parseBackupJson(backupWith((value) => (value.grants = [grant])))), label).toBe('BACKUP')
    }
    expect(codeOf(() => parseBackupJson(backupWith((value) => (value.grants = {}))))).toBe('BACKUP')
    expect(codeOf(() => parseBackupJson(backupWith((value) => (value.grants = ['x']))))).toBe('BACKUP')
  })

  it('bounds the body ciphertext', () => {
    const stored = encodeStoredRecord(baseRecord())
    const withCiphertext = (bytes: number) => ({ ...stored, body: { iv: stored.body.iv, ciphertext: new ArrayBuffer(bytes) } })
    expect(() => decodeStoredRecord(withCiphertext(LIMITS.ciphertextBytes + 1))).toThrow(CorruptRecordError)
    expect(() => decodeStoredRecord(withCiphertext(GCM_TAG_BYTES))).toThrow(CorruptRecordError)
    expect(decodeStoredRecord(withCiphertext(GCM_TAG_BYTES + 1)).record.body.ciphertext.byteLength).toBe(GCM_TAG_BYTES + 1)
  })

  it('leaves the grants key out when there are none, for older readers', () => {
    const record = baseRecord()
    for (const grants of [undefined, []]) {
      const input = { ...record, grants }
      expect(encodeStoredRecord(input)).not.toHaveProperty('grants')
      expect(toBackupJson(input, 'x')).not.toHaveProperty('grants')
    }
    expect(parseBackupJson(backupWith((value) => (value.grants = []))).record).not.toHaveProperty('grants')
    expect(parseBackupJson(backupWith((value) => (value.grants = null))).record).not.toHaveProperty('grants')
    expect(decodeStoredRecord({ ...encodeStoredRecord(record), grants: [] }).record).not.toHaveProperty('grants')
  })

  it('round-trips grants through the stored record and backup formats', () => {
    const record = baseRecord()
    const withGrants: VaultRecord = { ...record, grants: [grantFrom(record, 0), grantFrom(record, 1)] }
    const stored = decodeStoredRecord(encodeStoredRecord(withGrants)).record
    expect(stored).toEqual(withGrants)
    expect(stored.grants!.map((grant) => grant.kind)).toEqual(['INVITE', 'RESET'])
    const backup = parseBackupJson(JSON.parse(JSON.stringify(toBackupJson(withGrants, '2026-09-29T00:00:00.000Z')))).record
    expect(backup).toEqual(withGrants)
  })

  it('reads the grants in a 1.3.0 backup', () => {
    const { record } = parseBackupText(v4Text)
    expect(record.grants).toHaveLength(1)
    expect(record.grants![0]).toMatchObject({ kind: 'INVITE', email: 'late@access.test' })
    const again = parseBackupJson(JSON.parse(JSON.stringify(toBackupJson(record, 'x')))).record
    expect(again).toEqual(record)
  })
})
