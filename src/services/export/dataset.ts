import { readSchemaVersion } from '../../db/migrations'
import { getSetting } from '../../db/settings'
import type { SqlDatabase, SqlValue } from '../../db/sqlite'
import { EXPORT_FORMAT_VERSION } from '../../db/versions'
import { ForbiddenError, ValidationError } from '../../domain/errors'
import type { SessionUser } from '../../domain/types'
import { minorToFixed } from '../../lib/money'
import { BUILD } from '../../lib/version'
import { Permission, canUser, seesAllGroups } from '../../rbac'

export const PAGE_SIZE = 1000

export type ExportScope = {
  from: string | null
  to: string | null
  groupId: number | null
  groupName: string | null
  includesAudit: boolean
  includesReceipts: boolean
}

export type ScopeRequest = {
  period: { from: string; to: string } | null
  groupId: number | null
  includeAudit: boolean
  includeReceipts: boolean
}

export type ExportMeta = {
  format: 'moliya-export'
  formatVersion: number
  app: { name: string; version: string; commit: string }
  schemaVersion: number
  exportedAt: string
  exportedBy: { id: string; email: string }
  vault: { name: string; currency: string; createdAt: string | null }
  scope: ExportScope & { auditFirstSeq: number | null; auditLastSeq: number | null }
}

export type CategoryNames = { en: string; 'uz-Latn': string; 'uz-Cyrl': string; ru: string }

export type ExportCurrency = { code: string; minorUnit: number }
export type ExportGroup = { id: number; name: string; createdAt: string | null }
export type ExportUser = { id: string; email: string; role: string; groupId: number | null; createdAt: string | null }
export type ExportCategory = { id: number; type: 'INCOME' | 'EXPENSE'; icon: string | null; names: CategoryNames }

export type ExportTransaction = {
  id: string
  date: string
  type: 'INCOME' | 'EXPENSE'
  amountMinor: number
  amount: string
  currency: string
  categoryId: number
  groupId: number
  userId: string
  notes: string | null
  hasReceipt: boolean
  receipt: string | null
  createdAt: string
  updatedAt: string
}

export type ExportRow = ExportTransaction & { categoryNames: CategoryNames; groupName: string; userEmail: string }

export type ExportAuditEntry = {
  seq: number
  id: string
  actorId: string | null
  action: string
  entityType: string | null
  entityId: string | null
  details: string | null
  createdAt: string
  prevHash: string
  hash: string
}

export type ExportAuditRow = ExportAuditEntry & { actorEmail: string | null }

export type CurrencyTotals = { currency: string; incomeMinor: bigint; expenseMinor: bigint; netMinor: bigint }

export type ExportSummary = {
  totals: CurrencyTotals[]
  byCategory: { categoryId: number; currency: string; expenseMinor: bigint }[]
  byMonth: { month: string; currency: string; incomeMinor: bigint; expenseMinor: bigint }[]
}

export type ExportCounts = {
  currencies: number
  groups: number
  users: number
  categories: number
  transactions: number
  audit: number
}

export type ExportDataset = {
  db: SqlDatabase
  meta: ExportMeta
  counts: ExportCounts
  currencies: ExportCurrency[]
  groups: ExportGroup[]
  users: ExportUser[]
  categories: ExportCategory[]
  summary: ExportSummary
  transactionPages: (signal?: AbortSignal, limit?: number) => AsyncGenerator<ExportRow[]>
  auditPages: (signal?: AbortSignal) => AsyncGenerator<ExportAuditRow[]>
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ValidationError('EXPORT_CANCELLED')
}

export function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

export function resolveExportScope(user: SessionUser, request: ScopeRequest, db: SqlDatabase): ExportScope {
  if (!canUser(user, Permission.EXPORT_VAULT)) throw new ForbiddenError()
  let groupId = request.groupId
  if (!seesAllGroups(user)) {
    if (user.groupId == null) throw new ForbiddenError()
    groupId = user.groupId
  }
  let groupName: string | null = null
  if (groupId != null) {
    const name = db.queryValue('SELECT name FROM groups WHERE id = ?', [groupId])
    if (name == null) throw new ValidationError('GROUP')
    groupName = String(name)
  }
  if (request.includeAudit) {
    if (!canUser(user, Permission.READ_AUDIT)) throw new ForbiddenError()
    if (groupId != null) throw new ValidationError('EXPORT_AUDIT_SCOPE')
  }
  return {
    from: request.period?.from ?? null,
    to: request.period?.to ?? null,
    groupId,
    groupName,
    includesAudit: request.includeAudit,
    includesReceipts: request.includeReceipts,
  }
}

