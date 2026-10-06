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

const MIB = 1024 * 1024

/** An eighth of the database, at least 1 MiB and at most 64 MiB. */
export function growthRoom(size: number): number {
  return Math.min(64 * MIB, Math.max(MIB, Math.ceil(size / 8)))
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

/** Every connection, including the export's scratch one: no schema-supplied side effects, no oversized values, no extra databases beyond `attached`. */
export function hardenConnection(sqlite3: Sqlite3Static, db: Database, attached = 0): void {
  const { capi } = sqlite3
  const pointer = db.pointer
  if (pointer == null) throw new Error('SQLite handle is not open')
  db.checkRc(capi.sqlite3_db_config(pointer, capi.SQLITE_DBCONFIG_DEFENSIVE, 1, 0))
  db.checkRc(capi.sqlite3_db_config(pointer, capi.SQLITE_DBCONFIG_TRUSTED_SCHEMA, 0, 0))
  capi.sqlite3_limit(pointer, capi.SQLITE_LIMIT_LENGTH, SQLITE_VALUE_LIMIT)
  capi.sqlite3_limit(pointer, capi.SQLITE_LIMIT_ATTACHED, attached)
  db.exec('PRAGMA trusted_schema = OFF')
  db.exec('PRAGMA cell_size_check = ON')
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
    hardenConnection(this.sqlite3, this.db)
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

  /**
   * Copies `bytes` straight into the WebAssembly heap (the caller wipes its own copy) with some room to grow, so the
   * first writes after opening do not make memdb reallocate to twice the database size.
   */
  static async openBytes(bytes: Uint8Array): Promise<SqlDatabase> {
    const sqlite3 = await loadModule()
    const db = new sqlite3.oo1.DB(':memory:', 'c')
    try {
      if (db.pointer == null) throw new Error('SQLite handle is not open')
      const size = bytes.byteLength
      const room = size + growthRoom(size)
      const pointer = sqlite3.wasm.alloc(room)
      sqlite3.wasm.heap8u().set(bytes, pointer)
      const flags = sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE
      // With FREEONCLOSE, SQLite frees the buffer itself even when this call fails.
      db.checkRc(sqlite3.capi.sqlite3_deserialize(db.pointer, 'main', pointer, size, room, flags))
    } catch (error) {
      db.close()
      throw error
    }
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

  /**
   * A fresh copy of the database outside the WebAssembly heap. A deserialized database is read in place
   * (`SQLITE_SERIALIZE_NOCOPY`), so SQLite does not first make a second copy inside the heap, which never shrinks.
   */
  export(): Uint8Array {
    const pointer = this.db.pointer
    if (pointer == null) throw new Error('SQLite handle is not open')
    const { capi, wasm } = this.sqlite3
    const scope = wasm.scopedAllocPush()
    try {
      const sizeOut = wasm.scopedAlloc(8)
      const data = capi.sqlite3_serialize(pointer, 'main', sizeOut, capi.SQLITE_SERIALIZE_NOCOPY)
      const size = Number(wasm.peek(sizeOut, 'i64'))
      if (data && size > 0) return wasm.heap8u().slice(data, data + size)
    } finally {
      wasm.scopedAllocPop(scope)
    }
    // A database built in this session is not a memdb buffer, so SQLite has to assemble a copy.
    const exported = capi.sqlite3_js_db_export(pointer)
    return exported instanceof Uint8Array ? exported : new Uint8Array(exported)
  }

  close(): void {
    this.db.close()
  }
}
