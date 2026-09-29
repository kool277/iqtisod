import { afterEach, describe, expect, it } from 'vitest'
import { assertKnownSchema, migrate } from '../../src/db/migrations'
import { SqlDatabase } from '../../src/db/sqlite'
import { SCHEMA_VERSION } from '../../src/db/versions'
import { AppError } from '../../src/domain/errors'
import { LIMITS } from '../../src/lib/limits'
import { fixtureByPath, openRawFixtureDatabase, readManifest } from '../support/fixtures'

const APP = { appVersion: 'test' }
const open: SqlDatabase[] = []

afterEach(() => {
  for (const db of open.splice(0)) db.close()
})

async function track(promise: Promise<SqlDatabase>): Promise<SqlDatabase> {
  const db = await promise
  open.push(db)
  return db
}

async function migrated(): Promise<SqlDatabase> {
  const db = await track(SqlDatabase.openEmpty())
  migrate(db, APP)
  return db
}

async function schemaCode(db: SqlDatabase, version?: number): Promise<string | null> {
  try {
    await assertKnownSchema(db, version)
    return null
  } catch (error) {
    return error instanceof AppError ? error.code : `unexpected: ${String(error)}`
  }
}

async function copyOf(db: SqlDatabase): Promise<SqlDatabase> {
  return track(SqlDatabase.openBytes(db.export()))
}

function expectAttachRefused(db: SqlDatabase): void {
  expect(() => db.exec("ATTACH DATABASE ':memory:' AS other")).toThrow(/too many attached/i)
  expect(() => db.exec("ATTACH DATABASE 'file:x?mode=memory' AS other")).toThrow()
  expect(db.query('PRAGMA database_list').map((row) => row.name).filter((name) => name !== 'temp')).toEqual(['main'])
}

describe('SQLite connection hardening', () => {
  it('refuses ATTACH on new and deserialized databases', async () => {
    const fresh = await migrated()
    expectAttachRefused(fresh)
    expectAttachRefused(await copyOf(fresh))
    expectAttachRefused(await track(openRawFixtureDatabase(fixtureByPath('v1/business-uzs'))))
  })

  it('refuses strings and blobs larger than 8 MiB', async () => {
    const db = await track(SqlDatabase.openEmpty())
    expect(LIMITS.sqliteValueBytes).toBe(8 * 1024 * 1024)
    expect(db.queryValue('SELECT length(zeroblob(?))', [LIMITS.sqliteValueBytes])).toBe(LIMITS.sqliteValueBytes)
    expect(() => db.queryValue('SELECT length(zeroblob(?))', [LIMITS.sqliteValueBytes + 1])).toThrow(/too big/i)
    expect(() => db.queryValue('SELECT length(randomblob(?))', [LIMITS.sqliteValueBytes + 1])).toThrow(/too big/i)
    expect(() => db.queryValue("SELECT length(printf('%.*c', ?, 'x'))", [LIMITS.sqliteValueBytes + 1])).toThrow(/too big/i)
    expect(() => db.queryValue('SELECT length(?)', ['x'.repeat(LIMITS.sqliteValueBytes + 1)])).toThrow()
    db.exec('CREATE TABLE t (v TEXT)')
    expect(() => db.exec('INSERT INTO t VALUES (?)', ['x'.repeat(LIMITS.sqliteValueBytes + 1)])).toThrow()
    expect(db.queryValue('SELECT COUNT(*) FROM t')).toBe(0)
    db.exec('INSERT INTO t VALUES (?)', ['x'.repeat(1024 * 1024)])
    expect(db.queryValue('SELECT length(v) FROM t')).toBe(1024 * 1024)
  })

  it('applies the safety pragmas', async () => {
    for (const db of [await migrated(), await track(openRawFixtureDatabase(fixtureByPath('v2/ledger-v2')))]) {
      expect(db.queryValue('PRAGMA trusted_schema')).toBe(0)
      expect(db.queryValue('PRAGMA foreign_keys')).toBe(1)
      expect(db.queryValue('PRAGMA secure_delete')).toBe(1)
      expect(db.queryValue('PRAGMA cell_size_check')).toBe(1)
    }
  })

  it('runs in defensive mode, so the schema table cannot be written directly', async () => {
    const db = await migrated()
    db.exec('PRAGMA writable_schema = ON')
    expect(() => db.exec("UPDATE sqlite_master SET sql = 'CREATE TABLE x(y)' WHERE name = 'settings'")).toThrow()
    expect(() => db.exec("INSERT INTO sqlite_master VALUES ('table', 'evil', 'evil', 0, 'CREATE TABLE evil(x)')")).toThrow()
    expect(Number(db.queryValue("SELECT COUNT(*) FROM sqlite_master WHERE name = 'evil'"))).toBe(0)
  })

  it('vacuums with a temporary attach slot and closes it again', async () => {
    const db = await migrated()
    db.exec('CREATE TABLE junk (v BLOB)')
    db.exec('INSERT INTO junk VALUES (zeroblob(1000000))')
    db.exec('DROP TABLE junk')
    const before = db.sizeBytes()
    db.vacuum()
    expect(db.sizeBytes()).toBeLessThan(before)
    expect(db.queryValue('PRAGMA quick_check')).toBe('ok')
    expectAttachRefused(db)
    db.vacuum()
    expectAttachRefused(db)
  })

  it('closes the attach slot even when VACUUM fails', async () => {
    const db = await migrated()
    db.exec('BEGIN')
    expect(() => db.vacuum()).toThrow()
    db.exec('ROLLBACK')
    expectAttachRefused(db)
  })
})

