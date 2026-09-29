import { loadModule, type SqlValue } from '../../db/sqlite'
import { auditFilter, transactionFilter, type ExportMeta, type ExportScope } from './dataset'

export const EXPORT_PAGE_SIZE = 4096
export const SQLCIPHER_RESERVE_BYTES = 80
export const MOLIYA_APPLICATION_ID = 0x4d4c5941

export const EXPORT_SETTINGS_KEYS = ['vault_name', 'currency', 'vault_created_at'] as const

export const EXPORT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  roles: ['id', 'name', 'permissions'],
  groups: ['id', 'name', 'created_at'],
  users: ['id', 'email', 'password_hash', 'salt', 'role_id', 'group_id', 'created_at'],
  categories: ['id', 'name_en', 'name_uz_latn', 'name_uz_cyrl', 'name_ru', 'type', 'icon'],
  currencies: ['code', 'minor_unit'],
  transactions: [
    'id',
    'type',
    'amount_minor',
    'currency',
    'category_id',
    'user_id',
    'group_id',
    'transaction_date',
    'notes',
    'receipt_data',
    'created_at',
    'updated_at',
  ],
  schema_migrations: ['version', 'name', 'applied_at', 'app_version'],
  settings: ['key', 'value'],
  audit_logs: ['seq', 'id', 'actor_id', 'action', 'entity_type', 'entity_id', 'details', 'created_at', 'prev_hash', 'hash'],
}

export function exportTables(scope: Pick<ExportScope, 'includesAudit'>): string[] {
  const tables = ['roles', 'groups', 'users', 'categories', 'currencies', 'transactions', 'schema_migrations', 'settings']
  return scope.includesAudit ? [...tables, 'audit_logs'] : tables
}

type TablePlan = { alias: string; where: string; params: SqlValue[]; overrides: Record<string, { sql: string; params: SqlValue[] }> }

function tablePlan(table: string, scope: ExportScope): TablePlan {
  const none = { alias: 'x', where: '1 = 1', params: [], overrides: {} }
  switch (table) {
    case 'groups':
      return scope.groupId == null ? none : { alias: 'g', where: 'g.id = ?', params: [scope.groupId], overrides: {} }
    case 'users': {
      const overrides: TablePlan['overrides'] = { password_hash: { sql: "''", params: [] }, salt: { sql: "''", params: [] } }
      if (scope.groupId == null) return { alias: 'u', where: '1 = 1', params: [], overrides }
      const tx = transactionFilter(scope, 't')
      overrides.group_id = { sql: 'CASE WHEN u.group_id = ? THEN u.group_id END', params: [scope.groupId] }
      return {
        alias: 'u',
        where: `(u.group_id = ? OR u.id IN (SELECT t.user_id FROM src.transactions t WHERE ${tx.sql}))`,
        params: [scope.groupId, ...tx.params],
        overrides,
      }
    }
    case 'transactions': {
      const tx = transactionFilter(scope, 't')
      const overrides: TablePlan['overrides'] = scope.includesReceipts ? {} : { receipt_data: { sql: 'NULL', params: [] } }
      return { alias: 't', where: tx.sql, params: tx.params, overrides }
    }
    case 'settings':
      return {
        alias: 's',
        where: `s.key IN (${EXPORT_SETTINGS_KEYS.map(() => '?').join(', ')})`,
        params: [...EXPORT_SETTINGS_KEYS],
        overrides: {},
      }
    case 'audit_logs': {
      const audit = auditFilter(scope, 'a')
      return { alias: 'a', where: audit.sql, params: audit.params, overrides: {} }
    }
    default:
      return none
  }
}

function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

export function exportInfo(meta: ExportMeta): [string, string][] {
  return [
    ['format', meta.format],
    ['formatVersion', String(meta.formatVersion)],
    ['appVersion', meta.app.version],
    ['appCommit', meta.app.commit],
    ['schemaVersion', String(meta.schemaVersion)],
    ['exportedAt', meta.exportedAt],
    ['exportedById', meta.exportedBy.id],
    ['exportedByEmail', meta.exportedBy.email],
    ['from', meta.scope.from ?? ''],
    ['to', meta.scope.to ?? ''],
    ['groupId', meta.scope.groupId == null ? '' : String(meta.scope.groupId)],
    ['groupName', meta.scope.groupName ?? ''],
    ['includesAudit', String(meta.scope.includesAudit)],
    ['includesReceipts', String(meta.scope.includesReceipts)],
    ['auditFirstSeq', meta.scope.auditFirstSeq == null ? '' : String(meta.scope.auditFirstSeq)],
    ['auditLastSeq', meta.scope.auditLastSeq == null ? '' : String(meta.scope.auditLastSeq)],
  ]
}

