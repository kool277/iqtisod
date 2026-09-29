import { FormatTooNewError, MigrationError } from '../../domain/errors'
import type { SqlDatabase } from '../sqlite'
import { SCHEMA_VERSION } from '../versions'
import baselineSql from './0001-baseline.sql?raw'
import { migrateExactMoney } from './0002-exact-money'

export type Migration = {
  version: number
  name: string
  up: (db: SqlDatabase) => void
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'baseline', up: (db) => db.exec(baselineSql) },
  { version: 2, name: 'exact-money-and-audit-chain', up: migrateExactMoney },
]

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

export function migrate(
  db: SqlDatabase,
  options: { appVersion: string; migrations?: readonly Migration[]; now?: string },
): MigrationResult {
  const migrations = options.migrations ?? MIGRATIONS
  const target = migrations.length > 0 ? migrations[migrations.length - 1].version : 0
  const from = readSchemaVersion(db)
  if (from > target) throw new FormatTooNewError()
  const pending = migrations.filter((migration) => migration.version > from)
  if (pending.length === 0) return { from, to: from, applied: [] }
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
  const check = db.queryValue('PRAGMA quick_check')
  if (check !== 'ok') throw new MigrationError(target, `quick_check: ${String(check)}`)
  return { from, to: target, applied: pending.map((migration) => migration.version) }
}

export function assertMigrationsMatchSchemaVersion(): void {
  const last = MIGRATIONS[MIGRATIONS.length - 1]
  if (last.version !== SCHEMA_VERSION) throw new Error(`Last migration ${last.version} != SCHEMA_VERSION ${SCHEMA_VERSION}`)
  MIGRATIONS.forEach((migration, index) => {
    if (migration.version !== index + 1) throw new Error(`Migration versions must be contiguous from 1`)
  })
}
