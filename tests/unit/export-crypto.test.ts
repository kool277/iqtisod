import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BlobReader, TextWriter, ZipReader, configure } from '@zip.js/zip.js/index-native.js'
import Database from 'better-sqlite3-multiple-ciphers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { verifyAuditChain } from '../../src/db/audit-chain'
import { ForbiddenError } from '../../src/domain/errors'
import type { OpenVault } from '../../src/domain/types'
import { createVault } from '../../src/services/auth.service'
import { runExport, type ExportProgress, type ExportRequest } from '../../src/services/export'
import { generateExportPassword } from '../../src/services/export/password'
import { SQLCIPHER_KDF_ITERATIONS, assertSqlcipherReady, encryptSqlcipher4 } from '../../src/services/export/sqlcipher'
import { SQLCIPHER_RESERVE_BYTES, buildExportDatabase } from '../../src/services/export/sqlite'
import { buildZip } from '../../src/services/export/zip'
import { EXPORT_FIXTURES, FIXED_NOW, TEST_APP, blobBytes, counterRandom, datasetFor, ledger, openLedger, testFonts } from '../support/exports'

configure({ useWebWorkers: false })

const INPUT = resolve(EXPORT_FIXTURES, 'sqlcipher-input.sqlite')
const SUMS = resolve(EXPORT_FIXTURES, 'SHA256SUMS')
const OUTPUT_SHA = resolve(EXPORT_FIXTURES, 'sqlcipher-output.sha256')
const FIXTURE_PASSWORD = 'Fixture-Export-Key-2027'
const PASSWORD = generateExportPassword(counterRandom(11))
const hasCli = (command: string) => spawnSync(command, ['--version'], { stdio: 'ignore' }).error == null

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const tempDir = mkdtempSync(join(tmpdir(), 'moliya-export-'))
let admin: OpenVault

beforeAll(async () => {
  admin = await openLedger('Admin')
})

afterAll(() => {
  admin?.db.close()
  rmSync(tempDir, { recursive: true, force: true })
})

function writeTemp(name: string, bytes: Uint8Array): string {
  const path = join(tempDir, name)
  writeFileSync(path, bytes)
  return path
}

function openCipher(path: string, password: string): Database {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  db.pragma("cipher = 'sqlcipher'")
  db.pragma('legacy = 4')
  db.pragma(`key = '${password}'`)
  return db
}

function request(changes: Partial<ExportRequest>): ExportRequest {
  return {
    formats: ['csv'],
    period: null,
    groupId: null,
    includeAudit: false,
    includeReceipts: false,
    protection: 'zip',
    password: PASSWORD,
    passwordConfirm: PASSWORD,
    locale: 'en',
    ...changes,
  }
}

type CentralEntry = { name: string; flags: number; method: number; crc: number; extras: Map<number, Uint8Array> }

function centralDirectory(bytes: Uint8Array): CentralEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const entries: CentralEntry[] = []
  for (let offset = 0; offset + 46 <= bytes.byteLength; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    const extras = new Map<number, Uint8Array>()
    for (let cursor = offset + 46 + nameLength; cursor < offset + 46 + nameLength + extraLength; ) {
      const id = view.getUint16(cursor, true)
      const size = view.getUint16(cursor + 2, true)
      extras.set(id, bytes.subarray(cursor + 4, cursor + 4 + size))
      cursor += 4 + size
    }
    entries.push({ name, flags: view.getUint16(offset + 8, true), method: view.getUint16(offset + 10, true), crc: view.getUint32(offset + 16, true), extras })
    offset += 45 + nameLength + extraLength + commentLength
  }
  return entries
}

async function readZip(blob: Blob, password?: string): Promise<Map<string, string>> {
  const reader = new ZipReader(new BlobReader(blob), password ? { password } : {})
  const files = new Map<string, string>()
  for (const entry of await reader.getEntries()) {
    if (!entry.directory) files.set(entry.filename, await entry.getData(new TextWriter()))
  }
  await reader.close()
  return files
}

