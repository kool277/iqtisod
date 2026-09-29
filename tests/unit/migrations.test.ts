import { afterEach, describe, expect, it } from 'vitest'
import { verifyAuditChain } from '../../src/db/audit-chain'
import { MIGRATIONS, assertMigrationsMatchSchemaVersion, migrate, readSchemaVersion, type Migration } from '../../src/db/migrations'
import { SqlDatabase } from '../../src/db/sqlite'
import { SCHEMA_VERSION } from '../../src/db/versions'
import { FormatTooNewError, MigrationError } from '../../src/domain/errors'
import { fixtureByPath, openRawFixtureDatabase } from '../support/fixtures'

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

function columns(db: SqlDatabase, table: string): string[] {
  return db.query(`PRAGMA table_info(${table})`).map((row) => String(row.name))
}

function schemaOf(db: SqlDatabase): string[] {
  return db
    .query("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .map((row) => `${row.type}:${row.name}:${String(row.sql ?? '').replace(/\s+/g, ' ')}`)
}

describe('schema migrations', () => {
  it('lists contiguous migrations ending at the current schema version', () => {
    expect(() => assertMigrationsMatchSchemaVersion()).not.toThrow()
    expect(MIGRATIONS.at(-1)?.version).toBe(SCHEMA_VERSION)
  })

  it('builds a new database by replaying every migration', async () => {
    const db = await track(SqlDatabase.openEmpty())
    expect(readSchemaVersion(db)).toBe(0)
    const result = migrate(db, APP)
    expect(result).toEqual({ from: 0, to: SCHEMA_VERSION, applied: MIGRATIONS.map((migration) => migration.version) })
    expect(Number(db.queryValue('PRAGMA user_version'))).toBe(SCHEMA_VERSION)
    expect(db.query('SELECT version FROM schema_migrations ORDER BY version').map((row) => Number(row.version))).toEqual([1, 2])
    expect(migrate(db, APP).applied).toEqual([])
  })

  it('detects a 1.0.0 database and upgrades it to integer minor units', async () => {
    const fixture = fixtureByPath('v1/household-usd')
    const db = await track(openRawFixtureDatabase(fixture))
    expect(Number(db.queryValue('PRAGMA user_version'))).toBe(0)
    expect(readSchemaVersion(db)).toBe(1)
    expect(columns(db, 'transactions')).toContain('amount')

    expect(migrate(db, APP)).toEqual({ from: 1, to: SCHEMA_VERSION, applied: [2] })
    expect(columns(db, 'transactions')).toContain('amount_minor')
    expect(columns(db, 'transactions')).not.toContain('amount')
    expect(db.queryValue("SELECT COUNT(*) FROM transactions WHERE typeof(amount_minor) <> 'integer'")).toBe(0)
    const byId = new Map(db.query('SELECT id, amount_minor FROM transactions').map((row) => [row.id, row.amount_minor]))
    for (const tx of fixture.expected.transactions) expect(byId.get(tx.id), tx.id).toBe(tx.amountMinor)
    expect(verifyAuditChain(db)).toMatchObject({ ok: true, entries: fixture.expected.auditActions.length })
    expect(db.queryValue('PRAGMA foreign_key_check')).toBeUndefined()
  })

  it('produces the same schema for upgraded and new databases', async () => {
    const upgraded = await track(openRawFixtureDatabase(fixtureByPath('v1/business-uzs')))
    migrate(upgraded, APP)
    const fresh = await track(SqlDatabase.openEmpty())
    migrate(fresh, APP)
    expect(schemaOf(upgraded)).toEqual(schemaOf(fresh))
  })

  it('makes the audit log append-only', async () => {
    const db = await track(openRawFixtureDatabase(fixtureByPath('v1/business-uzs')))
    migrate(db, APP)
    expect(() => db.exec("UPDATE audit_logs SET action = 'X' WHERE seq = 1")).toThrow()
    expect(() => db.exec('DELETE FROM audit_logs WHERE seq = 1')).toThrow()
    expect(verifyAuditChain(db).ok).toBe(true)
  })

  it('rolls a failed migration back completely and reports which one failed', async () => {
    const db = await track(SqlDatabase.openEmpty())
    migrate(db, APP)
    const broken: Migration = {
      version: SCHEMA_VERSION + 1,
      name: 'broken',
      up: (target) => {
        target.exec('CREATE TABLE half_done (value TEXT)')
        target.exec("UPDATE settings SET value = 'changed'")
        throw new Error('boom')
      },
    }
    const before = db.query('SELECT key, value FROM settings ORDER BY key')
    let caught: unknown
    try {
      migrate(db, { ...APP, migrations: [...MIGRATIONS, broken] })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(MigrationError)
    expect((caught as MigrationError).version).toBe(SCHEMA_VERSION + 1)
    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION)
    expect(db.queryValue("SELECT COUNT(*) FROM sqlite_master WHERE name = 'half_done'")).toBe(0)
    expect(db.query('SELECT key, value FROM settings ORDER BY key')).toEqual(before)
  })

  it('refuses to upgrade 1.0.0 data it cannot convert exactly, leaving it untouched', async () => {
    const db = await track(openRawFixtureDatabase(fixtureByPath('v1/business-uzs')))
    db.exec("UPDATE transactions SET currency = 'GBP' WHERE rowid = 1")
    expect(() => migrate(db, APP)).toThrow(MigrationError)
    expect(readSchemaVersion(db)).toBe(1)
    expect(columns(db, 'transactions')).toContain('amount')
  })

  it('refuses a database written by a newer schema', async () => {
    const db = await track(SqlDatabase.openEmpty())
    migrate(db, APP)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    expect(() => migrate(db, APP)).toThrow(FormatTooNewError)
  })
})