export function transactionFilter(scope: ExportScope, alias = 't'): { sql: string; params: SqlValue[] } {
  const parts: string[] = []
  const params: SqlValue[] = []
  if (scope.from) {
    parts.push(`${alias}.transaction_date >= ?`)
    params.push(scope.from)
  }
  if (scope.to) {
    parts.push(`${alias}.transaction_date <= ?`)
    params.push(scope.to)
  }
  if (scope.groupId != null) {
    parts.push(`${alias}.group_id = ?`)
    params.push(scope.groupId)
  }
  return { sql: parts.length ? parts.join(' AND ') : '1 = 1', params }
}

export function auditFilter(scope: ExportScope, alias = 'a'): { sql: string; params: SqlValue[] } {
  const parts: string[] = []
  const params: SqlValue[] = []
  if (scope.from) {
    parts.push(`substr(${alias}.created_at, 1, 10) >= ?`)
    params.push(scope.from)
  }
  if (scope.to) {
    parts.push(`substr(${alias}.created_at, 1, 10) <= ?`)
    params.push(scope.to)
  }
  return { sql: parts.length ? parts.join(' AND ') : '1 = 1', params }
}

function userFilter(scope: ExportScope): { sql: string; params: SqlValue[] } {
  if (scope.groupId == null) return { sql: '1 = 1', params: [] }
  const tx = transactionFilter(scope)
  return {
    sql: `(u.group_id = ? OR u.id IN (SELECT t.user_id FROM transactions t WHERE ${tx.sql}))`,
    params: [scope.groupId, ...tx.params],
  }
}

function text(value: SqlValue): string | null {
  return value == null ? null : String(value)
}

function count(db: SqlDatabase, sql: string, params: SqlValue[]): number {
  return Number(db.queryValue(sql, params) ?? 0)
}

export function countScope(db: SqlDatabase, scope: ExportScope): ExportCounts {
  const tx = transactionFilter(scope)
  const users = userFilter(scope)
  const audit = auditFilter(scope)
  return {
    currencies: count(db, 'SELECT COUNT(*) FROM currencies', []),
    groups: scope.groupId == null ? count(db, 'SELECT COUNT(*) FROM groups', []) : 1,
    users: count(db, `SELECT COUNT(*) FROM users u WHERE ${users.sql}`, users.params),
    categories: count(db, 'SELECT COUNT(*) FROM categories', []),
    transactions: count(db, `SELECT COUNT(*) FROM transactions t WHERE ${tx.sql}`, tx.params),
    audit: scope.includesAudit ? count(db, `SELECT COUNT(*) FROM audit_logs a WHERE ${audit.sql}`, audit.params) : 0,
  }
}

function currencyOrder(vaultCurrency: string) {
  return (a: string, b: string) => (a === vaultCurrency ? -1 : b === vaultCurrency ? 1 : a.localeCompare(b))
}

