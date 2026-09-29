import { SqlDatabase, type SqlValue } from '../db/sqlite'
import { ForbiddenError } from '../domain/errors'
import type { OpenVault } from '../domain/types'
import { minorToFixed, minorUnitOf } from '../lib/money'
import { Permission, canUser } from '../rbac'
import { writeAudit } from './audit.service'

const CSV_COLUMNS = [
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
] as const

function assertExport(vault: OpenVault): void {
  if (!canUser(vault.user, Permission.EXPORT_VAULT)) throw new ForbiddenError()
}

export function csvCell(value: SqlValue | boolean): string {
  if (value == null) return ''
  let text = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value)
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text
}

export function exportTransactionsCsv(vault: OpenVault): string {
  assertExport(vault)
  const rows = vault.db.query(
    `SELECT t.id, t.transaction_date, t.type, c.name_en AS category, t.amount_minor, t.currency,
            g.name AS group_name, u.email AS recorded_by, t.notes, t.receipt_data IS NOT NULL AS has_receipt,
            t.created_at, t.updated_at
     FROM transactions t
     JOIN categories c ON c.id = t.category_id
     JOIN groups g ON g.id = t.group_id
     JOIN users u ON u.id = t.user_id
     ORDER BY t.transaction_date, t.created_at, t.id`,
  )
  const lines = [CSV_COLUMNS.join(',')]
  for (const row of rows) {
    const minor = Number(row.amount_minor)
    const currency = String(row.currency)
    lines.push(
      [
        csvCell(row.id),
        csvCell(row.transaction_date),
        csvCell(row.type),
        csvCell(row.category),
        minorToFixed(minor, currency),
        csvCell(currency),
        String(minor),
        String(minorUnitOf(currency)),
        csvCell(row.group_name),
        csvCell(row.recorded_by),
        csvCell(row.notes),
        csvCell(Number(row.has_receipt) === 1),
        csvCell(row.created_at),
        csvCell(row.updated_at),
      ].join(','),
    )
  }
  writeAudit(vault.db, vault.user.id, 'PLAINTEXT_EXPORTED', 'vault', 'primary', { format: 'csv', rows: rows.length })
  return `\ufeff${lines.join('\r\n')}\r\n`
}

export async function exportPlainDatabase(vault: OpenVault): Promise<Uint8Array> {
  assertExport(vault)
  writeAudit(vault.db, vault.user.id, 'PLAINTEXT_EXPORTED', 'vault', 'primary', { format: 'sqlite' })
  const copy = await SqlDatabase.openBytes(vault.db.export())
  try {
    copy.exec("UPDATE users SET password_hash = '', salt = ''")
    copy.exec('VACUUM')
    return copy.export()
  } finally {
    copy.close()
  }
}
