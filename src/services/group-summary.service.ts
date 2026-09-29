import { ForbiddenError } from '../domain/errors'
import { summarizeGroups, type GroupSummaryReport } from '../domain/group-summary'
import type { DateRange, OpenVault } from '../domain/types'
import { Permission, canUser } from '../rbac'
import { scope } from './finance.service'
import { listGroups } from './group.service'

/** Income, expenses and net per group and currency over `range` (both ends inclusive, like the dashboard). */
export function loadGroupSummaries(vault: OpenVault, range: DateRange): GroupSummaryReport {
  if (!canUser(vault.user, Permission.READ_DASHBOARD)) throw new ForbiddenError()
  const group = scope(vault.user)
  // SUM goes through TEXT so totals above 2^53 stay exact instead of being rounded to a JS number.
  const rows = vault.db.query(
    `SELECT t.group_id AS group_id, t.currency AS currency, t.type AS type,
       CAST(SUM(t.amount_minor) AS TEXT) AS total, COUNT(*) AS count, MAX(t.transaction_date) AS last_date
     FROM transactions t
     WHERE t.transaction_date >= ? AND t.transaction_date <= ?
       AND ${group.sql}
     GROUP BY t.group_id, t.currency, t.type`,
    [range.start, range.end, ...group.params],
  )
  return summarizeGroups(
    listGroups(vault),
    rows.map((row) => ({
      groupId: Number(row.group_id),
      currency: String(row.currency),
      type: row.type === 'INCOME' ? 'INCOME' : 'EXPENSE',
      totalMinor: BigInt(String(row.total)),
      count: Number(row.count),
      lastDate: String(row.last_date),
    })),
    vault.currency,
  )
}
