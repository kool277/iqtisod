import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { BlobReader, Uint8ArrayWriter, ZipReader, configure } from '@zip.js/zip.js/index-native.js'
import Ajv2020 from 'ajv/dist/2020'
import readXlsxFile from 'read-excel-file/node'
import { extractText, getDocumentProxy } from 'unpdf'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GENESIS_HASH, auditHash, verifyAuditChain } from '../../src/db/audit-chain'
import { SqlDatabase } from '../../src/db/sqlite'
import { SCHEMA_VERSION } from '../../src/db/versions'
import { ForbiddenError, ValidationError } from '../../src/domain/errors'
import type { OpenVault, SessionUser } from '../../src/domain/types'
import { formatMoney, minorToFixed } from '../../src/lib/money'
import { Permission, permissionsForRole } from '../../src/rbac'
import { createVault } from '../../src/services/auth.service'
import { createTransaction, listCategories } from '../../src/services/finance.service'
import { listGroups } from '../../src/services/group.service'
import { runExport } from '../../src/services/export'
import { AUDIT_CSV_COLUMNS, CSV_COLUMNS, buildAuditCsv, buildTransactionsCsv } from '../../src/services/export/csv'
import { resolveExportScope } from '../../src/services/export/dataset'
import { buildJson, buildJsonl } from '../../src/services/export/json'
import { buildPdf } from '../../src/services/export/pdf'
import { EXPORT_COLUMNS, MOLIYA_APPLICATION_ID, buildExportDatabase, exportTables } from '../../src/services/export/sqlite'
import { buildXlsx } from '../../src/services/export/xlsx'
import {
  ALL_SCOPE,
  EXPORT_FIXTURES,
  blobBytes,
  blobText,
  datasetFor,
  groupIdByName,
  ledger,
  openLedger,
  parseCsv,
  testFonts,
} from '../support/exports'

configure({ useWebWorkers: false })

const exportSchema = JSON.parse(readFileSync(resolve(EXPORT_FIXTURES, '../../../../docs/schemas/moliya-export-1.schema.json'), 'utf8'))
const recordSchema = JSON.parse(readFileSync(resolve(EXPORT_FIXTURES, '../../../../docs/schemas/moliya-export-1.record.schema.json'), 'utf8'))
const ajv = new Ajv2020({ allErrors: true })
ajv.addSchema(exportSchema, 'moliya-export-1.schema.json')
ajv.addSchema(recordSchema, 'moliya-export-1.record.schema.json')
const validateExport = ajv.getSchema('moliya-export-1.schema.json')!
const validateRecord = ajv.getSchema('moliya-export-1.record.schema.json')!

const expectedTx = ledger.expected.transactions
let admin: OpenVault
let manager: OpenVault
let viewer: OpenVault
const extra: { close: () => void }[] = []

beforeAll(async () => {
  ;[admin, manager, viewer] = await Promise.all([openLedger('Admin'), openLedger('Manager'), openLedger('Viewer')])
})

afterAll(() => {
  for (const vault of [admin, manager, viewer]) vault?.db.close()
  for (const item of extra) item.close()
})

/** The fixture's audit log plus the entries its upgrade to the current schema adds. */
function auditActions(): string[] {
  return admin.db.query('SELECT action FROM audit_logs ORDER BY seq').map((row) => String(row.action))
}

function fakeUser(base: SessionUser, changes: Partial<SessionUser>): SessionUser {
  return { ...base, ...changes }
}

async function unzip(blob: Blob, password?: string): Promise<Map<string, Uint8Array>> {
  const reader = new ZipReader(new BlobReader(blob), password ? { password } : {})
  const files = new Map<string, Uint8Array>()
  for (const entry of await reader.getEntries()) {
    if (!entry.directory) files.set(entry.filename, await entry.getData(new Uint8ArrayWriter()))
  }
  await reader.close()
  return files
}

async function pdfText(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes))
  const { text } = await extractText(pdf, { mergePages: false })
  return text
}

