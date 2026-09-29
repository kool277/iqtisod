import schemaSql from './schema.sql?raw'
import type { SqlDatabase } from './sqlite'

export function applySchema(db: SqlDatabase): void {
  db.exec(schemaSql)
}
