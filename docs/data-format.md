# Data format specification

This document is the long-term contract for everything Moliya stores. It is written so that someone with only this file, a copy of a backup, and the password can recover the data in ten years, with or without the app. Code references are for maintainers; the formats themselves do not depend on them.

## The guarantee

Every vault and backup written by any released version of Moliya, starting with 1.0.0, must open with the exact same records and totals in every later version, for at least ten years from the release that wrote it. The rules that enforce this are in [Compatibility rules](#compatibility-rules), and the tests that check it are described in [Golden fixtures](#golden-fixtures).

## Version matrix

Three formats are versioned independently of the app version. A change to one does not force a change to the others.

| App release | Vault record (IndexedDB) | Backup file (`.moliya`) | SQLite schema (`PRAGMA user_version`) | KDF for new passwords |
| --- | --- | --- | --- | --- |
| 1.0.0 | 1 | 1 | 1 (stored as `user_version = 0`) | PBKDF2-SHA-256, 200,000 iterations |
| 1.1.0 | 2 | 2 | 2 | PBKDF2-SHA-256, 600,000 iterations |

1.1.0 reads every row above it. Readers never lose support for a version once it has been released.

The constants live in `src/db/versions.ts`. The KDF parameters live in `src/crypto/crypto.service.ts`.

## Layers

```text
.moliya backup file (JSON, UTF-8)          IndexedDB record (structured clone)
  ├─ metadata: format, versions, dates        ├─ same metadata
  ├─ wraps[]: one per user                    ├─ wraps[] with ArrayBuffers
  │    KDF(password, salt) = KEK              │
  │    AES-GCM(KEK).decrypt(wrappedDek) = DEK │
  └─ body: AES-GCM(DEK).decrypt = SQLite file └─ body
```

A backup and an IndexedDB record carry the same information. The backup uses base64 text for binary fields; IndexedDB stores `ArrayBuffer`s.

## Cryptography

All algorithms are from the W3C Web Crypto API and are available natively in every browser and in Node.js.

| Step | Algorithm | Parameters |
| --- | --- | --- |
| Password to key-encryption key (KEK) | PBKDF2 | Password as UTF-8 bytes, no normalisation. Salt from the wrap (16 to 64 bytes; 32 in practice). Hash and iteration count from the wrap. Output: 256 bits. |
| Unwrap the data key (DEK) | AES-256-GCM | Key: KEK. IV: the wrap's 12-byte `iv`. Ciphertext: the wrap's 48-byte `wrappedDek` (32-byte raw key + 16-byte tag). No additional data. The plaintext is the raw 32-byte DEK. |
| Decrypt the database | AES-256-GCM | Key: DEK. IV: `body.iv` (12 bytes). Ciphertext: `body.ciphertext` (database + 16-byte tag). No additional data. The plaintext is a complete SQLite 3 database file. |

Readers accept any KDF parameter set in these bounds, so a file written with stronger settings in the future, or older weaker ones, still opens:

- `name`: `PBKDF2`
- `hash`: `SHA-256`, `SHA-384`, or `SHA-512`
- `iterations`: an integer from 100,000 to 10,000,000

Anything outside the bounds is rejected as damaged, which also stops a tampered file from forcing a trivially weak or a denial-of-service iteration count.

When a person signs in with a wrap weaker than the current setting, the app wraps the same DEK again with a fresh salt and the current KDF, checks that the new wrap opens, saves it, and writes a `CREDENTIALS_UPGRADED` audit entry. Other people's wraps are upgraded when they next sign in. The DEK and the database ciphertext do not change, so nothing is re-encrypted and older backups keep opening with the passwords that were valid when they were made.

The `users.password_hash` column holds the hex encoding of the same 256 PBKDF2 bits that form the KEK. Treat it as secret. Exports blank it (see [Exports](#exports)).

## Backup file

A `.moliya` file is a single JSON object encoded as UTF-8. Readers must ignore unknown fields. Binary fields are standard base64 with padding (RFC 4648 section 4).

### Backup version 2 (written by 1.1.0)

```json
{
  "format": "moliya-vault",
  "version": 2,
  "appVersion": "1.1.0",
  "schemaVersion": 2,
  "createdAt": "2026-09-29T08:57:57.997Z",
  "updatedAt": "2026-09-29T08:57:58.202Z",
  "exportedAt": "2026-09-29T08:57:58.202Z",
  "cipher": { "name": "AES-GCM", "length": 256 },
  "wraps": [
    {
      "userId": "a8d8525b-009e-4bef-8014-94805d499726",
      "email": "admin@ledger.test",
      "kdf": { "name": "PBKDF2", "hash": "SHA-256", "iterations": 600000 },
      "salt": "<base64, 32 bytes>",
      "iv": "<base64, 12 bytes>",
      "wrappedDek": "<base64, 48 bytes>"
    }
  ],
  "body": { "iv": "<base64, 12 bytes>", "ciphertext": "<base64>" }
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `format` | string | Always `moliya-vault`. |
| `version` | integer | Backup format version. |
| `appVersion` | string | SemVer of the release that wrote the file. |
| `schemaVersion` | integer | SQLite schema version inside `body`. |
| `createdAt` | string or null | ISO 8601 UTC time the vault was first created, when known. |
| `updatedAt` | string | ISO 8601 UTC time of the last save. |
| `exportedAt` | string | ISO 8601 UTC time the file was downloaded. |
| `cipher` | object | Body cipher. Only `AES-GCM` with `length` 256 exists. |
| `wraps[]` | array | One entry per person. `email` is lower case and unencrypted. `kdf` is per wrap. |
| `body` | object | Encrypted SQLite database. |

### Backup version 1 (written by 1.0.0)

```json
{
  "format": "moliya-vault",
  "version": 1,
  "kdf": { "name": "PBKDF2", "hash": "SHA-256", "iterations": 200000 },
  "wraps": [{ "userId": "…", "email": "…", "salt": "…", "iv": "…", "wrappedDek": "…" }],
  "payload": { "iv": "…", "ciphertext": "…" }
}
```

Differences from version 2: one `kdf` for all wraps at the top level (if absent, it is PBKDF2-SHA-256 with 200,000 iterations); the body is called `payload`; there are no `appVersion`, `schemaVersion`, dates, or `cipher`. The schema inside is version 1 and the writer is 1.0.0.

## IndexedDB record

| Item | Value |
| --- | --- |
| Database | `moliya`, IndexedDB version 1 |
| Object store | `vault` (out-of-line keys) |
| Current vault | key `primary` |
| Earlier copies | keys `archive:<ISO 8601 time>:<reason>`, at most 3, oldest removed first |

The record under `primary` has the same fields as the backup of the same version, except that binary fields are `ArrayBuffer`s, there is no `format` or `exportedAt`, and it has `id: "primary"`. Version 1 records also carry `updatedAt`. Version 2 records rename `payload` to `body` on purpose: 1.0.0 reads `record.payload.iv`, so if an old cached copy of the app meets a version 2 record it fails with an error screen instead of misreading or overwriting it.

Archive entries have the shape `{ key, reason, archivedAt, archivedBy, sourceVersion, sourceAppVersion, sourceUpdatedAt, raw }`, where `raw` is the untouched record as it was stored before the change. `reason` is `upgrade` (written in the same IndexedDB transaction as the first save after a format upgrade) or `import` (written in the same transaction as an imported backup replaces the vault). The Backup page offers each archive as a download; a version 1 archive downloads as a byte-for-byte version 1 backup.

Writes are compare-and-swap: a save only succeeds if `updatedAt` in IndexedDB is still the value the session loaded. Otherwise the app stops saving and asks the person to lock and unlock. A Web Lock named `moliya-vault-session` allows only one unlocked session per browser profile.

## SQLite database

The body decrypts to a standard SQLite 3 database file. Open it with any SQLite 3 tool.

### Schema version detection

- `PRAGMA user_version` greater than 0: that is the schema version.
- `user_version = 0` and a `transactions` table exists: schema version 1 (1.0.0 never set `user_version`).
- `user_version = 0` and no tables: an empty database, which is built by running every migration from the start.

### Schema version 2 (1.1.0)

Tables unchanged from version 1: `roles`, `groups`, `users`, `categories`, `settings`.

| Table | Purpose and notable columns |
| --- | --- |
| `transactions` | `id` (UUID text), `type` (`INCOME` or `EXPENSE`), `amount_minor` (integer > 0, the amount in the currency's minor unit), `currency` (ISO 4217 code, references `currencies`), `category_id`, `user_id`, `group_id`, `transaction_date` (`YYYY-MM-DD`, no time zone), `notes`, `receipt_data` (data URL or null), `created_at` and `updated_at` (ISO 8601 UTC). |
| `currencies` | `code`, `minor_unit` (ISO 4217 exponent). A frozen local copy, so the meaning of `amount_minor` never depends on an outside table. Currently USD, UZS, EUR, RUB, all with exponent 2. |
| `audit_logs` | Append-only, hash-chained log: `seq` (1, 2, 3, …), `id`, `actor_id`, `action`, `entity_type`, `entity_id`, `details` (JSON text), `created_at` (ISO 8601 UTC), `prev_hash`, `hash`. Triggers reject `UPDATE` and `DELETE`. |
| `schema_migrations` | `version`, `name`, `applied_at`, `app_version` for each migration applied to this database. Version 1 is recorded with null time when the database came from 1.0.0. |
| `settings` | Key-value text: `vault_name`, `currency` (vault currency), `vault_created_at`, `last_backup_at`. |

Money: the decimal amount is `amount_minor / 10^minor_unit` in `currency`. Amounts are never stored as floating point. Totals are computed as integer sums per currency. Records in different currencies are never added together; the dashboard totals only the vault currency and lists other currencies separately.

The schema uses `CHECK` constraints instead of SQLite `STRICT` tables so that older SQLite tools (before 3.37) can still read the file.

Audit chain: for each row, `hash = hex(SHA-256(UTF-8(JSON.stringify([seq, id, actor_id, action, entity_type, entity_id, details, created_at, prev_hash]))))`, where nulls are JSON `null` and the rest are strings except `seq`. The first row's `prev_hash` is 64 zeros, and each later row's `prev_hash` is the previous row's `hash`. If any row is changed, removed, or reordered outside the app, recomputing the chain fails at that row. The Audit page shows the result.

Audit `details` for records: `TRANSACTION_CREATED` stores a snapshot of the record, `TRANSACTION_UPDATED` stores `{ before, after }`, and `TRANSACTION_DELETED` stores the full snapshot of what was deleted. Snapshots use `type`, `amountMinor`, `currency`, `date`, `categoryId`, `groupId`, and `notes`; receipts are not copied into the log.

### Schema version 1 (1.0.0)

Same tables as version 2 without `currencies` and `schema_migrations`, with these differences:

- `transactions.amount` is `REAL` (a binary floating-point number of major units, rounded to 2 decimals with `Math.round(x * 100) / 100` before saving), and `currency` defaults to `USD`.
- `audit_logs` has no `seq`, `prev_hash`, or `hash`, and `created_at` defaults to SQLite `CURRENT_TIMESTAMP` (`YYYY-MM-DD HH:MM:SS`, UTC).

### Migration 1 → 2

Runs inside one SQLite transaction. If any step fails, the database is left exactly as it was and the app shows an error without saving.

1. Create `currencies`.
2. Rebuild `transactions` with `amount_minor`. Each 1.0.0 amount is converted by taking its value to 15 significant digits (the precision a double reliably holds) and rounding half to even to the currency exponent. Every value 1.0.0 could have written with up to 13 digits before the decimal point converts exactly; for example `19.99` becomes `1999` and `2.68` becomes `268`. A record with an unknown currency or a non-positive amount stops the migration.
3. Rebuild `audit_logs` with the hash chain, filling `seq` in the original insertion order.
4. Create `schema_migrations`, then check foreign keys, set `user_version = 2`, and run `PRAGMA quick_check`.

## Compatibility rules

1. **Readers are forever.** Code that reads a released record, backup, or schema version is never removed. A new version adds a branch; it does not replace one.
2. **Migrations are forward-only and ordered.** Each has a number, runs in its own transaction, and is recorded in `schema_migrations`. A released migration is never edited.
3. **Refuse newer data.** If a record, backup, or schema is newer than the running build supports, the app refuses to open or overwrite it and says so (`FORMAT_TOO_NEW`). The data is left untouched.
4. **Keep the previous state.** The first save after an upgrade, and every import, keeps the replaced record as an archive in the same IndexedDB transaction.
5. **Fixtures are immutable.** Every released format has a golden backup produced by that release. Fixtures are never edited or deleted.
6. **Old passwords keep working.** KDF parameters are stored per wrap and accepted within the bounds above. Strengthening happens by re-wrapping on sign-in, never by rejecting old parameters.
7. **Open formats only.** The payload is a plain SQLite file (a Library of Congress preferred format for datasets), wrapped in documented Web Crypto primitives, inside JSON.

## Golden fixtures

`tests/fixtures/backups/` holds real backups written by each release, with their passwords and expected contents. `MANIFEST.json` lists them; `SHA256SUMS` in each folder pins their bytes. `tests/unit/fixtures.test.ts` imports each one with the current code, runs all migrations, signs in as every person, and compares every record and the dashboard totals. It fails if a fixture file changes or disappears, or if any record, backup, or schema version from 1 to the current one has no fixture. `tests/e2e/upgrade.spec.ts` loads the exact IndexedDB record 1.0.0 stored into a real browser and signs in with the new build.

| Fixture | Written by | Covers |
| --- | --- | --- |
| `v1/household-usd` | 1.0.0 | Record/backup/schema 1, three roles, two groups, custom category, USD/UZS/EUR, float edge cases (`0.1`, `1.005`, `2.675`, `999999.99`), receipt, edited and deleted records |
| `v1/business-uzs` | 1.0.0 | Single admin with a non-ASCII password, vault currency switched from USD to UZS |
| `v2/ledger-v2` | 1.1.0 | Record/backup/schema 2, 600,000-iteration wraps, comma decimals, grouped digits, the largest accepted amount, hash-chained audit log |

## Exports

Exports are one-way copies for other apps. They cannot be imported; the `.moliya` backup stays the only format that restores a vault. All export formats share **export format version 1** (`EXPORT_FORMAT_VERSION` in `src/db/versions.ts`, first written by 1.3.0). Vault, backup, and schema versions are not affected by exports.

Only Admins can export (`EXPORT_VAULT`). Each export writes one `DATA_EXPORTED` audit entry **before** the files are generated, with details `{ formats, protection, scope: { from, to, groupId }, includesAudit, includesReceipts, counts }`. It never contains record content or the export password. Rows written by 1.1.0's unencrypted export keep their `PLAINTEXT_EXPORTED` action. Exports do not reset the backup reminder.

### Scope

- **Period**: all data, or an inclusive `from`–`to` range on `transaction_date`. The audit log is filtered on the UTC date of `created_at`.
- **Group**: all groups or one group. With one group, people outside it appear only if they recorded a transaction in it, and their `group_id` is blank.
- **Audit log**: optional; requires `READ_AUDIT` and all groups, because audit details snapshot records of every group. `auditFirstSeq`/`auditLastSeq` in the metadata let a reader verify the hash chain starting from the first exported row's `prevHash`.
- **Receipts**: off by default. When off, `receipt` is `null` and SQLite `receipt_data` is `NULL`; `hasReceipt` still says whether one exists.
- **Never exported**: private safes (tables, metadata, and encrypted contents), password hashes and salts, key wraps, sign-in check secrets, access codes, and any table not on the allowlist below.

### Files

A single file downloads as-is; several files (or any encrypted choice) download as one ZIP with a `README.txt`. The downloaded name is `<app>-<vault>-<yyyy-mm-dd>.<ext>`, `…-encrypted.zip`, or `…-encrypted.sqlite`. `<vault>` is the vault name normalised to NFC, with `\/:*?"<>|`, control characters, and whitespace replaced by `-`, at most 48 characters, falling back to `vault`. The vault name is therefore visible in the file name even for encrypted exports.

| Inner file | Format |
| --- | --- |
| `transactions.csv` | RFC 4180, UTF-8 with byte order mark, CRLF, comma separator, dot decimals. Columns (only ever appended): `id, date, type, category, amount, currency, amount_minor, minor_unit, group, recorded_by, notes, has_receipt, created_at, updated_at, category_id, group_id, user_id`. |
| `audit-log.csv` | Same CSV rules. Columns: `seq, id, actor_id, actor_email, action, entity_type, entity_id, details, created_at, prev_hash, hash`. |
| `*.json` | One JSON document, `"format": "moliya-export"`, `"formatVersion": 1`. Schema: [moliya-export-1.schema.json](schemas/moliya-export-1.schema.json) (JSON Schema 2020-12). |
| `*.jsonl` | UTF-8 JSON Lines, no byte order mark, `\n` separators. First line `{"type":"header",…}` with the same metadata as JSON, then `currency`, `group`, `user`, `category`, `transaction`, and `audit` records as `{"type":…,"data":…}`, then `{"type":"footer","counts":{…}}` so truncation is detectable. Schema: [moliya-export-1.record.schema.json](schemas/moliya-export-1.record.schema.json). |
| `*.xlsx` | Sheets Summary, Records, Categories, Groups, People, Audit log (optional), About. Transaction dates are real date cells (`yyyy-mm-dd`, written as UTC midnight so they do not shift by time zone); `amount` is a number with `#,##0.00`; `amount_minor` is the exact integer. Text that looks like a formula is stored as text. |
| `report.pdf` | A4 report: header, totals per currency (vault currency first), expenses by category, monthly table, and up to 10,000 records. Embedded Noto Sans subset. No PDF password (jsPDF only offers RC4). |
| `*.sqlite` | Plain SQLite 3, see below. |

**Money** is always exact: an integer `amountMinor`/`amount_minor` in the currency's minor unit plus a decimal string `amount`, never a float. Totals are summed with `BigInt`. Audit `details` is the original JSON text, so the hash chain can be recomputed from the export.

**CSV formula protection** (OWASP): a text cell whose first non-space character is `=`, `+`, `-`, `@`, tab, CR, LF, or a full-width `＝＋－＠` gets a leading `'`. Numeric columns are never prefixed. Excel may drop the `'` after a save and reopen; use JSON, JSON Lines, or SQLite when exact data matters.

### SQLite export

The file is built fresh, not copied: a new database attaches the vault as `src` and copies only an allowlist with `INSERT … SELECT`, applying the scope filters.

- Tables: `roles, groups, users, categories, currencies, transactions, schema_migrations`, `settings` (keys `vault_name`, `currency`, `vault_created_at` only), and `audit_logs` when the audit log is included. Table definitions, indexes, and triggers come from `src.sqlite_schema`. Columns that the exporter does not know are written as `NULL`.
- `users.password_hash` and `users.salt` are `''`.
- An `export_info (key, value)` table holds the export metadata. `PRAGMA application_id = 0x4D4C5941` ("MLYA"); `user_version` is the vault's schema version.
- Page size 4096 bytes; 80 reserved bytes per page when the file is going to be encrypted.

### Encrypted outputs

**AES-256 ZIP** (default): WinZip AE-2 entries (extra field `0x9901`, strength 3) written by zip.js. The ZIP key derivation is PBKDF2-HMAC-SHA1 with 1,000 iterations (fixed by the WinZip spec), and entry names and sizes are visible without the password. Opens in 7-Zip, WinZip, WinRAR, and Keka, but not in the built-in Windows or macOS archive tools.

**SQLCipher 4** (`…-encrypted.sqlite`): only the SQLite export, encrypted in the browser with Web Crypto to SQLCipher 4 defaults:

1. The plain file must have 4096-byte pages, 80 reserved bytes, and the legacy journal format (header bytes 18 and 19 are 1).
2. A random 16-byte salt is written to bytes 0–15.
3. Key = PBKDF2-HMAC-SHA512(password, salt, 256,000 iterations, 32 bytes). HMAC key = PBKDF2-HMAC-SHA512(key, salt XOR `0x3a` on every byte, 2 iterations, 32 bytes).
4. Each page *n* (1-based): AES-256-CBC with a random 16-byte IV over bytes [16 on page 1, else 0, 4016); the IV is stored at 4016, then HMAC-SHA512(ciphertext ‖ IV ‖ *n* as 4-byte little-endian) at 4032.

It opens in DB Browser for SQLite ("SQLCipher 4 defaults"), `sqlcipher` (`PRAGMA key = '…'`), and SQLite3 Multiple Ciphers (`cipher=sqlcipher; legacy=4`).

**Export passwords** (both encrypted outputs; enforced by the service): at least 14 printable ASCII characters, a strength estimate of at least "fair", and not the current user's sign-in password (checked by trying to unwrap the vault key with it). The built-in generator makes 6 groups of 4 characters from a 32-character alphabet (120 bits). Passwords are never stored or audited.

## Recovering data without the app

`tools/moliya-decrypt.mjs` needs only Node.js 22 or newer (22.13+ to blank password material automatically):

```bash
node tools/moliya-decrypt.mjs backup.moliya --list
MOLIYA_PASSWORD='…' node tools/moliya-decrypt.mjs backup.moliya --email admin@example.com --out ledger.sqlite
sqlite3 ledger.sqlite "SELECT transaction_date, type, amount_minor / 100.0, currency, notes FROM transactions ORDER BY 1"
```

For schema version 1 files the amount column is `amount` instead of `amount_minor`. The tool is about 200 lines of dependency-free JavaScript and doubles as a reference implementation of this document. Any language with PBKDF2 and AES-GCM can do the same in three steps: derive the KEK, decrypt `wrappedDek` to get the DEK, decrypt `body.ciphertext`.

## Changing a format

1. Bump the relevant constant in `src/db/versions.ts`. Add a migration file for schema changes (`src/db/migrations/000N-name.ts`) and append it to `MIGRATIONS`.
2. Add a reader branch for the new record or backup version; keep every existing branch.
3. Release, then generate a fixture with the released code (`tools/fixtures/<version>/generate.gen.ts`, run with `npm run fixtures:generate -- tools/fixtures/<version>`), add it to `MANIFEST.json`, and commit it with its `SHA256SUMS`.
4. Update the version matrix and the relevant sections above, and the CHANGELOG.
