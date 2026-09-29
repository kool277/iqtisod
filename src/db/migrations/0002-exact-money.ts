import { legacyAmountToMinor } from '../../lib/money'
import { GENESIS_HASH, auditHash, type AuditLink } from '../audit-chain'
import type { SqlDatabase, SqlValue } from '../sqlite'

const MINOR_UNITS: Record<string, number> = { USD: 2, UZS: 2, EUR: 2, RUB: 2 }

function text(value: SqlValue): string | null {
  return value == null ? null : String(value)
}

function createCurrencies(db: SqlDatabase): void {
  db.exec(`CREATE TABLE currencies (
    code TEXT PRIMARY KEY CHECK (length(code) = 3 AND code = upper(code)),
    minor_unit INTEGER NOT NULL CHECK (typeof(minor_unit) = 'integer' AND minor_unit BETWEEN 0 AND 4)
  )`)
  for (const [code, minorUnit] of Object.entries(MINOR_UNITS)) {
    db.exec('INSERT INTO currencies (code, minor_unit) VALUES (?, ?)', [code, minorUnit])
  }
}

function rebuildTransactions(db: SqlDatabase): void {
  db.exec(`CREATE TABLE transactions_v2 (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('INCOME', 'EXPENSE')),
    amount_minor INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer' AND amount_minor > 0),
    currency TEXT NOT NULL REFERENCES currencies(code),
    category_id INTEGER NOT NULL REFERENCES categories(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    group_id INTEGER NOT NULL REFERENCES groups(id),
    transaction_date TEXT NOT NULL CHECK (transaction_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
    notes TEXT,
    receipt_data TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`)
  const rows = db.query(
    `SELECT id, type, amount, currency, category_id, user_id, group_id, transaction_date, notes, receipt_data,
            COALESCE(created_at, CURRENT_TIMESTAMP) AS created_at, COALESCE(updated_at, created_at, CURRENT_TIMESTAMP) AS updated_at
     FROM transactions ORDER BY rowid`,
  )
  for (const row of rows) {
    const currency = row.currency == null ? 'USD' : String(row.currency)
    const exponent = MINOR_UNITS[currency]
    if (exponent === undefined) throw new Error(`transaction ${row.id} uses unknown currency ${currency}`)
    const amountMinor = legacyAmountToMinor(Number(row.amount), exponent)
    if (amountMinor <= 0) throw new Error(`transaction ${row.id} has a non-positive amount`)
    db.exec(
      `INSERT INTO transactions_v2 (
         id, type, amount_minor, currency, category_id, user_id, group_id, transaction_date, notes, receipt_data, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.type,
        amountMinor,
        currency,
        row.category_id,
        row.user_id,
        row.group_id,
        row.transaction_date,
        row.notes,
        row.receipt_data,
        row.created_at,
        row.updated_at,
      ],
    )
  }
  db.exec('DROP TABLE transactions')
  db.exec('ALTER TABLE transactions_v2 RENAME TO transactions')
  db.exec(`CREATE INDEX idx_tx_date ON transactions(transaction_date);
    CREATE INDEX idx_tx_user ON transactions(user_id);
    CREATE INDEX idx_tx_group ON transactions(group_id);
    CREATE INDEX idx_tx_currency_date ON transactions(currency, transaction_date);`)
}

function rebuildAudit(db: SqlDatabase): void {
  db.exec(`CREATE TABLE audit_logs_v2 (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    actor_id TEXT,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    details TEXT,
    created_at TEXT NOT NULL,
    prev_hash TEXT NOT NULL CHECK (length(prev_hash) = 64),
    hash TEXT NOT NULL UNIQUE CHECK (length(hash) = 64)
  )`)
  const rows = db.query(
    `SELECT id, actor_id, action, entity_type, entity_id, details, COALESCE(created_at, CURRENT_TIMESTAMP) AS created_at
     FROM audit_logs ORDER BY rowid`,
  )
  let previous = GENESIS_HASH
  rows.forEach((row, index) => {
    const link: AuditLink = {
      seq: index + 1,
      id: String(row.id),
      actorId: text(row.actor_id),
      action: String(row.action),
      entityType: text(row.entity_type),
      entityId: text(row.entity_id),
      details: text(row.details),
      createdAt: String(row.created_at),
      prevHash: previous,
    }
    const hash = auditHash(link)
    db.exec(
      `INSERT INTO audit_logs_v2 (seq, id, actor_id, action, entity_type, entity_id, details, created_at, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [link.seq, link.id, link.actorId, link.action, link.entityType, link.entityId, link.details, link.createdAt, link.prevHash, hash],
    )
    previous = hash
  })
  db.exec('DROP TABLE audit_logs')
  db.exec('ALTER TABLE audit_logs_v2 RENAME TO audit_logs')
  db.exec(`CREATE INDEX idx_audit_created ON audit_logs(created_at);
    CREATE TRIGGER audit_logs_append_only_update BEFORE UPDATE ON audit_logs
    BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
    CREATE TRIGGER audit_logs_append_only_delete BEFORE DELETE ON audit_logs
    BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;`)
}

export function migrateExactMoney(db: SqlDatabase): void {
  createCurrencies(db)
  rebuildTransactions(db)
  rebuildAudit(db)
  db.exec(`CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT,
    app_version TEXT
  )`)
  db.exec(`INSERT INTO schema_migrations (version, name, applied_at, app_version) VALUES (1, 'baseline', NULL, NULL)`)
}
