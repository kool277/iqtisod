import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Base64Decoder, Base64Error, base64Blob, base64ToExactBytes } from '../../src/crypto/encoding'
import { LONG_STRING_BYTES, SKELETON_MAX_BYTES, readBackupFile } from '../../src/db/backup-reader'
import { decodeStoredRecord, encodeStoredRecord, parseBackupText } from '../../src/db/envelope'
import { recordFromSession, wrapsFromRecord } from '../../src/db/storage'
import { AppError } from '../../src/domain/errors'
import { archiveFileBlob, archiveFileText, backupFileBlob, backupFileText } from '../../src/services/backup.service'
import { fixtureByPath, readFixture, readManifest, v1StoredRecordFromBackup } from '../support/fixtures'

const MIB = 1024 * 1024
const NOW = new Date('2026-10-06T12:00:00.000Z')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise
    return null
  } catch (error) {
    return error instanceof AppError ? error.code : String(error)
  }
}

const v4Text = fixtureByPath('v4/access-household').text

/** The v4 fixture with its ciphertext replaced by `bytes` random bytes. */
function backupWithBody(bytes: number, change: (json: Record<string, any>) => void = () => undefined): { text: string; body: Buffer } {
  const json = JSON.parse(v4Text) as Record<string, any>
  const body = randomBytes(bytes)
  json.body.ciphertext = body.toString('base64')
  change(json)
  return { text: JSON.stringify(json), body }
}

const blob = (text: string) => new Blob([text], { type: 'application/json' })

describe('Base64Decoder', () => {
  it('matches Node for every length and any split into pieces', () => {
    for (let length = 0; length < 40; length += 1) {
      const source = randomBytes(length)
      const text = source.toString('base64')
      expect(Buffer.from(base64ToExactBytes(text))).toEqual(source)
      for (const cut of [1, 2, 3, 5, 7]) {
        const target = new Uint8Array(source.length)
        const decoder = new Base64Decoder(target)
        const ascii = new TextEncoder().encode(text)
        for (let offset = 0; offset < ascii.length; offset += cut) decoder.push(ascii.subarray(offset, offset + cut))
        expect(decoder.finish()).toBe(source.length)
        expect(Buffer.from(target)).toEqual(source)
      }
    }
  })

  it('refuses anything that is not padded standard base64', () => {
    for (const bad of ['A', 'AA', 'AAA', 'AAAAA', 'AA=A', 'A===', '====', 'AAA*', 'AA-_', 'AAAA AAAA', 'QUJD\n', 'QUJ\u0141', 'Q\u00c1JD']) {
      expect(() => base64ToExactBytes(bad), bad).toThrow(Base64Error)
    }
    expect(() => new Base64Decoder(new Uint8Array(2)).push(new TextEncoder().encode('QUJD'))).toThrow(Base64Error)
  })

  it('streams base64 into a Blob that equals the one-string encoding', async () => {
    for (const length of [0, 1, 2, 3, 4, 3 * MIB - 1, 3 * MIB, 3 * MIB + 1, 7 * MIB + 2]) {
      const source = randomBytes(length)
      const out = base64Blob('{"a":"', new Uint8Array(source), '"}', 'application/json')
      expect(await out.text()).toBe(`{"a":"${source.toString('base64')}"}`)
    }
  })
})

describe('backup downloads', () => {
  it('stream the same bytes as the one-string file, for current and archived records', async () => {
    for (const entry of readManifest().filter((item) => item.backupFormat > 1)) {
      const { record } = parseBackupText(readFixture(entry).text)
      expect(await backupFileBlob(record, NOW.toISOString()).text()).toBe(backupFileText(record, NOW.toISOString()))
    }
    const v1 = fixtureByPath('v1/household-usd')
    const archive = { key: 'archive:x', reason: 'upgrade' as const, archivedAt: 'x', archivedBy: '1.6.0', sourceVersion: 1, sourceAppVersion: '1.0.0', sourceUpdatedAt: null, raw: v1StoredRecordFromBackup(v1.text) }
    expect(await archiveFileBlob(archive, NOW.toISOString()).text()).toBe(archiveFileText(archive, NOW.toISOString()))
  })

  it('handle a large vault', async () => {
    const { record } = parseBackupText(backupWithBody(5 * MIB + 1).text)
    const streamed = await backupFileBlob(record, NOW.toISOString()).text()
    expect(streamed).toBe(backupFileText(record, NOW.toISOString()))
  })
})

