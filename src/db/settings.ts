import type { SqlDatabase } from './sqlite'

export function getSetting(db: SqlDatabase, key: string): string | null {
  const value = db.queryValue('SELECT value FROM settings WHERE key = ?', [key])
  return value == null ? null : String(value)
}

export function setSetting(db: SqlDatabase, key: string, value: string): void {
  db.exec(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  )
}