function loadSummary(db: SqlDatabase, scope: ExportScope, vaultCurrency: string): ExportSummary {
  const tx = transactionFilter(scope)
  const rows = db.query(
    `SELECT t.currency, t.type, t.category_id, substr(t.transaction_date, 1, 7) AS month,
            CAST(SUM(t.amount_minor) AS TEXT) AS total
     FROM transactions t
     WHERE ${tx.sql}
     GROUP BY t.currency, t.type, t.category_id, month`,
    tx.params,
  )
  const totals = new Map<string, CurrencyTotals>()
  const byCategory = new Map<string, { categoryId: number; currency: string; expenseMinor: bigint }>()
  const byMonth = new Map<string, { month: string; currency: string; incomeMinor: bigint; expenseMinor: bigint }>()
  for (const row of rows) {
    const currency = String(row.currency)
    const amount = BigInt(String(row.total))
    const income = row.type === 'INCOME'
    const total = totals.get(currency) ?? { currency, incomeMinor: 0n, expenseMinor: 0n, netMinor: 0n }
    if (income) total.incomeMinor += amount
    else total.expenseMinor += amount
    total.netMinor = total.incomeMinor - total.expenseMinor
    totals.set(currency, total)
    const monthKey = `${row.month}|${currency}`
    const month = byMonth.get(monthKey) ?? { month: String(row.month), currency, incomeMinor: 0n, expenseMinor: 0n }
    if (income) month.incomeMinor += amount
    else month.expenseMinor += amount
    byMonth.set(monthKey, month)
    if (!income) {
      const categoryKey = `${row.category_id}|${currency}`
      const category = byCategory.get(categoryKey) ?? { categoryId: Number(row.category_id), currency, expenseMinor: 0n }
      category.expenseMinor += amount
      byCategory.set(categoryKey, category)
    }
  }
  const order = currencyOrder(vaultCurrency)
  return {
    totals: [...totals.values()].sort((a, b) => order(a.currency, b.currency)),
    byCategory: [...byCategory.values()].sort(
      (a, b) => order(a.currency, b.currency) || (a.expenseMinor === b.expenseMinor ? a.categoryId - b.categoryId : a.expenseMinor > b.expenseMinor ? -1 : 1),
    ),
    byMonth: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month) || order(a.currency, b.currency)),
  }
}

function mapRow(row: Record<string, SqlValue>): ExportRow {
  const currency = String(row.currency)
  const amountMinor = Number(row.amount_minor)
  return {
    id: String(row.id),
    date: String(row.transaction_date),
    type: row.type === 'INCOME' ? 'INCOME' : 'EXPENSE',
    amountMinor,
    amount: minorToFixed(amountMinor, currency),
    currency,
    categoryId: Number(row.category_id),
    groupId: Number(row.group_id),
    userId: String(row.user_id),
    notes: text(row.notes),
    hasReceipt: Number(row.has_receipt) === 1,
    receipt: text(row.receipt_data),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    categoryNames: {
      en: String(row.name_en),
      'uz-Latn': String(row.name_uz_latn),
      'uz-Cyrl': String(row.name_uz_cyrl),
      ru: String(row.name_ru),
    },
    groupName: String(row.group_name),
    userEmail: String(row.user_email),
  }
}

function mapAudit(row: Record<string, SqlValue>): ExportAuditRow {
  return {
    seq: Number(row.seq),
    id: String(row.id),
    actorId: text(row.actor_id),
    action: String(row.action),
    entityType: text(row.entity_type),
    entityId: text(row.entity_id),
    details: text(row.details),
    createdAt: String(row.created_at),
    prevHash: String(row.prev_hash),
    hash: String(row.hash),
    actorEmail: text(row.actor_email),
  }
}

export type DatasetOptions = {
  user: { id: string; email: string }
  now?: Date
  app?: { name: string; version: string; commit: string }
}

