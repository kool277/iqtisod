import readXlsxFile from 'read-excel-file/node'
import { extractText, getDocumentProxy } from 'unpdf'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { verifyAuditChain } from '../../src/db/audit-chain'
import { ForbiddenError, ValidationError } from '../../src/domain/errors'
import type { OpenVault } from '../../src/domain/types'
import { LOCALES, loadExportMessages } from '../../src/i18n'
import { Permission, permissionsForRole } from '../../src/rbac'
import { buildViewCsv, canExportView, exportView, isViewTable, type ViewExportRequest } from '../../src/services/export/view'
import { FIXED_NOW, blobBytes, blobText, openLedger, testFonts } from '../support/exports'

let admin: OpenVault
let manager: OpenVault

beforeAll(async () => {
  await Promise.all(LOCALES.map(loadExportMessages))
  admin = await openLedger('Admin')
  manager = await openLedger('Manager')
})

afterAll(() => {
  admin?.db.close()
  manager?.db.close()
})

function request(changes: Partial<ViewExportRequest> = {}): ViewExportRequest {
  return {
    table: 'transactions',
    title: 'Ledger',
    format: 'csv',
    columns: [
      { id: 'date', header: 'Date', kind: 'date' },
      { id: 'category', header: 'Category', kind: 'text' },
      { id: 'amount', header: 'Amount', kind: 'money' },
      { id: 'notes', header: 'Notes', kind: 'text' },
    ],
    rows: [
      ['2026-09-15', 'Food', { money: 25_050, currency: 'USD' }, '=HYPERLINK("https://evil.test","click")'],
      ['2026-09-01', 'Salary', { money: 100_000, currency: 'UZS' }, '+SUM(A1:A2)'],
      ['2026-09-02', '@cmd', null, '-2+3'],
    ],
    total: 10,
    filtered: true,
    scope: { from: '2026-09-01', to: '2026-09-30', groupId: null },
    plainConfirmed: true,
    locale: 'en',
    ...changes,
  }
}

function dataExports(vault: OpenVault): number {
  return Number(vault.db.queryValue("SELECT COUNT(*) FROM audit_logs WHERE action = 'DATA_EXPORTED'"))
}