export async function buildExportDatabase(
  source: Uint8Array,
  meta: ExportMeta,
  options: { reserveBytes: 0 | typeof SQLCIPHER_RESERVE_BYTES },
): Promise<Uint8Array> {
  const scope = meta.scope
  const sqlite3 = await loadModule()
  const { capi, wasm } = sqlite3
  const db = new sqlite3.oo1.DB(':memory:', 'c')
  try {
    if (db.pointer == null) throw new Error('SQLite handle is not open')
    db.exec(`PRAGMA page_size = ${EXPORT_PAGE_SIZE}`)
    if (options.reserveBytes > 0) {
      const pointer = wasm.alloc(4)
      try {
        wasm.poke32(pointer, options.reserveBytes)
        db.checkRc(capi.sqlite3_file_control(db.pointer, 'main', capi.SQLITE_FCNTL_RESERVE_BYTES, pointer))
      } finally {
        wasm.dealloc(pointer)
      }
    }
    db.exec("ATTACH ':memory:' AS src")
    const copy = new Uint8Array(source.byteLength)
    copy.set(source)
    const pointer = wasm.allocFromTypedArray(copy)
    db.checkRc(
      capi.sqlite3_deserialize(
        db.pointer,
        'src',
        pointer,
        copy.byteLength,
        copy.byteLength,
        capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_READONLY,
      ),
    )

    const tables = exportTables(scope)
    const schema = db.selectObjects(
      `SELECT type, name, tbl_name, sql FROM src.sqlite_schema
       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND tbl_name IN (${tables.map(() => '?').join(', ')})
       ORDER BY rowid`,
      tables,
    ) as { type: string; name: string; tbl_name: string; sql: string }[]
    for (const entry of schema.filter((item) => item.type === 'table')) db.exec(entry.sql)

    db.exec('BEGIN')
    for (const entry of schema.filter((item) => item.type === 'table')) {
      const table = entry.name
      const known = EXPORT_COLUMNS[table] ?? []
      const columns = (db.selectObjects(`PRAGMA src.table_info(${quote(table)})`) as { name: string }[]).map((column) => column.name)
      const plan = tablePlan(table, scope)
      const params: SqlValue[] = []
      const expressions = columns.map((column) => {
        const override = plan.overrides[column]
        if (override) {
          params.push(...override.params)
          return override.sql
        }
        return known.includes(column) ? `${plan.alias}.${quote(column)}` : 'NULL'
      })
      params.push(...plan.params)
      const sql = `INSERT INTO main.${quote(table)} (${columns.map(quote).join(', ')})
        SELECT ${expressions.join(', ')} FROM src.${quote(table)} AS ${plan.alias} WHERE ${plan.where}`
      if (params.length) db.exec(sql, { bind: params })
      else db.exec(sql)
    }
    db.exec('COMMIT')
    for (const entry of schema.filter((item) => item.type === 'index')) db.exec(entry.sql)
    for (const entry of schema.filter((item) => item.type === 'trigger')) db.exec(entry.sql)

    db.exec('CREATE TABLE export_info (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    for (const [key, value] of exportInfo(meta)) db.exec('INSERT INTO export_info (key, value) VALUES (?, ?)', { bind: [key, value] })
    const userVersion = Number(db.selectValue('PRAGMA src.user_version') ?? 0)
    db.exec(`PRAGMA application_id = ${MOLIYA_APPLICATION_ID}`)
    db.exec(`PRAGMA user_version = ${Math.trunc(userVersion)}`)
    db.exec('DETACH src')
    return new Uint8Array(capi.sqlite3_js_db_export(db.pointer))
  } finally {
    db.close()
  }
}