describe('SQLCipher 4 writer', () => {
  it('produces byte-identical output for a fixed salt and IVs', async () => {
    if (process.env.UPDATE_EXPORT_GOLDEN || !existsSync(INPUT)) {
      const dataset = datasetFor(admin, { includeAudit: true })
      const plain = await buildExportDatabase(admin.db.export(), dataset.meta, { reserveBytes: SQLCIPHER_RESERVE_BYTES })
      writeFileSync(INPUT, plain)
      writeFileSync(SUMS, `${sha256(plain)}  sqlcipher-input.sqlite\n`)
      writeFileSync(OUTPUT_SHA, `${sha256(await encryptSqlcipher4(plain, FIXTURE_PASSWORD, counterRandom(7)))}\n`)
    }
    const input = new Uint8Array(readFileSync(INPUT))
    expect(readFileSync(SUMS, 'utf8')).toBe(`${sha256(input)}  sqlcipher-input.sqlite\n`)
    const first = await encryptSqlcipher4(input, FIXTURE_PASSWORD, counterRandom(7))
    const second = await encryptSqlcipher4(input, FIXTURE_PASSWORD, counterRandom(7))
    expect(sha256(first)).toBe(readFileSync(OUTPUT_SHA, 'utf8').trim())
    expect(second).toEqual(first)
    expect(first.byteLength).toBe(input.byteLength)
    expect(first.subarray(0, 16)).toEqual(counterRandom(7)(16))
    const other = await encryptSqlcipher4(input, FIXTURE_PASSWORD, counterRandom(8))
    expect(sha256(other)).not.toBe(sha256(first))
    expect(Buffer.from(first).includes(Buffer.from('SQLite format 3'))).toBe(false)
    expect(Buffer.from(first).includes(Buffer.from('Ledger Two'))).toBe(false)
  })

  it('opens with the SQLCipher codec in legacy=4 mode and rejects a wrong key', async () => {
    const input = new Uint8Array(readFileSync(INPUT))
    const path = writeTemp('fixture.sqlite', await encryptSqlcipher4(input, FIXTURE_PASSWORD, counterRandom(7)))
    const db = openCipher(path, FIXTURE_PASSWORD)
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM transactions').get()).toEqual({ n: ledger.expected.transactions.length })
      expect(db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get()).toEqual({ n: ledger.expected.auditActions.length })
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
      expect(db.pragma('application_id', { simple: true })).toBe(0x4d4c5941)
      expect(db.prepare("SELECT value FROM export_info WHERE key = 'format'").get()).toEqual({ value: 'moliya-export' })
    } finally {
      db.close()
    }
    const wrong = openCipher(path, 'Not-The-Right-Key-2027')
    expect(() => wrong.prepare('SELECT COUNT(*) FROM transactions').get()).toThrow(/not a database/)
    wrong.close()
  })

  it('refuses input that is not laid out for SQLCipher', async () => {
    const dataset = datasetFor(admin)
    const plain = await buildExportDatabase(admin.db.export(), dataset.meta, { reserveBytes: 0 })
    expect(() => assertSqlcipherReady(plain)).toThrow()
    await expect(encryptSqlcipher4(plain, FIXTURE_PASSWORD)).rejects.toThrow()
    const input = new Uint8Array(readFileSync(INPUT))
    expect(() => assertSqlcipherReady(input.subarray(0, input.byteLength - 1))).toThrow()
    const resized = input.slice()
    resized[16] = 0x20
    resized[17] = 0x00
    expect(() => assertSqlcipherReady(resized)).toThrow()
    expect(() => assertSqlcipherReady(input)).not.toThrow()
    expect(SQLCIPHER_KDF_ITERATIONS).toBe(256_000)
  })

  it.skipIf(!hasCli('sqlcipher'))('opens with the sqlcipher command-line tool', async () => {
    const input = new Uint8Array(readFileSync(INPUT))
    const path = writeTemp('cli.sqlite', await encryptSqlcipher4(input, FIXTURE_PASSWORD, counterRandom(7)))
    const output = execFileSync('sqlcipher', [path], {
      input: `PRAGMA key = '${FIXTURE_PASSWORD}';\nPRAGMA cipher_compatibility = 4;\nSELECT COUNT(*) FROM transactions;\nPRAGMA cipher_integrity_check;\nPRAGMA integrity_check;\n`,
      encoding: 'utf8',
    })
    const lines = output.trim().split('\n')
    expect(lines).toContain(String(ledger.expected.transactions.length))
    expect(lines.at(-1)).toBe('ok')
    const wrong = spawnSync('sqlcipher', [path], { input: "PRAGMA key = 'Wrong-Key-Wrong-Key';\nSELECT COUNT(*) FROM transactions;\n", encoding: 'utf8' })
    expect(`${wrong.stdout}${wrong.stderr}`).toMatch(/not a database/)
  })
})

