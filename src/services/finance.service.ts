import type { SqlValue } from '../db/sqlite'
import { ForbiddenError, ValidationError } from '../domain/errors'
import type {
  Category,
  DashboardData,
  DateRange,
  EntryType,
  LedgerEntry,
  OpenVault,
  SessionUser,
  TransactionInput,
} from '../domain/types'
import { eachMonth, isIsoDate } from '../lib/dates'
import { LIMITS } from '../lib/limits'
import { parseAmount, percentOf } from '../lib/money'
import { assertReceipt } from '../lib/receipt'
import { Permission, canUser } from '../rbac'
import { isCurrency } from '../domain/types'
import { writeAudit } from './audit.service'

export const MAX_RECEIPT_BYTES = LIMITS.receiptBytes

type LocaleName = 'en' | 'uz-Latn' | 'uz-Cyrl' | 'ru'

function scope(user: SessionUser): { sql: string; params: SqlValue[] } {
  if (user.roleName === 'Admin') return { sql: '1 = 1', params: [] }
  if (user.groupId == null) return { sql: '1 = 0', params: [] }
  return { sql: 't.group_id = ?', params: [user.groupId] }
}

function assertRead(user: SessionUser): void {
  if (!canUser(user, Permission.READ_TRANSACTIONS) && !canUser(user, Permission.READ_DASHBOARD)) {
    throw new ForbiddenError()
  }
}

function mapCategory(row: Record<string, SqlValue>): Category {
  return {
    id: Number(row.id),
    type: row.type === 'INCOME' ? 'INCOME' : 'EXPENSE',
    icon: row.icon == null ? null : String(row.icon),
    nameEn: String(row.name_en),
    nameUzLatn: String(row.name_uz_latn),
    nameUzCyrl: String(row.name_uz_cyrl),
    nameRu: String(row.name_ru),
  }
}

function mapEntry(row: Record<string, SqlValue>): LedgerEntry {
  return {
    id: String(row.id),
    type: row.type === 'INCOME' ? 'INCOME' : 'EXPENSE',
    amountMinor: Number(row.amount_minor),
    currency: String(row.currency),
    categoryId: Number(row.category_id),
    userId: String(row.user_id),
    userEmail: String(row.user_email),
    groupId: Number(row.group_id),
    groupName: String(row.group_name),
    date: String(row.transaction_date),
    notes: row.notes == null ? null : String(row.notes),
    receiptData: row.receipt_data == null ? null : String(row.receipt_data),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    nameEn: String(row.name_en),
    nameUzLatn: String(row.name_uz_latn),
    nameUzCyrl: String(row.name_uz_cyrl),
    nameRu: String(row.name_ru),
  }
}

export function categoryLabel(
  category: Pick<Category, 'nameEn' | 'nameUzLatn' | 'nameUzCyrl' | 'nameRu'>,
  locale: LocaleName,
): string {
  if (locale === 'uz-Latn') return category.nameUzLatn
  if (locale === 'uz-Cyrl') return category.nameUzCyrl
  if (locale === 'ru') return category.nameRu
  return category.nameEn
}

export function listCategories(vault: OpenVault): Category[] {
  assertRead(vault.user)
  return vault.db
    .query(
      `SELECT id, name_en, name_uz_latn, name_uz_cyrl, name_ru, type, icon
       FROM categories
       ORDER BY type, id`,
    )
    .map(mapCategory)
}

function assertEntryAccess(user: SessionUser, groupId: number): void {
  if (user.roleName === 'Admin') return
  if (user.groupId !== groupId) throw new ForbiddenError()
}

type ValidEntry = Omit<TransactionInput, 'amount'> & { amountMinor: number; receiptData: string | null }