const spaces = (text: string) => text.replace(/[\u00a0\u202f]/g, ' ')

describe('export scope and permissions', () => {
  it('lets only people with EXPORT_VAULT export', () => {
    expect(() => resolveExportScope(manager.user, ALL_SCOPE, manager.db)).toThrow(ForbiddenError)
    expect(() => resolveExportScope(viewer.user, ALL_SCOPE, viewer.db)).toThrow(ForbiddenError)
    expect(resolveExportScope(admin.user, ALL_SCOPE, admin.db)).toMatchObject({ groupId: null, groupName: null })
  })

  it('forces anyone other than an admin to their own group, ready for managers later', () => {
    const permitted = fakeUser(manager.user, { permissions: [...permissionsForRole('Manager'), Permission.EXPORT_VAULT] })
    const side = groupIdByName(admin, 'Side Business')
    const scope = resolveExportScope(permitted, { ...ALL_SCOPE, groupId: side }, admin.db)
    expect(scope.groupId).toBe(manager.user.groupId)
    expect(scope.groupName).toBe('Ledger Two')
    expect(() => resolveExportScope(fakeUser(permitted, { groupId: null }), ALL_SCOPE, admin.db)).toThrow(ForbiddenError)
  })

  it('needs READ_AUDIT and all groups for the audit log', () => {
    const noAudit = fakeUser(admin.user, { permissions: admin.user.permissions.filter((item) => item !== Permission.READ_AUDIT) })
    expect(() => resolveExportScope(noAudit, { ...ALL_SCOPE, includeAudit: true }, admin.db)).toThrow(ForbiddenError)
    const side = groupIdByName(admin, 'Side Business')
    const error = (() => {
      try {
        resolveExportScope(admin.user, { ...ALL_SCOPE, groupId: side, includeAudit: true }, admin.db)
      } catch (caught) {
        return caught
      }
    })()
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as ValidationError).code).toBe('EXPORT_AUDIT_SCOPE')
    expect(() => resolveExportScope(admin.user, { ...ALL_SCOPE, groupId: 999_999 }, admin.db)).toThrow(ValidationError)
  })

  it('filters by group and by an inclusive period', async () => {
    const period = datasetFor(admin, { period: { from: '2026-10-02', to: '2026-11-01' } })
    expect(period.counts.transactions).toBe(expectedTx.filter((tx) => tx.date >= '2026-10-02' && tx.date <= '2026-11-01').length)
    expect(period.counts.transactions).toBe(4)
    const rows = []
    for await (const page of period.transactionPages()) rows.push(...page)
    expect(rows.map((row) => row.date)).toEqual(['2026-10-02', '2026-10-02', '2026-10-15', '2026-11-01'])

    const side = datasetFor(admin, { groupId: groupIdByName(admin, 'Side Business') })
    expect(side.counts.transactions).toBe(1)
    expect(side.groups.map((group) => group.name)).toEqual(['Side Business'])
    expect(side.users.map((user) => user.email)).toEqual(['admin@ledger.test'])
    expect(side.summary.totals).toEqual([{ currency: 'USD', incomeMinor: 0n, expenseMinor: 123456n, netMinor: -123456n }])

    const ledgerTwo = datasetFor(admin, { groupId: groupIdByName(admin, 'Ledger Two') })
    expect(ledgerTwo.users.find((user) => user.email === 'admin@ledger.test')?.groupId).toBeNull()
    expect(ledgerTwo.users.find((user) => user.email === 'manager@ledger.test')?.groupId).toBe(groupIdByName(admin, 'Ledger Two'))
  })

  it('pages through large ledgers with a stable keyset order', async () => {
    const copy = await SqlDatabase.openBytes(admin.db.export())
    extra.push(copy)
    const template = copy.queryOne('SELECT category_id, user_id, group_id FROM transactions LIMIT 1')!
    copy.withTransaction(() => {
      for (let index = 0; index < 2_345; index += 1) {
        copy.exec(
          `INSERT INTO transactions (id, type, amount_minor, currency, category_id, user_id, group_id, transaction_date, created_at, updated_at)
           VALUES (?, 'EXPENSE', ?, 'USD', ?, ?, ?, '2026-10-20', '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z')`,
          [`bulk-${String(index).padStart(5, '0')}`, index + 1, template.category_id, template.user_id, template.group_id],
        )
      }
    })
    const dataset = datasetFor({ ...admin, db: copy })
    const sizes: number[] = []
    const ids = new Set<string>()
    for await (const page of dataset.transactionPages()) {
      sizes.push(page.length)
      for (const row of page) ids.add(row.id)
    }
    expect(sizes).toEqual([1000, 1000, 357])
    expect(ids.size).toBe(2_345 + expectedTx.length)
    const controller = new AbortController()
    controller.abort()
    await expect(dataset.transactionPages(controller.signal).next()).rejects.toMatchObject({ code: 'EXPORT_CANCELLED' })
  })
})

