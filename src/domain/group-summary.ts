import type { EntryType } from './types'

/** One `GROUP BY group_id, currency, type` aggregate row. */
export type SummaryRow = {
  groupId: number
  currency: string
  type: EntryType
  totalMinor: bigint
  count: number
  lastDate: string
}

export type CurrencySummary = {
  currency: string
  incomeMinor: bigint
  expenseMinor: bigint
  netMinor: bigint
  count: number
  lastDate: string | null
}

export type SummaryTotals = {
  /** Vault currency first, then the rest alphabetically. Amounts in different currencies are never added together. */
  currencies: CurrencySummary[]
  count: number
  lastDate: string | null
}

export type GroupSummary = SummaryTotals & { groupId: number; name: string }

export type GroupSummaryReport = { groups: GroupSummary[]; total: SummaryTotals }

type Accumulator = Map<string, CurrencySummary>

function later(a: string | null, b: string | null): string | null {
  if (a == null) return b
  if (b == null) return a
  return a > b ? a : b
}

function add(target: Accumulator, row: SummaryRow): void {
  const current = target.get(row.currency) ?? {
    currency: row.currency,
    incomeMinor: 0n,
    expenseMinor: 0n,
    netMinor: 0n,
    count: 0,
    lastDate: null,
  }
  const incomeMinor = current.incomeMinor + (row.type === 'INCOME' ? row.totalMinor : 0n)
  const expenseMinor = current.expenseMinor + (row.type === 'EXPENSE' ? row.totalMinor : 0n)
  target.set(row.currency, {
    currency: row.currency,
    incomeMinor,
    expenseMinor,
    netMinor: incomeMinor - expenseMinor,
    count: current.count + row.count,
    lastDate: later(current.lastDate, row.lastDate),
  })
}

function totalsOf(target: Accumulator, baseCurrency: string): SummaryTotals {
  const currencies = [...target.values()].sort((a, b) => {
    if (a.currency === b.currency) return 0
    if (a.currency === baseCurrency) return -1
    if (b.currency === baseCurrency) return 1
    return a.currency < b.currency ? -1 : 1
  })
  return {
    currencies,
    count: currencies.reduce((sum, item) => sum + item.count, 0),
    lastDate: currencies.reduce<string | null>((latest, item) => later(latest, item.lastDate), null),
  }
}

/**
 * Folds aggregate rows into per-group and overall totals. Only `groups` are reported; rows for any other group
 * are dropped so the overall total never includes a group the caller was not shown.
 */
export function summarizeGroups(
  groups: readonly { id: number; name: string }[],
  rows: readonly SummaryRow[],
  baseCurrency: string,
): GroupSummaryReport {
  const perGroup = new Map<number, Accumulator>(groups.map((group) => [group.id, new Map()]))
  const overall: Accumulator = new Map()
  for (const row of rows) {
    const target = perGroup.get(row.groupId)
    if (!target) continue
    add(target, row)
    add(overall, row)
  }
  return {
    groups: groups.map((group) => ({ groupId: group.id, name: group.name, ...totalsOf(perGroup.get(group.id)!, baseCurrency) })),
    total: totalsOf(overall, baseCurrency),
  }
}