function validateInput(vault: OpenVault, input: TransactionInput, previousReceipt: string | null = null): ValidEntry {
  if (input.type !== 'INCOME' && input.type !== 'EXPENSE') throw new ValidationError('TYPE')
  if (!isCurrency(input.currency)) throw new ValidationError('CURRENCY')
  const amountMinor = parseAmount(String(input.amount), input.currency)
  if (!isIsoDate(input.date)) throw new ValidationError('DATE')
  const category = vault.db.queryOne('SELECT id, type FROM categories WHERE id = ?', [input.categoryId])
  if (!category || category.type !== input.type) throw new ValidationError('CATEGORY')
  const group = vault.db.queryValue('SELECT id FROM groups WHERE id = ?', [input.groupId])
  if (group == null) throw new ValidationError('GROUP')
  assertEntryAccess(vault.user, input.groupId)
  const notes = input.notes.trim()
  if (notes.length > LIMITS.notesChars) throw new ValidationError('NOTES')
  const receiptData = input.receiptData || null
  // An unchanged receipt was accepted by an earlier version; only new bytes are checked.
  if (receiptData && receiptData !== previousReceipt) {
    assertReceipt(receiptData)
    if (vault.db.sizeBytes() + receiptData.length > LIMITS.databaseBudgetBytes) throw new ValidationError('VAULT_FULL')
  }
  return {
    type: input.type,
    currency: input.currency,
    categoryId: input.categoryId,
    groupId: input.groupId,
    date: input.date,
    amountMinor,
    notes,
    receiptData,
  }
}

function snapshot(entry: {
  type: unknown
  amountMinor: unknown
  currency: unknown
  date: unknown
  categoryId: unknown
  groupId: unknown
  notes: unknown
}) {
  return {
    type: entry.type,
    amountMinor: Number(entry.amountMinor),
    currency: entry.currency,
    date: entry.date,
    categoryId: Number(entry.categoryId),
    groupId: Number(entry.groupId),
    notes: entry.notes ?? null,
  }
}

const SNAPSHOT_SELECT = `SELECT type, amount_minor, currency, transaction_date, category_id, group_id, notes, user_id
  FROM transactions WHERE id = ?`

function snapshotRow(row: Record<string, SqlValue>) {
  return snapshot({
    type: row.type,
    amountMinor: row.amount_minor,
    currency: row.currency,
    date: row.transaction_date,
    categoryId: row.category_id,
    groupId: row.group_id,
    notes: row.notes,
  })
}

const ENTRY_SELECT = `SELECT
  t.id, t.type, t.amount_minor, t.currency, t.category_id, t.user_id, t.group_id,
  t.transaction_date, t.notes, t.receipt_data, t.created_at, t.updated_at,
  c.name_en, c.name_uz_latn, c.name_uz_cyrl, c.name_ru,
  u.email AS user_email, g.name AS group_name
 FROM transactions t
 JOIN categories c ON c.id = t.category_id
 JOIN users u ON u.id = t.user_id
 JOIN groups g ON g.id = t.group_id`

export function listTransactions(
  vault: OpenVault,
  range: DateRange,
  type: EntryType | 'ALL' = 'ALL',
): LedgerEntry[] {
  if (!canUser(vault.user, Permission.READ_TRANSACTIONS)) throw new ForbiddenError()
  const group = scope(vault.user)
  const rows = vault.db.query(
    `${ENTRY_SELECT}
     WHERE t.transaction_date >= ? AND t.transaction_date <= ?
       AND ${group.sql}
       AND (? = 'ALL' OR t.type = ?)
     ORDER BY t.transaction_date DESC, t.created_at DESC`,
    [range.start, range.end, ...group.params, type, type],
  )
  return rows.map(mapEntry)
}