describe('CSV export', () => {
  it('writes RFC 4180 UTF-8 with BOM and CRLF that reads back exactly', async () => {
    const dataset = datasetFor(admin)
    const text = await blobText(await buildTransactionsCsv(dataset))
    expect(text.startsWith('\ufeff')).toBe(true)
    expect(text.endsWith('\r\n')).toBe(true)
    expect(text.replace(/"[^"]*"/g, '').split('\n').every((line, index, all) => index === all.length - 1 || line.endsWith('\r'))).toBe(true)
    const [header, ...rows] = parseCsv(text.slice(1))
    expect(header).toEqual([...CSV_COLUMNS])
    expect(header.slice(0, 14)).toEqual(['id', 'date', 'type', 'category', 'amount', 'currency', 'amount_minor', 'minor_unit', 'group', 'recorded_by', 'notes', 'has_receipt', 'created_at', 'updated_at'])
    expect(rows).toHaveLength(expectedTx.length)
    const byId = new Map(rows.map((row) => [row[0], Object.fromEntries(header.map((name, index) => [name, row[index]]))]))
    for (const tx of expectedTx) {
      const row = byId.get(tx.id)!
      expect(row.amount_minor).toBe(String(tx.amountMinor))
      expect(row.amount).toBe(minorToFixed(tx.amountMinor, tx.currency))
      expect(row.currency).toBe(tx.currency)
      expect(row.category).toBe(tx.category)
      expect(row.group).toBe(tx.group)
      expect(row.recorded_by).toBe(tx.userEmail)
      expect(row.has_receipt).toBe(String(tx.hasReceipt))
      const note = tx.notes ?? ''
      expect(row.notes).toBe(/^ *[=+\-@\t\r\n\uff1d\uff0b\uff0d\uff20]/.test(note) ? `'${note}` : note)
    }
    expect(text).toContain('Oʻzbekcha izoh — Ўзбекча')
    expect(text).toContain(`,9999999999999.99,"USD",999999999999999,2,`)
    expect(text).toContain("'@SUM(1+1) csv trap")
  })

  it('writes the audit log as a separate CSV', async () => {
    const dataset = datasetFor(admin, { includeAudit: true })
    const [header, ...rows] = parseCsv((await blobText(await buildAuditCsv(dataset))).slice(1))
    expect(header).toEqual([...AUDIT_CSV_COLUMNS])
    expect(rows.map((row) => row[4])).toEqual(auditActions())
  })
})

describe('JSON export', () => {
  const goldenPath = resolve(EXPORT_FIXTURES, 'ledger-v2.json')

  it('validates against the published schema with exact money and a verifiable audit chain', async () => {
    const text = await blobText(await buildJson(datasetFor(admin, { includeAudit: true })))
    const data = JSON.parse(text)
    expect(validateExport(data), JSON.stringify(validateExport.errors)).toBe(true)
    expect(data.format).toBe('moliya-export')
    expect(data.formatVersion).toBe(1)
    expect(data.schemaVersion).toBe(SCHEMA_VERSION)
    expect(data.transactions).toHaveLength(expectedTx.length)
    for (const tx of expectedTx) {
      const row = data.transactions.find((item: { id: string }) => item.id === tx.id)
      expect(row.amountMinor).toBe(tx.amountMinor)
      expect(row.amount).toBe(minorToFixed(tx.amountMinor, tx.currency))
      expect(row.receipt).toBeNull()
      expect(row.hasReceipt).toBe(tx.hasReceipt)
    }
    expect(text).toContain('"amountMinor":999999999999999')
    const usd = data.totals.find((item: { currency: string }) => item.currency === 'USD')
    const sum = (type: string) => expectedTx.filter((tx) => tx.currency === 'USD' && tx.type === type).reduce((total, tx) => total + BigInt(tx.amountMinor), 0n)
    expect(BigInt(usd.incomeMinor)).toBe(sum('INCOME'))
    expect(BigInt(usd.expenseMinor)).toBe(sum('EXPENSE'))
    expect(data.totals[0].currency).toBe('USD')

    let previous = GENESIS_HASH
    for (const row of data.auditLog) {
      expect(row.prevHash).toBe(previous)
      expect(auditHash(row)).toBe(row.hash)
      previous = row.hash
    }
    expect(data.scope.auditFirstSeq).toBe(1)
    expect(data.scope.auditLastSeq).toBe(auditActions().length)

    for (const record of data.transactions) expect(Object.keys(record)).toEqual(Object.keys(exportSchema.$defs.transaction.properties))
    for (const record of data.auditLog) expect(Object.keys(record)).toEqual(Object.keys(exportSchema.$defs.audit.properties))
  })

  /** Upgrading the fixture appends audit entries stamped with the real clock, a random id and the app version. */
  function stableGolden(text: string): string {
    return text
      .split('\n')
      .map((line) => {
        const seq = /^\s*\{"seq":(\d+),/.exec(line)
        if (!seq || Number(seq[1]) <= ledger.expected.auditActions.length) return line
        return line.replace(/"(id|createdAt|hash)":"[^"]*"/g, '"$1":"*"').replace(/\\"appVersion\\":\\"[^"\\]*\\"/, '\\"appVersion\\":\\"*\\"')
      })
      .join('\n')
  }

  it('matches the golden export for a fixed clock', async () => {
    const text = stableGolden(await blobText(await buildJson(datasetFor(admin, { includeAudit: true }))))
    if (process.env.UPDATE_EXPORT_GOLDEN || !existsSync(goldenPath)) {
      mkdirSync(EXPORT_FIXTURES, { recursive: true })
      writeFileSync(goldenPath, text)
    }
    expect(text).toBe(readFileSync(goldenPath, 'utf8'))
  })

  it('includes receipts only on request, and chains a period from the first exported row', async () => {
    const withReceipts = JSON.parse(await blobText(await buildJson(datasetFor(admin, { includeReceipts: true }))))
    const receipt = withReceipts.transactions.find((row: { hasReceipt: boolean }) => row.hasReceipt)
    expect(receipt.receipt).toMatch(/^data:image\//)
    expect(validateExport(withReceipts)).toBe(true)

    const dates = String(admin.db.queryValue('SELECT substr(created_at, 1, 10) FROM audit_logs WHERE seq = 5'))
    const partial = JSON.parse(await blobText(await buildJson(datasetFor(admin, { includeAudit: true, period: { from: dates, to: dates } }))))
    expect(partial.auditLog.length).toBeGreaterThan(0)
    expect(partial.scope.auditFirstSeq).toBe(partial.auditLog[0].seq)
    let previous = partial.auditLog[0].prevHash
    for (const row of partial.auditLog) {
      expect(row.prevHash).toBe(previous)
      expect(auditHash(row)).toBe(row.hash)
      previous = row.hash
    }
  })
})

describe('JSON Lines export', () => {
  it('writes a header, one valid record per line, and a footer with counts', async () => {
    const text = await blobText(await buildJsonl(datasetFor(admin, { includeAudit: true })))
    expect(text.startsWith('\ufeff')).toBe(false)
    expect(text.endsWith('\n')).toBe(true)
    const lines = text.trimEnd().split('\n').map((line) => JSON.parse(line))
    for (const line of lines) expect(validateRecord(line), JSON.stringify(validateRecord.errors)).toBe(true)
    expect(lines[0].type).toBe('header')
    expect(lines[0].format).toBe('moliya-export')
    expect(lines.at(-1).type).toBe('footer')
    const order = ['currency', 'group', 'user', 'category', 'transaction', 'audit']
    const types = lines.slice(1, -1).map((line) => line.type)
    expect([...types].sort((a, b) => order.indexOf(a) - order.indexOf(b))).toEqual(types)
    const counts = Object.fromEntries(order.map((type) => [type, types.filter((item) => item === type).length]))
    expect(lines.at(-1).counts).toEqual(counts)
    expect(counts.transaction).toBe(expectedTx.length)
    expect(counts.audit).toBe(auditActions().length)
    const json = JSON.parse(await blobText(await buildJson(datasetFor(admin, { includeAudit: true }))))
    expect(lines.filter((line) => line.type === 'transaction').map((line) => line.data)).toEqual(json.transactions)
    expect(lines.filter((line) => line.type === 'category').map((line) => line.data)).toEqual(json.categories)
    expect(lines.filter((line) => line.type === 'audit').map((line) => line.data)).toEqual(json.auditLog)
    expect(lines[0].totals).toEqual(json.totals)
  })
})

describe('Excel export', () => {
  it('writes typed numbers, UTC dates, localized sheets, text-only formulas, and frozen headers', async () => {
    const blob = await buildXlsx(datasetFor(admin, { includeAudit: true }), 'en')
    const buffer = Buffer.from(await blob.arrayBuffer())
    const sheets = await readXlsxFile(buffer)
    expect(sheets.map((sheet) => sheet.sheet)).toEqual(['Summary', 'Records', 'Categories', 'Groups', 'People', 'Audit log', 'About'])
    const records = sheets[1].data
    expect(records).toHaveLength(expectedTx.length + 1)
    const header = records[0] as string[]
    const utilities = expectedTx.find((tx) => tx.category === 'Utilities')!
    const row = records.find((item) => item[header.indexOf('id')] === utilities.id)!
    expect(row[header.indexOf('Amount')]).toBe(10.5)
    expect(row[header.indexOf('amount_minor')]).toBe(1050)
    expect((row[0] as unknown as Date).toISOString()).toBe(`${utilities.date}T00:00:00.000Z`)
    const largest = records.find((item) => item[header.indexOf('amount_minor')] === 999999999999999)!
    expect(largest[header.indexOf('Amount')]).toBe(9999999999999.99)
    expect(records.some((item) => item.includes('@SUM(1+1) csv trap'))).toBe(true)

    const files = await unzip(blob)
    const sheetXml = new TextDecoder().decode(files.get('xl/worksheets/sheet2.xml'))
    expect(sheetXml).toMatch(/<pane [^>]*ySplit="1"[^>]*state="frozen"/)
    for (const [name, bytes] of files) {
      if (name.startsWith('xl/worksheets/')) expect(new TextDecoder().decode(bytes)).not.toContain('<f>')
    }
  })

  it('stores 2026-09-01 as serial 46266 in any time zone', async () => {
    const created = await createVault({ email: 'tz@example.com', password: 'tz-password-1', displayName: 'TZ', currency: 'UZS' })
    extra.push(created.vault.db)
    const food = listCategories(created.vault).find((category) => category.nameEn === 'Food')!
    createTransaction(created.vault, {
      type: 'EXPENSE',
      amount: '1234567.89',
      currency: 'UZS',
      categoryId: food.id,
      groupId: listGroups(created.vault)[0].id,
      date: '2026-09-01',
      notes: '=HYPERLINK("http://example.com")',
      receiptData: null,
    })
    const original = process.env.TZ
    try {
      for (const zone of ['Asia/Tashkent', 'America/Los_Angeles', 'UTC']) {
        process.env.TZ = zone
        const files = await unzip(await buildXlsx(datasetFor(created.vault), 'uz-Latn'))
        const xml = new TextDecoder().decode(files.get('xl/worksheets/sheet2.xml'))
        expect(xml, zone).toContain('<v>46266</v>')
        expect(xml).not.toContain('<f>')
      }
    } finally {
      process.env.TZ = original
    }
  })
})

describe('PDF report', () => {
  it('renders Cyrillic, the Uzbek ʻ, formatted money, and page footers with the embedded font', async () => {
    const fonts = testFonts()
    const cyrl = await blobBytes(await buildPdf(datasetFor(admin), { locale: 'uz-Cyrl', fonts }))
    const pages = await pdfText(cyrl)
    const all = spaces(pages.join('\n'))
    expect(all.toLowerCase()).toContain('ҳисобот')
    expect(all).toContain('Ledger Two')
    expect(all).toContain('Oʻzbekcha izoh — Ўзбекча')
    expect(all).toContain(spaces(formatMoney(250000000, 'UZS', 'uz-Cyrl')))
    expect(all).toContain('Махфий')
    pages.forEach((text, index) => expect(spaces(text)).toContain(`Саҳифа ${index + 1} / ${pages.length}`))
    const raw = Buffer.from(cyrl).toString('latin1')
    expect(raw).toContain('/FontFile2')
    expect(raw).toMatch(/NotoSans/)
    expect(raw).toContain('/Lang (uz-Cyrl)')
    expect(cyrl.byteLength).toBeLessThan(250_000)

    const latn = spaces((await pdfText(await blobBytes(await buildPdf(datasetFor(admin), { locale: 'uz-Latn', fonts })))).join('\n'))
    expect(latn).toContain('\u02bb')
    expect(latn).toContain('Sogʻliq')
    const ru = spaces((await pdfText(await blobBytes(await buildPdf(datasetFor(admin), { locale: 'ru', fonts })))).join('\n'))
    expect(ru).toContain('Финансовый отчёт')
    expect(ru).toContain(spaces(formatMoney(1050, 'USD', 'ru')))
  })

  it('caps the record table and says so', async () => {
    const text = spaces((await pdfText(await blobBytes(await buildPdf(datasetFor(admin), { locale: 'en', fonts: testFonts(), rowLimit: 5 })))).join('\n'))
    expect(text).toContain('The PDF lists only the first records.')
    expect(text).toContain('Records listed: 5')
  })
})

describe('plain SQLite export', () => {
  async function build(request = {}) {
    const dataset = datasetFor(admin, request)
    const bytes = await buildExportDatabase(admin.db.export(), dataset.meta, { reserveBytes: 0 })
    const db = await SqlDatabase.openBytes(bytes)
    extra.push(db)
    return { bytes, db, dataset }
  }

  it('copies exactly the allowlisted tables, blanks password material, and records export info', async () => {
    const { bytes, db } = await build()
    expect(new TextDecoder().decode(bytes.subarray(0, 15))).toBe('SQLite format 3')
    expect((bytes[16] << 8) | bytes[17]).toBe(4096)
    expect(bytes[20]).toBe(0)
    const tables = db.query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((row) => row.name)
    expect(tables).toEqual([...exportTables({ includesAudit: false }), 'export_info'].sort())
    expect(db.queryValue("SELECT COUNT(*) FROM users WHERE password_hash <> '' OR salt <> ''")).toBe(0)
    expect(db.queryValue('SELECT COUNT(*) FROM users')).toBe(3)
    expect(db.queryValue('SELECT COUNT(*) FROM transactions')).toBe(expectedTx.length)
    expect(db.queryValue('SELECT COUNT(*) FROM transactions WHERE receipt_data IS NOT NULL')).toBe(0)
    expect(db.queryValue('SELECT SUM(amount_minor) FROM transactions WHERE currency = ?', ['EUR'])).toBe(9999)
    expect(db.query('SELECT key FROM settings ORDER BY key').map((row) => row.key)).toEqual(['currency', 'vault_created_at', 'vault_name'])
    expect(db.queryValue('PRAGMA application_id')).toBe(MOLIYA_APPLICATION_ID)
    expect(db.queryValue('PRAGMA user_version')).toBe(SCHEMA_VERSION)
    expect(db.queryValue("SELECT value FROM export_info WHERE key = 'format'")).toBe('moliya-export')
    expect(db.queryValue("SELECT value FROM export_info WHERE key = 'exportedAt'")).toBe('2027-02-01T08:30:00.000Z')
    expect(db.queryValue('PRAGMA integrity_check')).toBe('ok')
    expect(db.query('PRAGMA foreign_key_check')).toEqual([])
    expect(db.query("SELECT name FROM sqlite_schema WHERE type = 'index' AND name LIKE 'idx_tx_%' ORDER BY name").map((row) => row.name)).toEqual([
      'idx_tx_currency_date',
      'idx_tx_date',
      'idx_tx_group',
      'idx_tx_user',
    ])
  })

  it('includes the audit log with its triggers and an intact chain when asked', async () => {
    const { db } = await build({ includeAudit: true, includeReceipts: true })
    expect(verifyAuditChain(db)).toMatchObject({ ok: true, entries: auditActions().length })
    expect(() => db.exec('DELETE FROM audit_logs WHERE seq = 1')).toThrow(/append-only/)
    expect(db.queryValue('SELECT COUNT(*) FROM transactions WHERE receipt_data IS NOT NULL')).toBe(1)
  })

  it('scopes rows to one group and keeps foreign keys valid', async () => {
    const { db } = await build({ groupId: groupIdByName(admin, 'Ledger Two'), period: { from: '2026-10-01', to: '2026-12-31' } })
    expect(db.queryValue('SELECT COUNT(*) FROM groups')).toBe(1)
    expect(db.queryValue('SELECT COUNT(*) FROM transactions')).toBe(
      expectedTx.filter((tx) => tx.group === 'Ledger Two' && tx.date >= '2026-10-01' && tx.date <= '2026-12-31').length,
    )
    expect(db.query('PRAGMA foreign_key_check')).toEqual([])
  })

  it('knows every column of every allowlisted table in the current schema', () => {
    for (const table of exportTables({ includesAudit: true })) {
      const columns = admin.db.query(`PRAGMA table_info(${table})`).map((row) => String(row.name))
      expect(columns.filter((column) => !EXPORT_COLUMNS[table].includes(column)), table).toEqual([])
    }
  })
})

describe('secrets never leave the vault', () => {
  it('omits safes, future tables, unknown columns, other settings, and password material from every format', async () => {
    const planted = await SqlDatabase.openBytes(admin.db.export())
    extra.push(planted)
    const sentinels = ['SAFE-CONTENT-SENTINEL-7f3a', 'FUTURE-TABLE-SENTINEL-19c2', 'SETTING-SENTINEL-55d0', 'COLUMN-SENTINEL-a81e']
    planted.exec('CREATE TABLE safe_items (id TEXT PRIMARY KEY, owner_id TEXT, ciphertext TEXT, title TEXT)')
    planted.exec("INSERT INTO safe_items VALUES ('s1', ?, ?, 'Passport scans')", [admin.user.id, sentinels[0]])
    planted.exec('CREATE TABLE zz_future (secret TEXT)')
    planted.exec('INSERT INTO zz_future VALUES (?)', [sentinels[1]])
    planted.exec("INSERT INTO settings (key, value) VALUES ('safe_master_wrap', ?)", [sentinels[2]])
    planted.exec("ALTER TABLE users ADD COLUMN safe_key_wrap TEXT DEFAULT 'x'")
    planted.exec('UPDATE users SET safe_key_wrap = ?', [sentinels[3]])
    const stored = ['SAFE-WRAP-SENTINEL-2b9e', 'TOTP-SECRET-SENTINEL-c4d1', 'GRANT-VERIFIER-SENTINEL-e6f3', 'CLOCK-SENTINEL-0a7b']
    sentinels.push(...stored)
    const now = '2027-01-15T10:00:00.000Z'
    planted.exec("INSERT INTO safes VALUES ('safe-1', ?, 1, 1, 'iv', ?, 'iv', ?, NULL)", [admin.user.id, stored[0], stored[0]])
    planted.exec("INSERT INTO user_totp VALUES (?, 1, 'kdf', 'salt', 'iv', ?, 0, 'salt', ?, ?, ?)", [admin.user.id, stored[1], stored[1], now, now])
    planted.exec(
      "INSERT INTO access_grants (id, kind, email, role_id, code_verifier, created_at, expires_at) VALUES ('g-1', 'INVITE', 'new@ledger.test', (SELECT MIN(id) FROM roles), ?, ?, '2027-01-16T10:00:00.000Z')",
      [stored[2], now],
    )
    planted.exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('clock_high_water', ?)", [stored[3]])
    const secrets = planted
      .query('SELECT password_hash, salt FROM users')
      .flatMap((row) => [String(row.password_hash), String(row.salt)])
      .filter((secret) => secret !== '')
    expect(secrets.length).toBeGreaterThan(ledger.expected.users.length)
    expect(secrets.every((secret) => secret.length >= 16)).toBe(true)

    const result = await runExport(
      { ...admin, db: planted },
      {
        formats: ['csv', 'json', 'jsonl', 'xlsx', 'pdf', 'sqlite'],
        period: null,
        groupId: null,
        includeAudit: true,
        includeReceipts: true,
        protection: 'none',
        plainConfirmed: true,
        locale: 'ru',
      },
      { fonts: testFonts() },
    )
    expect(result.fileName).toMatch(/^jaybi-Ledger-Two-\d{4}-\d{2}-\d{2}\.zip$/)
    const files = await unzip(result.blob)
    expect([...files.keys()].sort()).toEqual(
      ['README.txt', 'audit-log.csv', 'jaybi.json', 'jaybi.jsonl', 'jaybi.sqlite', 'jaybi.xlsx', 'report.pdf', 'transactions.csv'].sort(),
    )
    const haystacks: string[] = []
    for (const [name, bytes] of files) {
      haystacks.push(Buffer.from(bytes).toString('latin1'), new TextDecoder().decode(bytes))
      if (name.endsWith('.xlsx')) for (const inner of (await unzip(new Blob([bytes as BlobPart]))).values()) haystacks.push(new TextDecoder().decode(inner))
      if (name.endsWith('.pdf')) haystacks.push((await pdfText(bytes)).join('\n'))
    }
    const sqlite = await SqlDatabase.openBytes(files.get('jaybi.sqlite')!)
    extra.push(sqlite)
    expect(sqlite.queryValue('SELECT COUNT(*) FROM users WHERE safe_key_wrap IS NOT NULL')).toBe(0)
    for (const needle of [...sentinels, ...secrets]) {
      for (const haystack of haystacks) expect(haystack.includes(needle), needle).toBe(false)
    }
    expect(haystacks.some((haystack) => haystack.includes('Oʻzbekcha izoh'))).toBe(true)
  })
})

describe('exporting an empty scope', () => {
  it('produces valid files when no record matches', async () => {
    const dataset = datasetFor(admin, { period: { from: '2020-01-01', to: '2020-01-31' } })
    expect(dataset.counts.transactions).toBe(0)
    expect(validateExport(JSON.parse(await blobText(await buildJson(dataset))))).toBe(true)
    expect(parseCsv((await blobText(await buildTransactionsCsv(dataset))).slice(1))).toHaveLength(1)
    const pdf = spaces((await pdfText(await blobBytes(await buildPdf(dataset, { locale: 'en', fonts: testFonts() })))).join('\n'))
    expect(pdf).toContain('Records (0)')
    expect((await readXlsxFile(Buffer.from(await (await buildXlsx(dataset, 'en')).arrayBuffer())))[1].data).toHaveLength(1)
  })
})
