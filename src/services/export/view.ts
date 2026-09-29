import { ForbiddenError, ValidationError } from '../../domain/errors'
import type { OpenVault } from '../../domain/types'
import type { Locale } from '../../i18n'
import { toIsoDate } from '../../lib/dates'
import { minorToFixed } from '../../lib/money'
import { writeAudit } from '../audit.service'
import { csvCell } from './csv'
import { MIME, exportFileName, type ExportResult } from './options'
import type { PdfFonts } from './pdf-fonts'
import { currencyHeader, isViewMoney, type ViewCell, type ViewColumn, type ViewKind } from './view-cells'
import { canExportView, isViewTable, type ViewTable } from '../view-access'

export type { ViewCell, ViewColumn, ViewKind, ViewMoney } from './view-cells'
export { VIEW_TABLES, canExportView, isViewTable, type ViewTable } from '../view-access'

export const VIEW_FORMATS = ['csv', 'xlsx', 'pdf', 'json'] as const
export type ViewFormat = (typeof VIEW_FORMATS)[number]

export type ViewExportRequest = {
  table: ViewTable
  title: string
  format: ViewFormat
  columns: ViewColumn[]
  rows: ViewCell[][]
  /** Rows the table held before search and filters. */
  total: number
  filtered: boolean
  scope?: { from: string | null; to: string | null; groupId: number | null }
  plainConfirmed: boolean
  locale: Locale
}

export type ViewContext = { now?: Date; fonts?: PdfFonts }

export const VIEW_MAX_COLUMNS = 40
export const VIEW_MAX_ROWS = 100_000
const VIEW_MAX_TEXT = 32_767
const COLUMN_ID = /^[a-zA-Z][a-zA-Z0-9-]{0,40}$/
const CURRENCY = /^[A-Z]{3}$/
const KINDS: readonly ViewKind[] = ['text', 'number', 'money', 'date', 'when', 'boolean']

function validCell(kind: ViewKind, value: unknown): boolean {
  if (value === null) return true
  switch (kind) {
    case 'money':
      return isViewMoney(value as ViewCell) && CURRENCY.test((value as { currency: string }).currency)
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    default:
      return typeof value === 'string' && value.length <= VIEW_MAX_TEXT
  }
}

export function assertViewExport(user: OpenVault['user'], request: ViewExportRequest): void {
  if (typeof request.table !== 'string' || !isViewTable(request.table)) throw new ValidationError('EXPORT_VIEW')
  if (!canExportView(user, request.table)) throw new ForbiddenError()
  if (!(VIEW_FORMATS as readonly string[]).includes(request.format)) throw new ValidationError('EXPORT_NO_FORMAT')
  if (request.plainConfirmed !== true) throw new ValidationError('EXPORT_PLAIN_UNCONFIRMED')
  const { columns, rows } = request
  if (!Array.isArray(columns) || columns.length === 0 || columns.length > VIEW_MAX_COLUMNS) throw new ValidationError('EXPORT_VIEW')
  const ids = new Set<string>()
  for (const column of columns) {
    if (!COLUMN_ID.test(column.id) || ids.has(column.id) || !KINDS.includes(column.kind)) throw new ValidationError('EXPORT_VIEW')
    if (typeof column.header !== 'string' || column.header.length > 200) throw new ValidationError('EXPORT_VIEW')
    ids.add(column.id)
  }
  if (!Array.isArray(rows) || rows.length > VIEW_MAX_ROWS) throw new ValidationError('EXPORT_VIEW')
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== columns.length) throw new ValidationError('EXPORT_VIEW')
    for (let index = 0; index < columns.length; index += 1) {
      if (!validCell(columns[index].kind, row[index])) throw new ValidationError('EXPORT_VIEW')
    }
  }
}

function text(value: ViewCell): string | null {
  if (value == null) return null
  if (isViewMoney(value)) return null
  return String(value)
}

const BOM = '\ufeff'
const CRLF = '\r\n'