describe('readBackupFile', () => {
  it('reads every golden fixture exactly as the one-string parser does', async () => {
    for (const entry of readManifest()) {
      const { text } = readFixture(entry)
      const expected = parseBackupText(text)
      expect(await readBackupFile(blob(text)), entry.path).toEqual(expected)
      // Forcing the streaming path for the ciphertext gives the same result.
      expect(await readBackupFile(blob(text), { longStringBytes: 64 }), entry.path).toEqual(expected)
    }
  })

  it('decodes a large body across read boundaries into an exactly sized buffer', async () => {
    const { text, body } = backupWithBody(9 * MIB + 2)
    const read = await readBackupFile(blob(text))
    expect(read.record.body.ciphertext.byteLength).toBe(body.length)
    expect(Buffer.from(read.record.body.ciphertext).equals(body)).toBe(true)
    expect(read).toEqual(parseBackupText(text))
  })

  it('refuses a damaged or crafted file as a damaged backup', async () => {
    const long = 'A'.repeat(LONG_STRING_BYTES + 8)
    const cases: [string, string][] = [
      ['not JSON', 'hello'],
      ['unterminated string', '{"format":"moliya-vault'],
      ['truncated after the body', backupWithBody(LONG_STRING_BYTES).text.slice(0, -40)],
      ['two long strings', backupWithBody(LONG_STRING_BYTES, (json) => (json.wraps[0].email = long)).text],
      ['long string outside the ciphertext', backupWithBody(64, (json) => (json.body.iv = long)).text],
      ['long string as a key', backupWithBody(64, (json) => (json[long] = 1)).text],
      ['bad character in the body', backupWithBody(LONG_STRING_BYTES).text.replace(/("ciphertext":"[A-Za-z0-9+/]{100})/, '$1*')],
      ['escape in the body', backupWithBody(LONG_STRING_BYTES).text.replace(/("ciphertext":"[A-Za-z0-9+/]{70000})/, '$1\\u0041')],
      ['escape before the body is long', backupWithBody(LONG_STRING_BYTES).text.replace(/("ciphertext":"[A-Za-z0-9+/]{100})/, '$1\\u0041')],
      ['padding in the middle', backupWithBody(LONG_STRING_BYTES).text.replace(/("ciphertext":"[A-Za-z0-9+/]{100})/, '$1=')],
      ['wrong length', backupWithBody(LONG_STRING_BYTES).text.replace(/("ciphertext":"[A-Za-z0-9+/]{100})/, '$1AB')],
      ['placeholder without a long string', backupWithBody(64, (json) => (json.body.ciphertext = '\u0000ciphertext')).text],
      ['placeholder text in another field', backupWithBody(LONG_STRING_BYTES, (json) => (json.body.iv = '\u0000ciphertext')).text],
      ['skeleton too large', backupWithBody(64, (json) => (json.padding = Array.from({ length: 40_000 }, () => 'x'.repeat(30)))).text],
      ['too deep', backupWithBody(64, (json) => (json.deep = [[[[[[[[[1]]]]]]]]])).text],
      ['forbidden key', backupWithBody(LONG_STRING_BYTES).text.replace('{"format"', '{"__proto__":{},"format"')],
    ]
    for (const [label, text] of cases) expect(await codeOf(readBackupFile(blob(text))), label).toBe('BACKUP')
    expect(await codeOf(readBackupFile(new Blob([new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d])])))).toBe('BACKUP')
    expect(SKELETON_MAX_BYTES).toBe(MIB)
  })

  it('keeps names and emails that are not ASCII', async () => {
    const { text } = backupWithBody(LONG_STRING_BYTES + 1, (json) => (json.exportedAt = '2026-10-06T00:00:00.000Z — Ўзбек'))
    expect((await readBackupFile(blob(text))).exportedAt).toBe('2026-10-06T00:00:00.000Z — Ўзбек')
  })
})

describe('the ciphertext is not copied', () => {
  it('when a stored record is decoded and encoded again', () => {
    const { record } = parseBackupText(v4Text)
    const stored = encodeStoredRecord(record)
    expect(stored.body.ciphertext).toBe(record.body.ciphertext)
    expect(stored.body.iv).not.toBe(record.body.iv)
    const decoded = decodeStoredRecord(stored).record
    expect(decoded.body.ciphertext).toBe(stored.body.ciphertext)
    expect(decoded.wraps[0].salt).not.toBe(stored.wraps[0].salt)
  })

  it('when a session is sealed into a record', () => {
    const { record } = parseBackupText(v4Text)
    const ciphertext = new ArrayBuffer(64)
    const sealed = recordFromSession({ wraps: wrapsFromRecord(record), iv: new Uint8Array(12), ciphertext, schemaVersion: record.schemaVersion, createdAt: null, updatedAt: NOW.toISOString() })
    expect(sealed.body.ciphertext).toBe(ciphertext)
  })

  it('but a view onto a larger buffer is copied out whole', () => {
    const stored = encodeStoredRecord(parseBackupText(v4Text).record)
    const wide = new Uint8Array(stored.body.ciphertext.byteLength + 8)
    wide.set(new Uint8Array(stored.body.ciphertext), 4)
    const decoded = decodeStoredRecord({ ...stored, body: { iv: stored.body.iv, ciphertext: wide.subarray(4, 4 + stored.body.ciphertext.byteLength) } }).record
    expect(decoded.body.ciphertext.byteLength).toBe(stored.body.ciphertext.byteLength)
    expect(new Uint8Array(decoded.body.ciphertext)).toEqual(new Uint8Array(stored.body.ciphertext))
  })
})