describe('encrypted ZIP', () => {
  it('uses WinZip AES-256 (AE-2) for every entry and decrypts only with the password', async () => {
    const blob = await buildZip(
      [
        { name: 'a.csv', blob: new Blob(['id,amount\r\n1,10.50\r\n']) },
        { name: 'b.pdf', blob: new Blob(['%PDF-fake']), stored: true },
      ],
      { password: PASSWORD, now: FIXED_NOW },
    )
    const entries = centralDirectory(await blobBytes(blob))
    expect(entries.map((entry) => entry.name)).toEqual(['a.csv', 'b.pdf'])
    for (const entry of entries) {
      expect(entry.flags & 1).toBe(1)
      expect(entry.method).toBe(99)
      const aes = entry.extras.get(0x9901)!
      expect(aes).toBeDefined()
      expect(new DataView(aes.buffer, aes.byteOffset).getUint16(0, true)).toBe(2)
      expect(new TextDecoder().decode(aes.subarray(2, 4))).toBe('AE')
      expect(aes[4]).toBe(3)
      expect(entry.crc).toBe(0)
    }
    expect(Array.from(entries[1].extras.get(0x9901)!.subarray(5, 7))).toEqual([0, 0])
    expect(Array.from(entries[0].extras.get(0x9901)!.subarray(5, 7))).toEqual([8, 0])
    expect((await readZip(blob, PASSWORD)).get('a.csv')).toBe('id,amount\r\n1,10.50\r\n')
    await expect(readZip(blob, 'Wrong-Password-2027')).rejects.toThrow()
    await expect(readZip(blob)).rejects.toThrow()
  })

  it.skipIf(!hasCli('7zz') && !hasCli('7z'))('passes 7-Zip integrity testing', async () => {
    const result = await runExport(admin, request({ formats: ['csv', 'json', 'xlsx', 'pdf'] }), { now: FIXED_NOW, fonts: testFonts(), app: TEST_APP })
    const path = writeTemp('export.zip', await blobBytes(result.blob))
    const command = hasCli('7zz') ? '7zz' : '7z'
    const good = spawnSync(command, ['t', `-p${PASSWORD}`, path], { encoding: 'utf8' })
    expect(good.status, good.stdout + good.stderr).toBe(0)
    expect(good.stdout).toContain('Everything is Ok')
    const listing = spawnSync(command, ['l', '-slt', `-p${PASSWORD}`, path], { encoding: 'utf8' }).stdout
    expect(listing.match(/^Method = .*$/gm)).toEqual(['Method = AES-256 Deflate', 'Method = AES-256 Deflate', 'Method = AES-256 Store', 'Method = AES-256 Store', 'Method = AES-256 Deflate'])
    const bad = spawnSync(command, ['t', '-pWrong-Password-2027', path], { encoding: 'utf8' })
    expect(bad.status).not.toBe(0)
  })
})

