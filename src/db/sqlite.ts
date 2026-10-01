import type { Database, Sqlite3Static, SqlValue as WasmSqlValue } from '@sqlite.org/sqlite-wasm'
import { LIMITS } from '../lib/limits'

export type SqlValue = string | number | null

const SQLITE_VALUE_LIMIT = LIMITS.sqliteValueBytes

let modulePromise: Promise<Sqlite3Static> | null = null

export function loadModule(): Promise<Sqlite3Static> {
  modulePromise ??= import('@sqlite.org/sqlite-wasm').then((module) => module.default())
  modulePromise.catch(() => {
    modulePromise = null
  })
  return modulePromise
}

function normalize(value: WasmSqlValue | undefined): SqlValue {
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number' || typeof value === 'string') return value
  if (value == null) return null
  return null
}

function normalizeRow(row: Record<string, WasmSqlValue>): Record<string, SqlValue> {
  const result: Record<string, SqlValue> = {}
  for (const [key, value] of Object.entries(row)) result[key] = normalize(value)
  return result
}

export class SqlDatabase {
  private constructor(
    private readonly sqlite3: Sqlite3Static,
    private db: Database,
  ) {}

  static async openEmpty(): Promise<SqlDatabase> {
    const sqlite3 = await loadModule()
    const db = new sqlite3.oo1.DB(':memory:', 'c')
    const handle = new SqlDatabase(sqlite3, db)
    handle.configure()
    return handle
  }

  private configure(): void {
    const { capi } = this.sqlite3
    const pointer = this.db.pointer
    if (pointer == null) throw new Error('SQLite handle is not open')
    this.db.checkRc(capi.sqlite3_db_config(pointer, capi.SQLITE_DBCONFIG_DEFENSIVE, 1, 0))
    this.db.checkRc(capi.sqlite3_db_config(pointer, capi.SQLITE_DBCONFIG_TRUSTED_SCHEMA, 0, 0))
    capi.sqlite3_limit(pointer, capi.SQLITE_LIMIT_LENGTH, SQLITE_VALUE_LIMIT)
    capi.sqlite3_limit(pointer, capi.SQLITE_LIMIT_ATTACHED, 0)
    this.exec('PRAGMA trusted_schema = OFF')
    this.exec('PRAGMA cell_size_check = ON')
    this.exec('PRAGMA foreign_keys = ON')
    this.exec('PRAGMA secure_delete = ON')
  }

  /** VACUUM attaches a scratch database internally, so it needs one attach slot while it runs. */
  vacuum(): void {
    const { capi } = this.sqlite3
    const pointer = this.db.pointer
    if (pointer == null) throw new Error('SQLite handle is not open')
    capi.sqlite3_limit(pointer, capi.SQLITE_LIMIT_ATTACHED, 1)
    try {
      this.exec('VACUUM')
    } finally {
      capi.sqlite3_limit(pointer, capi.SQLITE_LIMIT_ATTACHED, 0)
    }
  }

  sizeBytes(): number {
    return Number(this.queryValue('PRAGMA page_count') ?? 0) * Number(this.queryValue('PRAGMA page_size') ?? 0)
  }

  static async openBytes(bytes: Uint8Array): Promise<SqlDatabase> {
    const sqlite3 = await loadModule()
    const db = new sqlite3.oo1.DB(':memory:', 'c')
    if (db.pointer == null) throw new Error('SQLite handle is not open')
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    let pointer: number
    try {
      pointer = sqlite3.wasm.allocFromTypedArray(copy)
    } finally {
      copy.fill(0)
    }
    const flags =
      sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE
    const rc = sqlite3.capi.sqlite3_deserialize(
      db.pointer,
      'main',
      pointer,
      copy.byteLength,
      copy.byteLength,
      flags,
    )
    db.checkRc(rc)
    const handle = new SqlDatabase(sqlite3, db)
    handle.configure()
    return handle
  }

  exec(sql: string, params: SqlValue[] = []): void {
    if (params.length === 0) this.db.exec(sql)
    else this.db.exec(sql, { bind: params })
  }

  query(sql: string, params: SqlValue[] = []): Record<string, SqlValue>[] {
    const rows = params.length === 0 ? this.db.selectObjects(sql) : this.db.selectObjects(sql, params)
    return rows.map((row) => normalizeRow(row))
  }

  queryOne(sql: string, params: SqlValue[] = []): Record<string, SqlValue> | null {
    const row = params.length === 0 ? this.db.selectObject(sql) : this.db.selectObject(sql, params)
    return row ? normalizeRow(row) : null
  }

  queryValue(sql: string, params: SqlValue[] = []): SqlValue | undefined {
    const value = params.length === 0 ? this.db.selectValue(sql) : this.db.selectValue(sql, params)
    if (value === undefined) return undefined
    return normalize(value)
  }

  withTransaction<T>(fn: () => T): T {
    this.exec('BEGIN')
    try {
      const result = fn()
      this.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.exec('ROLLBACK')
      } catch {
        // The original error is the one worth surfacing.
      }
      throw error
    }
  }

  export(): Uint8Array {
    if (this.db.pointer == null) throw new Error('SQLite handle is not open')
    const exported = this.sqlite3.capi.sqlite3_js_db_export(this.db.pointer)
    // Already a fresh copy out of the WASM heap; copying again would leave one more plaintext behind.
    return exported instanceof Uint8Array ? exported : new Uint8Array(exported)
  }

  close(): void {
    this.db.close()
  }
}
