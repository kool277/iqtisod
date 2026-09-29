import type { CurrencyTotals, ExportAuditRow, ExportDataset, ExportRow } from './dataset'

export function transactionRecord(row: ExportRow) {
  return {
    id: row.id,
    date: row.date,
    type: row.type,
    amountMinor: row.amountMinor,
    amount: row.amount,
    currency: row.currency,
    categoryId: row.categoryId,
    groupId: row.groupId,
    userId: row.userId,
    notes: row.notes,
    hasReceipt: row.hasReceipt,
    receipt: row.receipt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function auditRecord(row: ExportAuditRow) {
  return {
    seq: row.seq,
    id: row.id,
    actorId: row.actorId,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    details: row.details,
    createdAt: row.createdAt,
    prevHash: row.prevHash,
    hash: row.hash,
  }
}

export function totalsJson(totals: CurrencyTotals): string {
  return `{"currency":${JSON.stringify(totals.currency)},"incomeMinor":${totals.incomeMinor},"expenseMinor":${totals.expenseMinor},"netMinor":${totals.netMinor}}`
}

function indented(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/\n/g, '\n  ')
}

async function pushRecords<T>(
  parts: string[],
  key: string,
  pages: AsyncIterable<T[]>,
  serialize: (item: T) => unknown,
  last = false,
): Promise<void> {
  parts.push(`  ${JSON.stringify(key)}: [`)
  let first = true
  for await (const page of pages) {
    if (page.length === 0) continue
    parts.push(`${first ? '\n' : ',\n'}${page.map((item) => `    ${JSON.stringify(serialize(item))}`).join(',\n')}`)
    first = false
  }
  parts.push(`${first ? '' : '\n  '}]${last ? '\n' : ',\n'}`)
}

async function* once<T>(items: T[]): AsyncGenerator<T[]> {
  yield items
}

export async function buildJson(dataset: ExportDataset, signal?: AbortSignal): Promise<Blob> {
  const { meta } = dataset
  const parts: string[] = ['{\n']
  for (const [key, value] of Object.entries(meta)) parts.push(`  ${JSON.stringify(key)}: ${indented(value)},\n`)
  await pushRecords(parts, 'currencies', once(dataset.currencies), (item) => item)
  await pushRecords(parts, 'groups', once(dataset.groups), (item) => item)
  await pushRecords(parts, 'users', once(dataset.users), (item) => item)
  await pushRecords(parts, 'categories', once(dataset.categories), (item) => item)
  await pushRecords(parts, 'transactions', dataset.transactionPages(signal), transactionRecord)
  parts.push(`  "totals": [${dataset.summary.totals.map((item) => `\n    ${totalsJson(item)}`).join(',')}${dataset.summary.totals.length ? '\n  ' : ''}],\n`)
  await pushRecords(parts, 'auditLog', dataset.auditPages(signal), auditRecord, true)
  parts.push('}\n')
  return new Blob(parts, { type: 'application/json' })
}

export async function buildJsonl(dataset: ExportDataset, signal?: AbortSignal): Promise<Blob> {
  const header = JSON.stringify({ type: 'header', ...dataset.meta })
  const totals = `[${dataset.summary.totals.map(totalsJson).join(',')}]`
  const parts: string[] = [`${header.slice(0, -1)},"totals":${totals}}\n`]
  const counts = { currency: 0, group: 0, user: 0, category: 0, transaction: 0, audit: 0 }
  const push = (type: keyof typeof counts, record: object) => {
    counts[type] += 1
    return JSON.stringify({ type, data: record })
  }
  const block = (lines: string[]) => {
    if (lines.length) parts.push(`${lines.join('\n')}\n`)
  }
  block(dataset.currencies.map((item) => push('currency', item)))
  block(dataset.groups.map((item) => push('group', item)))
  block(dataset.users.map((item) => push('user', item)))
  block(dataset.categories.map((item) => push('category', item)))
  for await (const page of dataset.transactionPages(signal)) block(page.map((row) => push('transaction', transactionRecord(row))))
  for await (const page of dataset.auditPages(signal)) block(page.map((row) => push('audit', auditRecord(row))))
  parts.push(`${JSON.stringify({ type: 'footer', counts })}\n`)
  return new Blob(parts, { type: 'application/jsonl' })
}