describe('runExport', () => {
  it('writes a DATA_EXPORTED audit entry and names files after the vault', async () => {
    const before = Number(admin.db.queryValue('SELECT MAX(seq) FROM audit_logs'))
    const stages: ExportProgress[] = []
    const result = await runExport(admin, request({ formats: ['csv', 'json'], period: { from: '2026-11-01', to: '2026-12-31' } }), {
      now: FIXED_NOW,
      app: TEST_APP,
      onProgress: (progress) => stages.push(progress),
    })
    expect(result.fileName).toBe('jaybi-Ledger-Two-2027-02-01-encrypted.zip')
    expect(result.mime).toBe('application/zip')
    expect(stages.map((stage) => stage.stage)).toEqual(['collecting', 'building', 'building', 'encrypting', 'done'])
    const files = await readZip(result.blob, PASSWORD)
    expect([...files.keys()]).toEqual(['transactions.csv', 'jaybi.json', 'README.txt'])
    expect(files.get('README.txt')).toContain('jaybi.json')
    const entry = admin.db.queryOne('SELECT seq, actor_id, action, entity_type, details FROM audit_logs ORDER BY seq DESC LIMIT 1')!
    expect(Number(entry.seq)).toBe(before + 1)
    expect(entry.actor_id).toBe(admin.user.id)
    expect(entry.action).toBe('DATA_EXPORTED')
    expect(JSON.parse(String(entry.details))).toEqual({
      formats: ['csv', 'json'],
      protection: 'zip',
      scope: { from: '2026-11-01', to: '2026-12-31', groupId: null },
      includesAudit: false,
      includesReceipts: false,
      counts: { currencies: 4, groups: 2, users: 3, categories: expect.any(Number), transactions: 7, audit: 0 },
    })
    expect(String(entry.details)).not.toContain(PASSWORD)
    expect(verifyAuditChain(admin.db).ok).toBe(true)
  })

  it('writes an SQLCipher file that opens with the export password', async () => {
    const result = await runExport(admin, request({ formats: ['csv', 'pdf'], protection: 'sqlcipher', includeAudit: true }), { now: FIXED_NOW, app: TEST_APP })
    expect(result.fileName).toBe('jaybi-Ledger-Two-2027-02-01-encrypted.sqlite')
    const path = writeTemp('run.sqlite', await blobBytes(result.blob))
    const db = openCipher(path, PASSWORD)
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM transactions').get()).toEqual({ n: ledger.expected.transactions.length })
      expect(db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'DATA_EXPORTED'").get()).toEqual({
        n: Number(admin.db.queryValue("SELECT COUNT(*) FROM audit_logs WHERE action = 'DATA_EXPORTED'")),
      })
      expect(db.prepare("SELECT COUNT(*) AS n FROM users WHERE password_hash <> ''").get()).toEqual({ n: 0 })
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    } finally {
      db.close()
    }
  })

  it('downloads a single plain file directly, and needs the plain-file confirmation', async () => {
    await expect(runExport(admin, request({ formats: ['json'], protection: 'none', password: undefined }), { now: FIXED_NOW })).rejects.toMatchObject({
      code: 'EXPORT_PLAIN_UNCONFIRMED',
    })
    const result = await runExport(admin, request({ formats: ['json'], protection: 'none', plainConfirmed: true, password: undefined }), { now: FIXED_NOW })
    expect(result.fileName).toBe('jaybi-Ledger-Two-2027-02-01.json')
    expect(result.mime).toBe('application/json')
    expect(JSON.parse(await result.blob.text()).format).toBe('moliya-export')
  })

  it('refuses the sign-in password, weak passwords, and people without export permission', async () => {
    const strong = 'Plum-Otter-Vivid-42-Ranch'
    const created = await createVault({ email: 'owner@example.com', password: strong, displayName: 'Owner', currency: 'UZS' })
    try {
      const count = () => Number(created.vault.db.queryValue("SELECT COUNT(*) FROM audit_logs WHERE action = 'DATA_EXPORTED'"))
      await expect(runExport(created.vault, request({ password: strong, passwordConfirm: strong }))).rejects.toMatchObject({ code: 'EXPORT_PASSWORD_REUSED' })
      await expect(runExport(created.vault, request({ password: 'aaaaaaaaaaaaaaaa', passwordConfirm: 'aaaaaaaaaaaaaaaa' }))).rejects.toMatchObject({
        code: 'EXPORT_PASSWORD_WEAK',
      })
      await expect(runExport(created.vault, request({ passwordConfirm: `${PASSWORD}x` }))).rejects.toMatchObject({ code: 'EXPORT_PASSWORD_MISMATCH' })
      expect(count()).toBe(0)
    } finally {
      created.vault.db.close()
    }
    const manager = await openLedger('Manager')
    try {
      await expect(runExport(manager, request({}))).rejects.toBeInstanceOf(ForbiddenError)
      expect(Number(manager.db.queryValue("SELECT COUNT(*) FROM audit_logs WHERE action = 'DATA_EXPORTED'"))).toBe(0)
    } finally {
      manager.db.close()
    }
  })

  it('stops when cancelled and keeps the audit entry for the attempt', async () => {
    const controller = new AbortController()
    const before = Number(admin.db.queryValue("SELECT COUNT(*) FROM audit_logs WHERE action = 'DATA_EXPORTED'"))
    await expect(
      runExport(admin, request({ formats: ['csv', 'json'] }), {
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.stage === 'building') controller.abort()
        },
      }),
    ).rejects.toMatchObject({ code: 'EXPORT_CANCELLED' })
    expect(Number(admin.db.queryValue("SELECT COUNT(*) FROM audit_logs WHERE action = 'DATA_EXPORTED'"))).toBe(before + 1)
  })
})