export function createTransaction(vault: OpenVault, input: TransactionInput): string {
  if (!canUser(vault.user, Permission.CREATE_TRANSACTION)) throw new ForbiddenError()
  const entry = validateInput(vault, input)
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  vault.db.withTransaction(() => {
    vault.db.exec(
      `INSERT INTO transactions (
         id, type, amount_minor, currency, category_id, user_id, group_id, transaction_date, notes, receipt_data, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        entry.type,
        entry.amountMinor,
        entry.currency,
        entry.categoryId,
        vault.user.id,
        entry.groupId,
        entry.date,
        entry.notes || null,
        entry.receiptData,
        now,
        now,
      ],
    )
    writeAudit(vault.db, vault.user.id, 'TRANSACTION_CREATED', 'transaction', id, snapshot(entry))
  })
  return id
}

export function updateTransaction(vault: OpenVault, id: string, input: TransactionInput): void {
  if (!canUser(vault.user, Permission.UPDATE_TRANSACTION)) throw new ForbiddenError()
  const existing = vault.db.queryOne(SNAPSHOT_SELECT, [id])
  if (!existing) throw new ValidationError('REQUIRED')
  assertEntryAccess(vault.user, Number(existing.group_id))
  const previousReceipt = vault.db.queryValue('SELECT receipt_data FROM transactions WHERE id = ?', [id])
  const entry = validateInput(vault, input, previousReceipt == null ? null : String(previousReceipt))
  vault.db.withTransaction(() => {
    vault.db.exec(
      `UPDATE transactions
       SET type = ?, amount_minor = ?, currency = ?, category_id = ?, group_id = ?, transaction_date = ?,
           notes = ?, receipt_data = ?, updated_at = ?
       WHERE id = ?`,
      [
        entry.type,
        entry.amountMinor,
        entry.currency,
        entry.categoryId,
        entry.groupId,
        entry.date,
        entry.notes || null,
        entry.receiptData,
        new Date().toISOString(),
        id,
      ],
    )
    writeAudit(vault.db, vault.user.id, 'TRANSACTION_UPDATED', 'transaction', id, {
      before: snapshotRow(existing),
      after: snapshot(entry),
    })
  })
}

export function deleteTransaction(vault: OpenVault, id: string): void {
  if (!canUser(vault.user, Permission.DELETE_TRANSACTION)) throw new ForbiddenError()
  const existing = vault.db.queryOne(SNAPSHOT_SELECT, [id])
  if (!existing) throw new ValidationError('REQUIRED')
  assertEntryAccess(vault.user, Number(existing.group_id))
  vault.db.withTransaction(() => {
    writeAudit(vault.db, vault.user.id, 'TRANSACTION_DELETED', 'transaction', id, {
      ...snapshotRow(existing),
      userId: existing.user_id,
    })
    vault.db.exec('DELETE FROM transactions WHERE id = ?', [id])
  })
}

/** Narrows the role scope to one group; a group outside the reader's own scope is refused, never silently widened. */
export function dashboardScope(user: SessionUser, groupId: number | null): { sql: string; params: SqlValue[] } {
  const base = scope(user)
  if (groupId == null) return base
  if (!Number.isSafeInteger(groupId) || groupId <= 0) throw new ValidationError('GROUP')
  assertEntryAccess(user, groupId)
  return { sql: `(${base.sql}) AND t.group_id = ?`, params: [...base.params, groupId] }
}

export function loadDashboard(vault: OpenVault, range: DateRange, locale: LocaleName, groupId: number | null = null): DashboardData {
  if (!canUser(vault.user, Permission.READ_DASHBOARD)) throw new ForbiddenError()
  const group = dashboardScope(vault.user, groupId)
  const currency = vault.currency
  const totals = vault.db.queryOne(
    `SELECT
       COALESCE(SUM(CASE WHEN t.type = 'INCOME' THEN t.amount_minor END), 0) AS income,
       COALESCE(SUM(CASE WHEN t.type = 'EXPENSE' THEN t.amount_minor END), 0) AS expense
     FROM transactions t
     WHERE t.transaction_date >= ? AND t.transaction_date <= ?
       AND t.currency = ?
       AND ${group.sql}`,
    [range.start, range.end, currency, ...group.params],
  )
  const income = Number(totals?.income ?? 0)
  const expense = Number(totals?.expense ?? 0)
  const monthly = vault.db.query(
    `SELECT substr(t.transaction_date, 1, 7) AS month, t.type AS type, SUM(t.amount_minor) AS total
     FROM transactions t
     WHERE t.transaction_date >= ? AND t.transaction_date <= ?
       AND t.currency = ?
       AND ${group.sql}
     GROUP BY month, t.type
     ORDER BY month`,
    [range.start, range.end, currency, ...group.params],
  )
  const months = eachMonth(range.start, range.end)
  const incomeByMonth = months.map((month) => {
    const row = monthly.find((item) => item.month === month && item.type === 'INCOME')
    return Number(row?.total ?? 0)
  })
  const expenseByMonth = months.map((month) => {
    const row = monthly.find((item) => item.month === month && item.type === 'EXPENSE')
    return Number(row?.total ?? 0)
  })
  const nameColumn =
    locale === 'uz-Latn' ? 'c.name_uz_latn' : locale === 'uz-Cyrl' ? 'c.name_uz_cyrl' : locale === 'ru' ? 'c.name_ru' : 'c.name_en'
  const categories = vault.db
    .query(
      `SELECT ${nameColumn} AS label, SUM(t.amount_minor) AS total
       FROM transactions t
       JOIN categories c ON c.id = t.category_id
       WHERE t.type = 'EXPENSE'
         AND t.transaction_date >= ? AND t.transaction_date <= ?
         AND t.currency = ?
         AND ${group.sql}
       GROUP BY c.id
       ORDER BY total DESC`,
      [range.start, range.end, currency, ...group.params],
    )
    .map((row) => ({ label: String(row.label), total: Number(row.total) }))
  const trend = vault.db
    .query(
      `SELECT t.transaction_date AS date, SUM(t.amount_minor) AS total
       FROM transactions t
       WHERE t.type = 'EXPENSE'
         AND t.transaction_date >= ? AND t.transaction_date <= ?
         AND t.currency = ?
         AND ${group.sql}
       GROUP BY t.transaction_date
       ORDER BY t.transaction_date`,
      [range.start, range.end, currency, ...group.params],
    )
    .map((row) => ({ date: String(row.date), total: Number(row.total) }))
  const breakdownMode = vault.user.roleName === 'Admin' && groupId == null ? 'group' : 'user'
  const breakdown =
    breakdownMode === 'group'
      ? vault.db.query(
          `SELECT g.name AS label, SUM(t.amount_minor) AS total
           FROM transactions t
           JOIN groups g ON g.id = t.group_id
           WHERE t.type = 'EXPENSE'
             AND t.transaction_date >= ? AND t.transaction_date <= ?
             AND t.currency = ?
             AND ${group.sql}
           GROUP BY g.id
           ORDER BY total DESC`,
          [range.start, range.end, currency, ...group.params],
        )
      : vault.db.query(
          `SELECT u.email AS label, SUM(t.amount_minor) AS total
           FROM transactions t
           JOIN users u ON u.id = t.user_id
           WHERE t.type = 'EXPENSE'
             AND t.transaction_date >= ? AND t.transaction_date <= ?
             AND t.currency = ?
             AND ${group.sql}
           GROUP BY u.id
           ORDER BY total DESC`,
          [range.start, range.end, currency, ...group.params],
        )
  const otherCurrencies = vault.db
    .query(
      `SELECT t.currency AS currency,
         COALESCE(SUM(CASE WHEN t.type = 'INCOME' THEN t.amount_minor END), 0) AS income,
         COALESCE(SUM(CASE WHEN t.type = 'EXPENSE' THEN t.amount_minor END), 0) AS expense
       FROM transactions t
       WHERE t.transaction_date >= ? AND t.transaction_date <= ?
         AND t.currency <> ?
         AND ${group.sql}
       GROUP BY t.currency
       ORDER BY t.currency`,
      [range.start, range.end, currency, ...group.params],
    )
    .map((row) => ({ currency: String(row.currency), income: Number(row.income), expense: Number(row.expense) }))
  return {
    income,
    expense,
    net: income - expense,
    savingsRate: income > 0 ? percentOf(income - expense, income, 1) : 0,
    months,
    incomeByMonth,
    expenseByMonth,
    categories,
    trend,
    breakdown: breakdown.map((row) => ({ label: String(row.label), total: Number(row.total) })),
    breakdownMode,
    otherCurrencies,
  }
}