describe('assertKnownSchema', () => {
  it('accepts a freshly migrated database', async () => {
    const db = await migrated()
    expect(await schemaCode(db)).toBeNull()
    expect(await schemaCode(db, SCHEMA_VERSION)).toBeNull()
  })

  it('accepts every fixture as stored, and again once upgraded', async () => {
    for (const entry of readManifest()) {
      const db = await track(openRawFixtureDatabase(fixtureByPath(entry.path)))
      expect(await schemaCode(db), `${entry.path} as stored`).toBeNull()
      migrate(db, APP)
      expect(await schemaCode(db, SCHEMA_VERSION), `${entry.path} upgraded`).toBeNull()
    }
  })

  it('refuses unknown tables, indexes, views and triggers', async () => {
    const additions = [
      'CREATE TABLE evil (x TEXT)',
      'CREATE INDEX evil_idx ON settings(value)',
      'CREATE VIEW evil_view AS SELECT * FROM users',
      "CREATE TRIGGER evil_trigger AFTER INSERT ON transactions BEGIN UPDATE settings SET value = 'x'; END",
      "CREATE TRIGGER evil_temp_like BEFORE DELETE ON users BEGIN SELECT RAISE(IGNORE); END",
    ]
    const base = await migrated()
    for (const sql of additions) {
      const db = await copyOf(base)
      db.exec(sql)
      expect(await schemaCode(db), sql).toBe('SCHEMA_UNKNOWN')
    }
  })

  it('refuses a known trigger whose body was changed', async () => {
    const db = await migrated()
    const trigger = db.queryOne("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name LIMIT 1")
    expect(trigger).not.toBeNull()
    const name = String(trigger!.name)
    const table = String(db.queryValue("SELECT tbl_name FROM sqlite_master WHERE name = ?", [name]))
    db.exec(`DROP TRIGGER ${name}`)
    db.exec(`CREATE TRIGGER ${name} BEFORE UPDATE ON ${table} BEGIN SELECT 1; END`)
    expect(await schemaCode(db)).toBe('SCHEMA_UNKNOWN')
  })

  it('refuses a database with a known object missing', async () => {
    const db = await migrated()
    const trigger = String(db.queryValue("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name LIMIT 1"))
    db.exec(`DROP TRIGGER ${trigger}`)
    expect(await schemaCode(db)).toBe('SCHEMA_UNKNOWN')
  })

  it('refuses a schema that does not match the claimed version', async () => {
    const db = await migrated()
    expect(await schemaCode(db, 1)).toBe('SCHEMA_UNKNOWN')
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`)
    expect(await schemaCode(db)).toBe('SCHEMA_UNKNOWN')
  })

  it('refuses versions outside the known range', async () => {
    const db = await migrated()
    for (const version of [0, -1, SCHEMA_VERSION + 1, 1.5, Number.NaN]) {
      expect(await schemaCode(db, version), String(version)).toBe('SCHEMA_UNKNOWN')
    }
    const empty = await track(SqlDatabase.openEmpty())
    expect(await schemaCode(empty)).toBe('SCHEMA_UNKNOWN')
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    expect(await schemaCode(db)).toBe('SCHEMA_UNKNOWN')
  })
})