export function createDataset(db: SqlDatabase, scope: ExportScope, options: DatasetOptions): ExportDataset {
  const vaultCurrency = getSetting(db, 'currency') ?? 'USD'
  const audit = auditFilter(scope)
  const auditBounds = scope.includesAudit
    ? db.queryOne(`SELECT MIN(a.seq) AS first, MAX(a.seq) AS last FROM audit_logs a WHERE ${audit.sql}`, audit.params)
    : null
  const meta: ExportMeta = {
    format: 'moliya-export',
    formatVersion: EXPORT_FORMAT_VERSION,
    app: options.app ?? { name: 'Jaybi', version: BUILD.version, commit: BUILD.commit },
    schemaVersion: readSchemaVersion(db),
    exportedAt: (options.now ?? new Date()).toISOString(),
    exportedBy: { id: options.user.id, email: options.user.email },
    vault: {
      name: getSetting(db, 'vault_name') ?? 'Jaybi',
      currency: vaultCurrency,
      createdAt: getSetting(db, 'vault_created_at'),
    },
    scope: {
      ...scope,
      auditFirstSeq: auditBounds?.first == null ? null : Number(auditBounds.first),
      auditLastSeq: auditBounds?.last == null ? null : Number(auditBounds.last),
    },
  }

  const currencies = db
    .query('SELECT code, minor_unit FROM currencies ORDER BY code')
    .map((row) => ({ code: String(row.code), minorUnit: Number(row.minor_unit) }))
  const groups = db
    .query(
      scope.groupId == null ? 'SELECT id, name, created_at FROM groups ORDER BY id' : 'SELECT id, name, created_at FROM groups WHERE id = ?',
      scope.groupId == null ? [] : [scope.groupId],
    )
    .map((row) => ({ id: Number(row.id), name: String(row.name), createdAt: text(row.created_at) }))
  const users = userFilter(scope)
  const people = db
    .query(
      `SELECT u.id, u.email, r.name AS role, u.group_id, u.created_at
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE ${users.sql}
       ORDER BY u.created_at, u.email`,
      users.params,
    )
    .map((row) => {
      const groupId = row.group_id == null ? null : Number(row.group_id)
      return {
        id: String(row.id),
        email: String(row.email),
        role: String(row.role),
        groupId: scope.groupId == null || groupId === scope.groupId ? groupId : null,
        createdAt: text(row.created_at),
      }
    })
  const categories = db
    .query('SELECT id, type, icon, name_en, name_uz_latn, name_uz_cyrl, name_ru FROM categories ORDER BY id')
    .map((row) => ({
      id: Number(row.id),
      type: row.type === 'INCOME' ? ('INCOME' as const) : ('EXPENSE' as const),
      icon: text(row.icon),
      names: {
        en: String(row.name_en),
        'uz-Latn': String(row.name_uz_latn),
        'uz-Cyrl': String(row.name_uz_cyrl),
        ru: String(row.name_ru),
      },
    }))
  const counts = countScope(db, scope)

  async function* transactionPages(signal?: AbortSignal, limit = Number.POSITIVE_INFINITY): AsyncGenerator<ExportRow[]> {
    const tx = transactionFilter(scope)
    let cursor: SqlValue[] = ['', '', '']
    let remaining = limit
    while (remaining > 0) {
      throwIfAborted(signal)
      const size = Math.min(PAGE_SIZE, remaining)
      const rows = db.query(
        `SELECT t.id, t.transaction_date, t.type, t.amount_minor, t.currency, t.category_id, t.group_id, t.user_id, t.notes,
                t.receipt_data IS NOT NULL AS has_receipt,
                CASE WHEN ? = 1 THEN t.receipt_data END AS receipt_data,
                t.created_at, t.updated_at,
                c.name_en, c.name_uz_latn, c.name_uz_cyrl, c.name_ru,
                g.name AS group_name, u.email AS user_email
         FROM transactions t
         JOIN categories c ON c.id = t.category_id
         JOIN groups g ON g.id = t.group_id
         JOIN users u ON u.id = t.user_id
         WHERE ${tx.sql} AND (t.transaction_date, t.created_at, t.id) > (?, ?, ?)
         ORDER BY t.transaction_date, t.created_at, t.id
         LIMIT ?`,
        [scope.includesReceipts ? 1 : 0, ...tx.params, ...cursor, size],
      )
      if (rows.length === 0) return
      yield rows.map(mapRow)
      if (rows.length < size) return
      remaining -= rows.length
      const last = rows[rows.length - 1]
      cursor = [last.transaction_date, last.created_at, last.id]
      await yieldToBrowser()
    }
  }

  async function* auditPages(signal?: AbortSignal): AsyncGenerator<ExportAuditRow[]> {
    if (!scope.includesAudit) return
    let after = 0
    for (;;) {
      throwIfAborted(signal)
      const rows = db.query(
        `SELECT a.seq, a.id, a.actor_id, a.action, a.entity_type, a.entity_id, a.details, a.created_at, a.prev_hash, a.hash,
                u.email AS actor_email
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.actor_id
         WHERE ${audit.sql} AND a.seq > ?
         ORDER BY a.seq
         LIMIT ?`,
        [...audit.params, after, PAGE_SIZE],
      )
      if (rows.length === 0) return
      yield rows.map(mapAudit)
      if (rows.length < PAGE_SIZE) return
      after = Number(rows[rows.length - 1].seq)
      await yieldToBrowser()
    }
  }

  return {
    db,
    meta,
    counts,
    currencies,
    groups,
    users: people,
    categories,
    summary: loadSummary(db, scope, vaultCurrency),
    transactionPages,
    auditPages,
  }
}