/** Money becomes a plain decimal plus a currency column so spreadsheets read it as a number; every text cell goes through the formula guard. */
export function buildViewCsv(request: Pick<ViewExportRequest, 'columns' | 'rows' | 'locale'>): string {
  const header: string[] = []
  for (const column of request.columns) {
    header.push(csvCell(column.header))
    if (column.kind === 'money') header.push(csvCell(currencyHeader(column, request.locale)))
  }
  const lines = [header.join(',')]
  for (const row of request.rows) {
    const cells: string[] = []
    request.columns.forEach((column, index) => {
      const value = row[index]
      if (column.kind === 'money') {
        if (isViewMoney(value)) cells.push(minorToFixed(value.money, value.currency), csvCell(value.currency))
        else cells.push('', '')
      } else if (column.kind === 'number' && typeof value === 'number') {
        cells.push(Number.isFinite(value) ? String(value) : '')
      } else if (column.kind === 'boolean' && typeof value === 'boolean') {
        cells.push(csvCell(value))
      } else {
        cells.push(csvCell(text(value)))
      }
    })
    lines.push(cells.join(','))
  }
  return `${BOM}${lines.join(CRLF)}${CRLF}`
}

export function buildViewJson(
  request: Pick<ViewExportRequest, 'table' | 'title' | 'columns' | 'rows' | 'total' | 'filtered'>,
  meta: { exportedAt: string; exportedBy: string; vault: string },
): string {
  const rows = request.rows.map((row) => {
    const record: Record<string, unknown> = {}
    request.columns.forEach((column, index) => {
      const value = row[index]
      if (column.kind === 'money') {
        record[column.id] = isViewMoney(value) ? { amount: minorToFixed(value.money, value.currency), amountMinor: value.money, currency: value.currency } : null
      } else {
        record[column.id] = value ?? null
      }
    })
    return record
  })
  return `${JSON.stringify(
    {
      format: 'jaybi-view',
      version: 1,
      table: request.table,
      title: request.title,
      vault: meta.vault,
      exportedAt: meta.exportedAt,
      exportedBy: meta.exportedBy,
      filtered: request.filtered,
      totalRows: request.total,
      columns: request.columns.map(({ id, header, kind }) => ({ id, header, kind })),
      rows,
    },
    null,
    2,
  )}\n`
}

export async function exportView(vault: OpenVault, request: ViewExportRequest, context: ViewContext = {}): Promise<ExportResult> {
  assertViewExport(vault.user, request)
  const now = context.now ?? new Date()
  writeAudit(vault.db, vault.user.id, 'DATA_EXPORTED', 'vault', 'primary', {
    formats: [request.format],
    protection: 'none',
    scope: {
      view: request.table,
      columns: request.columns.map((column) => column.id),
      filtered: request.filtered,
      from: request.scope?.from ?? null,
      to: request.scope?.to ?? null,
      groupId: request.scope?.groupId ?? null,
    },
    includesAudit: request.table === 'audit',
    includesReceipts: false,
    counts: { rows: request.rows.length, total: request.total },
  })
  const name = (extension: string) => exportFileName(vault.vaultName, toIsoDate(now), `-${request.table}.${extension}`)
  switch (request.format) {
    case 'csv':
      return { blob: new Blob([buildViewCsv(request)], { type: MIME.csv }), fileName: name('csv'), mime: MIME.csv }
    case 'json': {
      const json = buildViewJson(request, { exportedAt: now.toISOString(), exportedBy: vault.user.email, vault: vault.vaultName })
      return { blob: new Blob([json], { type: MIME.json }), fileName: name('json'), mime: MIME.json }
    }
    case 'xlsx': {
      const { buildViewXlsx } = await import('./xlsx')
      return { blob: await buildViewXlsx(request), fileName: name('xlsx'), mime: MIME.xlsx }
    }
    case 'pdf': {
      const [{ buildViewPdf }, fonts] = await Promise.all([
        import('./pdf'),
        context.fonts ?? import('./pdf-fonts').then((module) => module.loadPdfFonts()),
      ])
      const blob = await buildViewPdf(request, { fonts, now, exportedBy: vault.user.email, vaultName: vault.vaultName })
      return { blob, fileName: name('pdf'), mime: MIME.pdf }
    }
  }
}
