import type { SqlValue } from '../../db/sqlite'
import { minorUnitOf } from '../../lib/money'
import type { ExportDataset } from './dataset'

export const CSV_COLUMNS = [
  'id',
  'date',
  'type',
  'category',
  'amount',
  'currency',
  'amount_minor',
  'minor_unit',
  'group',
  'recorded_by',
  'notes',
  'has_receipt',
  'created_at',
  'updated_at',
  'category_id',
  'group_id',
  'user_id',
] as const

export const AUDIT_CSV_COLUMNS = [
  'seq',
  'id',
  'actor_id',
  'actor_email',
  'action',
  'entity_type',
  'entity_id',
  'details',
  'created_at',
  'prev_hash',
  'hash',
] as const

const FORMULA_START = /^\s*[=+\-@\t\r\n\uFF1D\uFF0B\uFF0D\uFF20]/

export function csvCell(value: SqlValue | boolean): string {
  if (value == null) return ''
  let text = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value)
  if (typeof value === 'string' && FORMULA_START.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text
}

const BOM = '\ufeff'
const CRLF = '\r\n'

export async function buildTransactionsCsv(dataset: ExportDataset, signal?: AbortSignal): Promise<Blob> {
  const parts: string[] = [`${BOM}${CSV_COLUMNS.join(',')}${CRLF}`]
  for await (const page of dataset.transactionPages(signal)) {
    const lines = page.map((row) =>
      [
        csvCell(row.id),
        csvCell(row.date),
        csvCell(row.type),
        csvCell(row.categoryNames.en),
        row.amount,
        csvCell(row.currency),
        String(row.amountMinor),
        String(minorUnitOf(row.currency)),
        csvCell(row.groupName),
        csvCell(row.userEmail),
        csvCell(row.notes),
        csvCell(row.hasReceipt),
        csvCell(row.createdAt),
        csvCell(row.updatedAt),
        String(row.categoryId),
        String(row.groupId),
        csvCell(row.userId),
      ].join(','),
    )
    parts.push(lines.join(CRLF) + CRLF)
  }
  return new Blob(parts, { type: 'text/csv;charset=utf-8' })
}

export async function buildAuditCsv(dataset: ExportDataset, signal?: AbortSignal): Promise<Blob> {
  const parts: string[] = [`${BOM}${AUDIT_CSV_COLUMNS.join(',')}${CRLF}`]
  for await (const page of dataset.auditPages(signal)) {
    const lines = page.map((row) =>
      [
        String(row.seq),
        csvCell(row.id),
        csvCell(row.actorId),
        csvCell(row.actorEmail),
        csvCell(row.action),
        csvCell(row.entityType),
        csvCell(row.entityId),
        csvCell(row.details),
        csvCell(row.createdAt),
        csvCell(row.prevHash),
        csvCell(row.hash),
      ].join(','),
    )
    parts.push(lines.join(CRLF) + CRLF)
  }
  return new Blob(parts, { type: 'text/csv;charset=utf-8' })
}