describe('export current view', () => {
  it('uses the same permission as the full export plus the page permission, and never safes', () => {
    expect(canExportView(admin.user, 'transactions')).toBe(true)
    expect(canExportView(admin.user, 'audit')).toBe(true)
    expect(canExportView(manager.user, 'transactions')).toBe(false)
    expect(canExportView({ permissions: permissionsForRole('Viewer') }, 'transactions')).toBe(false)
    expect(canExportView({ permissions: [Permission.EXPORT_VAULT] }, 'audit')).toBe(false)
    for (const table of ['safes', 'safe-items', 'trash', '__proto__', 'constructor']) expect(isViewTable(table)).toBe(false)
  })

  it('refuses people without export rights before writing anything', async () => {
    const before = dataExports(manager)
    await expect(exportView(manager, request())).rejects.toBeInstanceOf(ForbiddenError)
    expect(dataExports(manager)).toBe(before)
  })

  it('validates the table, confirmation, columns, and every cell', async () => {
    const before = dataExports(admin)
    const bad: Partial<ViewExportRequest>[] = [
      { table: 'safes' as never },
      { plainConfirmed: false },
      { format: 'sqlite' as never },
      { columns: [] },
      { columns: [{ id: 'bad id', header: 'x', kind: 'text' }, ...request().columns.slice(1)] },
      { columns: [{ id: 'date', header: 'x', kind: 'html' as never }, ...request().columns.slice(1)] },
      { rows: [['2026-09-15', 'Food']] },
      { rows: [['2026-09-15', 'Food', { money: 1.5, currency: 'USD' }, '']] },
      { rows: [['2026-09-15', 'Food', { money: 1, currency: 'usd' }, '']] },
      { rows: [['2026-09-15', { money: 1, currency: 'USD' }, null, '']] },
      { rows: [[20260915, 'Food', null, '']] },
    ]
    for (const changes of bad) {
      await expect(exportView(admin, request(changes))).rejects.toBeInstanceOf(ValidationError)
    }
    expect(dataExports(admin)).toBe(before)
  })

  it('writes exactly the visible columns and rows, guards formulas, and keeps money exact', async () => {
    const before = dataExports(admin)
    const result = await exportView(admin, request(), { now: FIXED_NOW })
    expect(result.fileName).toMatch(/^jaybi-.+-2027-02-01-transactions\.csv$/)
    const text = await blobText(result.blob)
    const lines = text.replace(/^\ufeff/, '').trimEnd().split('\r\n')
    expect(lines).toEqual([
      'Date,Category,Amount,Amount · Currency,Notes',
      `2026-09-15,Food,250.50,USD,"'=HYPERLINK(""https://evil.test"",""click"")"`,
      "2026-09-01,Salary,1000.00,UZS,'+SUM(A1:A2)",
      "2026-09-02,'@cmd,,,'-2+3",
    ])
    expect(dataExports(admin)).toBe(before + 1)
    const entry = admin.db.queryOne("SELECT details FROM audit_logs WHERE action = 'DATA_EXPORTED' ORDER BY seq DESC LIMIT 1")
    expect(JSON.parse(String(entry?.details))).toEqual({
      formats: ['csv'],
      protection: 'none',
      scope: { view: 'transactions', columns: ['date', 'category', 'amount', 'notes'], filtered: true, from: '2026-09-01', to: '2026-09-30', groupId: null },
      includesAudit: false,
      includesReceipts: false,
      counts: { rows: 3, total: 10 },
    })
    expect(verifyAuditChain(admin.db).ok).toBe(true)
  })

  it('labels the currency column in the reader language', () => {
    const csv = buildViewCsv(request({ locale: 'ru' }))
    expect(csv.split('\r\n')[0]).toBe('\ufeffDate,Category,Amount,Amount · Валюта,Notes')
  })

  it('builds JSON with exact minor units and the view metadata', async () => {
    const result = await exportView(admin, request({ format: 'json' }), { now: FIXED_NOW })
    const json = JSON.parse(await blobText(result.blob)) as Record<string, unknown>
    expect(json).toMatchObject({ format: 'jaybi-view', version: 1, table: 'transactions', filtered: true, totalRows: 10 })
    expect((json.rows as Record<string, unknown>[])[0]).toEqual({
      date: '2026-09-15',
      category: 'Food',
      amount: { amount: '250.50', amountMinor: 25_050, currency: 'USD' },
      notes: '=HYPERLINK("https://evil.test","click")',
    })
  })

  it('builds Excel with numbers as numbers and text as text', async () => {
    const result = await exportView(admin, request({ format: 'xlsx' }), { now: FIXED_NOW })
    const [sheet] = await readXlsxFile(Buffer.from(await result.blob.arrayBuffer()))
    expect(sheet.data[0]).toEqual(['Date', 'Category', 'Amount', 'Amount · Currency', 'Notes'])
    expect(sheet.data[1][2]).toBe(250.5)
    expect(sheet.data[1][3]).toBe('USD')
    expect(sheet.data[1][4]).toBe('=HYPERLINK("https://evil.test","click")')
    expect(sheet.data[3][2]).toBeNull()
  })

  it('builds a PDF of the view in Cyrillic', async () => {
    const result = await exportView(admin, request({ format: 'pdf', locale: 'uz-Cyrl', title: 'Дафтар' }), { now: FIXED_NOW, fonts: testFonts() })
    const pdf = await getDocumentProxy(await blobBytes(result.blob))
    const { text } = await extractText(pdf, { mergePages: true })
    expect(text).toContain('Дафтар')
    expect(text).toContain('Salary')
    expect(result.mime).toBe('application/pdf')
  })
})
