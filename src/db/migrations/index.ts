import { FormatTooNewError, MigrationError, ValidationError } from '../../domain/errors'
import { SqlDatabase } from '../sqlite'
import { KEYS_SCHEMA_VERSION, SCHEMA_VERSION } from '../versions'
import baselineSql from './0001-baseline.sql?raw'
import { migrateExactMoney } from './0002-exact-money'
import privateSafesSql from './0003-private-safes.sql?raw'
import accessGrantsSql from './0004-access-grants.sql?raw'
import signedRosterSql from './0005-signed-roster.sql?raw'

export type Migration = {
  version: number
  name: string
  up: (db: SqlDatabase) => void
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'baseline', up: (db) => db.exec(baselineSql) },
  { version: 2, name: 'exact-money-and-audit-chain', up: migrateExactMoney },
  { version: 3, name: 'private-safes-and-verifier', up: (db) => db.exec(privateSafesSql) },
  { version: 4, name: 'access-grants-and-sign-in-check', up: (db) => db.exec(accessGrantsSql) },
]

/** Applied only when the founder upgrades a vault to per-person keys; a 1.6 vault never reaches it on its own. */
export const KEYS_MIGRATION: Migration = { version: 5, name: 'signed-roster-and-key-bindings', up: (db) => db.exec(signedRosterSql) }

export const KEYS_MIGRATIONS: readonly Migration[] = [...MIGRATIONS, KEYS_MIGRATION]

export type MigrationResult = {
  from: number
  to: number
  applied: number[]
}

function hasTable(db: SqlDatabase, name: string): boolean {
  return Number(db.queryValue("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", [name]) ?? 0) > 0
}

export function readSchemaVersion(db: SqlDatabase): number {
  const version = Number(db.queryValue('PRAGMA user_version') ?? 0)
  if (version > 0) return version
  return hasTable(db, 'transactions') ? 1 : 0
}

function quickCheck(db: SqlDatabase, version: number): void {
  const check = db.queryValue('PRAGMA quick_check')
  if (check !== 'ok') throw new MigrationError(version, `quick_check: ${String(check)}`)
}

export function migrate(
  db: SqlDatabase,
  options: { appVersion: string; migrations?: readonly Migration[]; now?: string },
): MigrationResult {
  const migrations = options.migrations ?? MIGRATIONS
  const target = migrations.length > 0 ? migrations[migrations.length - 1].version : 0
  const from = readSchemaVersion(db)
  if (from > target) throw new FormatTooNewError()
  const pending = migrations.filter((migration) => migration.version > from)
  if (pending.length === 0) {
    quickCheck(db, target)
    return { from, to: from, applied: [] }
  }
  const appliedAt = options.now ?? new Date().toISOString()
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    for (const migration of pending) {
      try {
        db.withTransaction(() => {
          migration.up(db)
          const violations = db.query('PRAGMA foreign_key_check')
          if (violations.length > 0) throw new Error(`${violations.length} foreign key violations`)
          db.exec(`PRAGMA user_version = ${migration.version}`)
          if (hasTable(db, 'schema_migrations')) {
            db.exec(
              'INSERT OR REPLACE INTO schema_migrations (version, name, applied_at, app_version) VALUES (?, ?, ?, ?)',
              [migration.version, migration.name, appliedAt, options.appVersion],
            )
          }
        })
      } catch (error) {
        throw new MigrationError(migration.version, error instanceof Error ? error.message : String(error))
      }
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
  quickCheck(db, target)
  return { from, to: target, applied: pending.map((migration) => migration.version) }
}

export function assertMigrationsMatchSchemaVersion(): void {
  const last = MIGRATIONS[MIGRATIONS.length - 1]
  if (last.version !== SCHEMA_VERSION) throw new Error(`Last migration ${last.version} != SCHEMA_VERSION ${SCHEMA_VERSION}`)
  if (KEYS_MIGRATION.version !== KEYS_SCHEMA_VERSION) throw new Error(`Keys migration ${KEYS_MIGRATION.version} != KEYS_SCHEMA_VERSION`)
  KEYS_MIGRATIONS.forEach((migration, index) => {
    if (migration.version !== index + 1) throw new Error(`Migration versions must be contiguous from 1`)
  })
}

type Schema = Map<string, string | null>

const expectedSchemas = new Map<number, Promise<Schema>>()

function readSchema(db: SqlDatabase): Schema {
  const rows = db.query('SELECT type, name, tbl_name, sql FROM sqlite_master')
  return new Map(
    rows.map((row) => [
      `${String(row.type)}:${String(row.name)}:${String(row.tbl_name)}`,
      row.sql == null ? null : String(row.sql).replace(/\s+/g, ' ').trim(),
    ]),
  )
}

function expectedSchema(version: number): Promise<Schema> {
  let pending = expectedSchemas.get(version)
  if (!pending) {
    pending = SqlDatabase.openEmpty().then((db) => {
      try {
        migrate(db, { appVersion: 'schema-check', migrations: KEYS_MIGRATIONS.slice(0, version) })
        return readSchema(db)
      } finally {
        db.close()
      }
    })
    pending.catch(() => expectedSchemas.delete(version))
    expectedSchemas.set(version, pending)
  }
  return pending
}

/** `max` is the newest schema the caller's record version may hold: 4 for a 1.6 record, 5 for a per-person-keys record. */
export async function assertKnownSchema(db: SqlDatabase, version = readSchemaVersion(db), max = SCHEMA_VERSION): Promise<void> {
  if (!Number.isSafeInteger(version) || version < 1 || version > max) throw new ValidationError('SCHEMA_UNKNOWN')
  const expected = await expectedSchema(version)
  const actual = readSchema(db)
  if (actual.size !== expected.size) throw new ValidationError('SCHEMA_UNKNOWN')
  for (const [key, sql] of actual) {
    if (!expected.has(key)) throw new ValidationError('SCHEMA_UNKNOWN')
    if (expected.get(key) !== sql) throw new ValidationError('SCHEMA_UNKNOWN')
  }
}
