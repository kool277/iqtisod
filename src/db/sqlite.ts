import type { Database, Sqlite3Static, SqlValue as WasmSqlValue } from '@sqlite.org/sqlite-wasm'

export type SqlValue = string | number | null

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
    this.exec('PRAGMA foreign_keys = ON')
    this.exec('PRAGMA secure_delete = ON')
  }

  static async openBytes(bytes: Uint8Array): Promise<SqlDatabase> {
    const sqlite3 = await loadModule()
    const db = new sqlite3.oo1.DB(':memory:', 'c')
    if (db.pointer == null) throw new Error('SQLite handle is not open')
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    const pointer = sqlite3.wasm.allocFromTypedArray(copy)
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
    return new Uint8Array(exported)
  }

  close(): void {
    this.db.close()
  }
}
