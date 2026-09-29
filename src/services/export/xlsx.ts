import writeXlsxFile, { type Cell, type Row, type Sheet } from 'write-excel-file/universal'
import { loadExportMessages, translate, type Locale, type MessageKey } from '../../i18n'
import { minorUnitOf } from '../../lib/money'
import type { CategoryNames, ExportDataset } from './dataset'

const EXCEL_TEXT_LIMIT = 32_767
const DATE_FORMAT = 'yyyy-mm-dd'

export function sheetName(name: string, used: Set<string>): string {
  const base = name.replace(/[\\/?*[\]:]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || 'Sheet'
  let candidate = base
  for (let index = 2; used.has(candidate.toLowerCase()); index += 1) {
    const suffix = ` (${index})`
    candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`
  }
  used.add(candidate.toLowerCase())
  return candidate
}

export function excelDate(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

function textCell(value: string | null | undefined): Cell {
  if (value == null || value === '') return null
  return { value: value.length > EXCEL_TEXT_LIMIT ? value.slice(0, EXCEL_TEXT_LIMIT) : value, type: String }
}

function numberCell(value: number, format?: string): Cell {
  return format ? { value, type: Number, format } : { value, type: Number }
}

function moneyCell(minor: number | bigint, currency: string): Cell {
  const exponent = minorUnitOf(currency)
  const value = Number(minor) / 10 ** exponent
  return numberCell(value, exponent === 0 ? '#,##0' : `#,##0.${'0'.repeat(exponent)}`)
}

function header(labels: string[]): Row {
  return labels.map((label) => ({ value: label, type: String, fontWeight: 'bold' as const }))
}

function categoryName(names: CategoryNames, locale: Locale): string {
  return names[locale] || names.en
}

export async function buildXlsx(dataset: ExportDataset, locale: Locale, signal?: AbortSignal): Promise<Blob> {
  await loadExportMessages(locale)
  const t = (key: MessageKey) => translate(locale, key)
  const used = new Set<string>()
  const { meta, summary } = dataset
  const categories = new Map(dataset.categories.map((category) => [category.id, category]))
  const groups = new Map(dataset.groups.map((group) => [group.id, group.name]))
  const typeLabel = (type: string) => (type === 'INCOME' ? t('tx.income') : t('tx.expense'))

  const summaryRows: Row[] = [header([t('common.currency'), t('kpi.income'), t('kpi.expense'), t('kpi.net'), t('kpi.savings')])]
  for (const total of summary.totals) {
    const rate = total.incomeMinor > 0n ? Number(total.netMinor) / Number(total.incomeMinor) : 0
    summaryRows.push([
      textCell(total.currency),
      moneyCell(total.incomeMinor, total.currency),
      moneyCell(total.expenseMinor, total.currency),
      moneyCell(total.netMinor, total.currency),
      numberCell(rate, '0.0%'),
    ])
  }

  const recordRows: Row[] = [
    header([
      t('common.date'),
      t('common.type'),
      t('common.category'),
      t('common.amount'),
      t('common.currency'),
      'amount_minor',
      t('common.group'),
      t('common.email'),
      t('common.notes'),
      t('tx.receipt'),
      'id',
      'created_at',
      'updated_at',
    ]),
  ]
  for await (const page of dataset.transactionPages(signal)) {
    for (const row of page) {
      recordRows.push([
        { value: excelDate(row.date), type: Date, format: DATE_FORMAT },
        textCell(typeLabel(row.type)),
        textCell(categoryName(row.categoryNames, locale)),
        moneyCell(row.amountMinor, row.currency),
        textCell(row.currency),
        numberCell(row.amountMinor),
        textCell(row.groupName),
        textCell(row.userEmail),
        textCell(row.notes),
        { value: row.hasReceipt, type: Boolean },
        textCell(row.id),
        textCell(row.createdAt),
        textCell(row.updatedAt),
      ])
    }
  }

  const categoryRows: Row[] = [header(['id', t('common.type'), 'English', 'Oʻzbekcha', 'Ўзбекча', 'Русский', 'icon'])]
  for (const category of dataset.categories) {
    categoryRows.push([
      numberCell(category.id),
      textCell(typeLabel(category.type)),
      textCell(category.names.en),
      textCell(category.names['uz-Latn']),
      textCell(category.names['uz-Cyrl']),
      textCell(category.names.ru),
      textCell(category.icon),
    ])
  }

  const groupRows: Row[] = [header(['id', t('common.name'), 'created_at'])]
  for (const group of dataset.groups) groupRows.push([numberCell(group.id), textCell(group.name), textCell(group.createdAt)])

  const peopleRows: Row[] = [header(['id', t('common.email'), t('common.role'), t('common.group'), 'created_at'])]
  for (const person of dataset.users) {
    const role = person.role === 'Admin' || person.role === 'Manager' || person.role === 'Viewer' ? t(`roles.${person.role}`) : person.role
    peopleRows.push([
      textCell(person.id),
      textCell(person.email),
      textCell(role),
      textCell(person.groupId == null ? null : (groups.get(person.groupId) ?? String(person.groupId))),
      textCell(person.createdAt),
    ])
  }

  const categoryTotals: Row[] = summary.byCategory.length
    ? [[null], header([t('chart.byCategory'), t('common.currency'), t('kpi.expense')])]
    : []
  for (const item of summary.byCategory) {
    const category = categories.get(item.categoryId)
    categoryTotals.push([
      textCell(category ? categoryName(category.names, locale) : String(item.categoryId)),
      textCell(item.currency),
      moneyCell(item.expenseMinor, item.currency),
    ])
  }

  const aboutRows: Row[] = [
    header(['key', 'value']),
    ...(
      [
        ['format', meta.format],
        ['formatVersion', String(meta.formatVersion)],
        ['appVersion', meta.app.version],
        ['appCommit', meta.app.commit],
        ['schemaVersion', String(meta.schemaVersion)],
        ['exportedAt', meta.exportedAt],
        ['exportedBy', meta.exportedBy.email],
        ['vaultName', meta.vault.name],
        ['vaultCurrency', meta.vault.currency],
        ['from', meta.scope.from ?? ''],
        ['to', meta.scope.to ?? ''],
        ['group', meta.scope.groupName ?? ''],
        ['includesAudit', String(meta.scope.includesAudit)],
        ['transactions', String(dataset.counts.transactions)],
      ] as const
    ).map(([key, value]) => [textCell(key), textCell(value)]),
  ]

  const sheets: Sheet<Blob>[] = [
    { sheet: sheetName(t('export.sheet.summary'), used), data: [...summaryRows, ...categoryTotals], columns: [{ width: 28 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 12 }], stickyRowsCount: 1 },
    {
      sheet: sheetName(t('export.sheet.records'), used),
      data: recordRows,
      columns: [12, 10, 22, 16, 8, 16, 18, 26, 40, 8, 38, 26, 26].map((width) => ({ width })),
      stickyRowsCount: 1,
    },
    { sheet: sheetName(t('export.sheet.categories'), used), data: categoryRows, columns: [6, 10, 22, 22, 22, 22, 14].map((width) => ({ width })), stickyRowsCount: 1 },
    { sheet: sheetName(t('export.sheet.groups'), used), data: groupRows, columns: [6, 28, 26].map((width) => ({ width })), stickyRowsCount: 1 },
    { sheet: sheetName(t('export.sheet.people'), used), data: peopleRows, columns: [38, 30, 12, 24, 26].map((width) => ({ width })), stickyRowsCount: 1 },
  ]

  if (meta.scope.includesAudit) {
    const auditRows: Row[] = [header(['seq', t('audit.when'), t('audit.actor'), t('audit.action'), 'entity_type', 'entity_id', 'details', 'prev_hash', 'hash'])]
    for await (const page of dataset.auditPages(signal)) {
      for (const row of page) {
        auditRows.push([
          numberCell(row.seq),
          textCell(row.createdAt),
          textCell(row.actorEmail ?? row.actorId),
          textCell(row.action),
          textCell(row.entityType),
          textCell(row.entityId),
          textCell(row.details),
          textCell(row.prevHash),
          textCell(row.hash),
        ])
      }
    }
    sheets.push({ sheet: sheetName(t('export.sheet.audit'), used), data: auditRows, columns: [8, 26, 28, 24, 14, 38, 60, 20, 20].map((width) => ({ width })), stickyRowsCount: 1 })
  }

  sheets.push({ sheet: sheetName(t('export.sheet.about'), used), data: aboutRows, columns: [{ width: 18 }, { width: 48 }], stickyRowsCount: 1 })

  const blob = await writeXlsxFile(sheets, { fontFamily: 'Calibri', fontSize: 11 }).toBlob()
  return new Blob([blob], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}
