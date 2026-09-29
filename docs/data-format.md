# Data format specification

This document is the long-term contract for everything Jaybi stores. It is written so that someone with only this file, a copy of a backup, and the password can recover the data in ten years, with or without the app. Code references are for maintainers; the formats themselves do not depend on them.

## Names

**Why files still say moliya.** The product was renamed Jaybi in 1.3.0; the on-disk and cryptographic identifiers keep the historical 'moliya' name forever. That covers the format ids (`moliya-vault`, and `moliya-export` for exports with its schema files in `docs/schemas/`), the IndexedDB database `moliya`, the Web Lock `moliya-vault-session`, local storage keys `moliya.*`, the `.moliya` file extension and the `moliya-backup-YYYY-MM-DD.moliya` and `moliya-archive-YYYY-MM-DD.moliya` file names, every HKDF `info` string and AAD label (`moliya/…`, `moliya.…`), the throttle hash prefix `moliya-throttle|`, the golden fixtures, and the recovery tool `tools/moliya-decrypt.mjs` with its `MOLIYA_PASSWORD` variable, and the npm package name `moliya`. Changing any of them would stop existing vaults and backups from opening, or break scripts that rely on them. Only text shown to people, release zips (`jaybi-X.Y.Z.zip` from 1.3.0), and export file names (`jaybi-…`) use the new name.

## The guarantee

Every vault and backup written by any released version of the app (named Moliya up to 1.2.0, Jaybi from 1.3.0), starting with 1.0.0, must open with the exact same records and totals in every later version, for at least ten years from the release that wrote it. The rules that enforce this are in [Compatibility rules](#compatibility-rules), and the tests that check it are described in [Golden fixtures](#golden-fixtures).

## Version matrix

Three formats are versioned independently of the app version. A change to one does not force a change to the others.

| App release | Vault record (IndexedDB) | Backup file (`.moliya`) | SQLite schema (`PRAGMA user_version`) | KDF for new passwords |
| --- | --- | --- | --- | --- |
| 1.0.0 | 1 | 1 | 1 (stored as `user_version = 0`) | PBKDF2-SHA-256, 200,000 iterations |
| 1.1.0 | 2 | 2 | 2 | PBKDF2-SHA-256, 600,000 iterations |
| 1.2.0 | 2 | 2 | 3 | PBKDF2-SHA-256, 600,000 iterations |
| 1.3.0 | 2 | 2 | 4 | PBKDF2-SHA-256, 600,000 iterations |
| 1.3.1 | 2 | 2 | 4 | PBKDF2-SHA-256, 600,000 iterations |

1.3.0 and 1.3.1 read every row above them: record and backup versions 1–2 and schema versions 1–4. It writes record 2, backup 2, and schema 4. Readers never lose support for a version once it has been released. Private safes (1.2.0) live inside the encrypted database, so they changed only the schema version; the record and backup formats are the same as in 1.1.0. One-time codes and the sign-in check (1.3.0) add two tables (schema 4) and an optional `grants` field to the record and backup; the record and backup version numbers stay at 2 (see [One-time code wraps](#one-time-code-wraps-grants)). Because the backup carries `schemaVersion`, 1.1.0 refuses a 1.2.0 vault or backup, and 1.1.0 and 1.2.0 refuse a 1.3.0 one, with `FORMAT_TOO_NEW` instead of misreading it. The data is left untouched.

The constants live in `src/db/versions.ts`. The KDF parameters live in `src/crypto/crypto.service.ts`.

## Layers

```text
.moliya backup file (JSON, UTF-8)          IndexedDB record (structured clone)
  ├─ metadata: format, versions, dates        ├─ same metadata
  ├─ wraps[]: one per user                    ├─ wraps[] with ArrayBuffers
  │    KDF(password, salt) = KEK              │
  │    AES-GCM(KEK).decrypt(wrappedDek) = DEK │
  ├─ grants[] (optional, 1.3.0): one per open ├─ grants[] with ArrayBuffers
  │    invite or reset code                   │
  └─ body: AES-GCM(DEK).decrypt = SQLite file └─ body
              ├─ private safe tables (schema 3): a second layer, encrypted with each owner's own keys
              └─ user_totp (schema 4): sign-in check secrets, encrypted with each owner's own password
```

A backup and an IndexedDB record carry the same information. The backup uses base64 text for binary fields; IndexedDB stores `ArrayBuffer`s. Anyone who can decrypt the body can read the ledger, but not the private safe rows or the sign-in check secrets inside it; those need the owner's password (or, for safes, the recovery code). See [Private safes](#private-safes) and [Sign-in check](#sign-in-check-user_totp).

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
- `iterations`: an integer from 100,000 to 2,000,000 in the app from 1.3.0 (10,000,000 in 1.1.0 and 1.2.0). The recovery tool accepts up to 10,000,000.

Anything outside the bounds is rejected as damaged, which also stops a tampered file from forcing a trivially weak or a denial-of-service iteration count. Every released version wrote 200,000 or 600,000, so the lower app ceiling rejects no real file. The same bounds apply to `grants[]`, `user_keys.kdf`, and `user_totp.kdf`.

When a person signs in with a wrap weaker than the current setting, the app wraps the same DEK again with a fresh salt and the current KDF, checks that the new wrap opens, saves it, and writes a `CREDENTIALS_UPGRADED` audit entry. Other people's wraps are upgraded when they next sign in. The DEK and the database ciphertext do not change, so nothing is re-encrypted and older backups keep opening with the passwords that were valid when they were made.

### Password verifier (`users.password_hash`)

Sign-in never compares `users.password_hash`; it succeeds only if the wrap unwraps and the body decrypts. The column is kept as a verifier and nothing derives keys from it.

| Schema | Value |
| --- | --- |
| 1 and 2 (1.0.0, 1.1.0) | Lower-case hex of the raw 256 PBKDF2 bits, which are the KEK itself. Anyone who reads the decrypted database can unwrap that person's `wrappedDek` without the password. |
| 3 and later (1.2.0+) | Empty string after migration 3, until the person's next successful sign-in. Then `hex(HKDF-SHA-256(ikm = raw PBKDF2 bits, salt = empty, info = UTF-8 "moliya/verifier/v1"))`: 256 bits, 64 lower-case hex characters, no prefix. The empty salt is HKDF's default of 32 zero bytes. Written without an audit entry. New, reset, and changed passwords store this form directly. |

Whenever the stored value is not the verifier (a pre-1.2.0 raw value, or the empty string left by migration 3), sign-in also wraps the same DEK again under a fresh salt with the current KDF, exactly like a KDF upgrade but without an audit entry when the KDF parameters do not change. A KEK-equal value read before that sign-in therefore no longer opens the stored wrap. Backups and archives written by 1.0.0 and 1.1.0 still contain the old KEK-equal values together with the old wraps they open. Exports blank the column (see [Exports](#exports)).

## Backup file

A `.moliya` file is a single JSON object encoded as UTF-8. Readers must ignore unknown fields. Binary fields are standard base64 with padding (RFC 4648 section 4).

### Backup version 2 (written by 1.1.0 and later)

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
| `schemaVersion` | integer | SQLite schema version inside `body` (2 from 1.1.0, 3 from 1.2.0, 4 from 1.3.0). |
| `createdAt` | string or null | ISO 8601 UTC time the vault was first created, when known. |
| `updatedAt` | string | ISO 8601 UTC time of the last save. |
| `exportedAt` | string | ISO 8601 UTC time the file was downloaded. |
| `cipher` | object | Body cipher. Only `AES-GCM` with `length` 256 exists. |
| `wraps[]` | array | One entry per person. `email` is lower case and unencrypted. `kdf` is per wrap. |
| `grants[]` | array, optional | One entry per open invite or reset code (1.3.0). Present only when there is at least one. See [One-time code wraps](#one-time-code-wraps-grants). |
| `body` | object | Encrypted SQLite database. |

### One-time code wraps (`grants`)

From 1.3.0 an Admin can issue one-time invite and reset codes. Each open code adds one entry to `grants[]`, which wraps the same DEK under a key derived from the code instead of a password:

```json
"grants": [
  {
    "id": "5449265d-8332-4209-a884-1ecfb516de6c",
    "kind": "INVITE",
    "email": "late@access.test",
    "kdf": { "name": "PBKDF2", "hash": "SHA-256", "iterations": 600000 },
    "salt": "<base64, 32 bytes>",
    "iv": "<base64, 12 bytes>",
    "wrappedDek": "<base64, 48 bytes>"
  }
]
```

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | UUID, equal to `access_grants.id` in the database. |
| `kind` | string | `INVITE` (a new person joins) or `RESET` (an existing person sets a new password). |
| `email` | string | Lower case, unencrypted, at most 254 characters. |
| `kdf` | object | PBKDF2 parameters, same bounds as wraps. 1.3.0 writes PBKDF2-SHA-256 with 600,000 iterations. |
| `salt` | base64 | 16 to 64 bytes (32 in practice). |
| `iv` | base64 | 12 bytes. |
| `wrappedDek` | base64 | 48 bytes: the raw DEK wrapped with AES-256-GCM. |

Grants live in their own array rather than in `wraps[]` on purpose: older recovery tools pick the first wrap whose email matches, so a reset grant for the same email could otherwise hide the person's real wrap. Older readers ignore the unknown `grants` key. The key derivation and the additional data are in [One-time codes](#one-time-codes). The app removes a grant from the array when its code is used, revoked, or replaced, and at the first sign-in after it expires.

### Reader limits

From 1.3.0 the app refuses a backup file larger than 72 MiB before reading it, and refuses as damaged a backup whose JSON nests deeper than 8 levels or has a key named `__proto__`, `constructor`, or `prototype` anywhere. It refuses a backup or a stored record, as damaged, when:

- `wraps[]` is empty or has more than 256 entries, or `grants[]` has more than 64;
- a salt is outside 16–64 bytes, an IV is not 12 bytes, a wrapped key is not 48 bytes, or `body.ciphertext` is shorter than 17 bytes or longer than 64 MiB;
- a KDF parameter set is outside the bounds in [Cryptography](#cryptography).

The limits leave room for every vault the app can create: the decrypted database is capped at 48 MiB (see [Size limits](#size-limits)).

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

The record under `primary` has the same fields as the backup of the same version, including the optional `grants`, except that binary fields are `ArrayBuffer`s, there is no `format` or `exportedAt`, and it has `id: "primary"`. Version 1 records also carry `updatedAt`. Version 2 records rename `payload` to `body` on purpose: 1.0.0 reads `record.payload.iv`, so if an old cached copy of the app meets a version 2 record it fails with an error screen instead of misreading or overwriting it.

Archive entries have the shape `{ key, reason, archivedAt, archivedBy, sourceVersion, sourceAppVersion, sourceUpdatedAt, raw }`, where `raw` is the untouched record as it was stored before the change. `reason` is `upgrade` (written in the same IndexedDB transaction as the first save after a format upgrade) or `import` (written in the same transaction as an imported backup replaces the vault; from 1.3.0 the archived copy is sealed after a `VAULT_REPLACED_BY_IMPORT` audit entry is written into it). The Backup page offers each archive as a download; a version 1 archive downloads as a byte-for-byte version 1 backup.

Writes are compare-and-swap: a save only succeeds if `updatedAt` in IndexedDB is still the value the session loaded. Otherwise the app stops saving and asks the person to lock and unlock. A Web Lock named `moliya-vault-session` allows only one unlocked session per browser profile.

## SQLite database

The body decrypts to a standard SQLite 3 database file. Open it with any SQLite 3 tool.

### Schema version detection

- `PRAGMA user_version` greater than 0: that is the schema version.
- `user_version = 0` and a `transactions` table exists: schema version 1 (1.0.0 never set `user_version`).
- `user_version = 0` and no tables: an empty database, which is built by running every migration from the start.

The connection runs with `PRAGMA foreign_keys = ON` and, from 1.2.0, `PRAGMA secure_delete = ON`, so deleted rows are overwritten with zeros in the database file instead of lingering in free pages.

From 1.3.0 every database the app opens, new or decrypted, is also hardened: `SQLITE_DBCONFIG_DEFENSIVE` on, `trusted_schema` off, `cell_size_check` on, strings and blobs limited to 8 MiB, and `ATTACH` disabled (one attach slot is opened only while `VACUUM` runs). Before migrating, the app compares `sqlite_master` with the exact set of tables, indexes, triggers, and views that its own migrations create for the stored schema version, and compares the SQL of every trigger and view. An unknown, missing, or changed object stops the unlock with `SCHEMA_UNKNOWN`, shown as a damaged vault. The same check runs again after a migration, and `PRAGMA quick_check` runs on every open, even when no migration is needed. Other SQLite tools can still read the file normally.

### Size limits

From 1.3.0:

| Item | Limit |
| --- | --- |
| Decrypted database | 48 MiB. A new receipt that would push the database past it is refused (`VAULT_FULL`). The app warns from 36 MiB. |
| Receipt | 1.5 MB (1,572,864 bytes) decoded. Only `data:image/png`, `image/jpeg`, `image/webp`, or `image/gif` base64 data URLs whose first bytes match that type. SVG and anything else is refused. Receipts already stored by an earlier version are kept as they are. |
| Backup file | 72 MiB |
| Email | 254 characters |
| Password | 12 to 256 characters for new passwords (see below) |
| Vault name, group name, setup display name | 80 characters |
| Record notes | 2,000 characters |
| Open invite codes | 20 per vault, and at most 64 code wraps in the envelope |

New passwords must also not be on a list of common passwords (the SecLists 10k list, entries of 6 or more characters, plus the NCSC 100k list, entries of 12 or more characters, compared in lower case), not be built mainly from the email or the vault name, and not be a repetition or keyboard run. Existing passwords that do not meet this keep working.

### Schema version 4 (1.3.0)

Everything in version 3, plus two tables and one settings key. Nothing existing changes.

```sql
CREATE TABLE access_grants (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('INVITE', 'RESET')),
  email TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  role_id INTEGER REFERENCES roles(id),
  group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  code_verifier TEXT NOT NULL,
  stop_old_password INTEGER NOT NULL DEFAULT 0 CHECK (stop_old_password IN (0, 1)),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ended_at TEXT,
  ended_reason TEXT CHECK (ended_reason IN ('USED', 'REVOKED', 'EXPIRED', 'REPLACED')),
  ended_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  CHECK (expires_at > created_at),
  CHECK ((kind = 'INVITE' AND role_id IS NOT NULL) OR (kind = 'RESET' AND user_id IS NOT NULL)),
  CHECK ((ended_at IS NULL) = (ended_reason IS NULL))
);
CREATE UNIQUE INDEX idx_grants_open_email ON access_grants(email) WHERE ended_at IS NULL;
CREATE INDEX idx_grants_expiry ON access_grants(expires_at);

CREATE TABLE user_totp (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enc_version INTEGER NOT NULL CHECK (enc_version = 1),
  kdf TEXT NOT NULL,
  kdf_salt TEXT NOT NULL,
  secret_iv TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL CHECK (length(secret_ciphertext) <= 1024),
  last_step INTEGER NOT NULL DEFAULT 0 CHECK (typeof(last_step) = 'integer' AND last_step >= 0),
  recovery_salt TEXT NOT NULL,
  recovery_hashes TEXT NOT NULL CHECK (length(recovery_hashes) <= 2048),
  created_at TEXT NOT NULL,
  rewrapped_at TEXT NOT NULL
);
```

`access_grants` holds one row per invite or reset code ever issued. An open code has `ended_at` null; the partial unique index allows one open code per email. `INVITE` rows carry the role and group the new person gets; `RESET` rows carry the person's `user_id`. `code_verifier` is 64 lower-case hex characters (see [One-time codes](#one-time-codes)); the code itself is never stored. `stop_old_password` is 1 when the Admin removed the person's own wrap at the time of issue. `ended_reason` is `USED`, `REVOKED`, `EXPIRED` (ended by the sweep at sign-in), or `REPLACED` (a newer code or a temporary password for the same person, or a temporary-password account for the same email, took its place). Rows are kept after they end, as history; removing a person deletes their `RESET` rows through the foreign key.

`user_totp` holds one row per person who turned on the sign-in check. The secret is encrypted with a key derived from that person's password only; see [Sign-in check](#sign-in-check-user_totp). `last_step` is the last accepted 30-second time step, and `recovery_hashes` is a JSON array of hex strings, one per unused recovery code.

New settings key: `clock_high_water`, the latest ISO 8601 UTC time at which this vault was saved (every seal stores `max(previous, now)`). Creating or using a code is refused with `CLOCK_BEHIND` when the device clock is more than 5 minutes earlier than it, so turning the clock back does not revive an expired code.

### Schema version 3 (1.2.0)

Everything in version 2, plus two columns on `users` and four tables for [private safes](#private-safes). The `transactions`, `audit_logs`, and other ledger tables are unchanged.

Changes to `users`:

| Column | Definition | Meaning |
| --- | --- | --- |
| `password_hash` | unchanged type | The HKDF verifier, or an empty string until the person's next sign-in (see [Password verifier](#password-verifier-userspassword_hash)). |
| `must_change_password` | `INTEGER NOT NULL DEFAULT 0`, `CHECK IN (0, 1)` | 1 when the current password was chosen by an Admin (new account or reset). The app sends the person to Account until they choose their own. Private safes refuse to set up or open while it is 1. |
| `password_changed_at` | `TEXT`, nullable | ISO 8601 UTC time the password was last set by an Admin or changed by its owner. Null means not changed since the vault was created or upgraded to 1.2.0. |

New tables. Every IV and ciphertext column holds standard base64 text with padding (the SQLite wrapper turns blobs into `null`, so no blobs are used). All timestamps are ISO 8601 UTC text.

| Table | Columns |
| --- | --- |
| `user_keys` | One row per person who set up safes. `user_id` (primary key, references `users`, cascade delete), `enc_version` (`CHECK = 1`), `kdf` (JSON `{ name, hash, iterations }`, same bounds as wraps), `kdf_salt` (32 bytes), `wrap_iv` and `wrapped_key` (the personal key wrapped under the password), `recovery_salt`, `recovery_iv`, and `recovery_wrapped_key` (all three null, or all three set: `CHECK`), `meta_iv` and `meta_ciphertext` (encrypted `UserSafeMeta`, at most 65,536 characters), `created_at`, `rewrapped_at` (when `wrapped_key` was last written). |
| `safes` | `id` (UUID, primary key), `owner_user_id` (references `users`, cascade delete), `enc_version` (`CHECK = 1`), `key_version` (integer ≥ 1), `key_iv` and `wrapped_key` (the safe key wrapped under the personal key), `meta_iv` and `meta_ciphertext` (encrypted `SafeMeta`, at most 8,192 characters), `deleted_at` (null, or when it was moved to the trash). `UNIQUE (id, owner_user_id)`. Index on `owner_user_id`. |
| `secure_items` | `id` (UUID, primary key), `safe_id`, `owner_user_id`, `enc_version` (`CHECK = 1`), `key_version` (integer ≥ 1, equal to the safe's), `rev` (integer ≥ 1, default 1, incremented on every rewrite for optimistic concurrency), `iv`, `ciphertext` (encrypted item, at most 65,536 characters), `deleted_at`. `FOREIGN KEY (safe_id, owner_user_id) REFERENCES safes(id, owner_user_id) ON DELETE CASCADE`, so an item's owner always matches its safe's owner. Indexes on `safe_id` and `owner_user_id`. |
| `safe_events` | The owner's activity list. `seq` (integer primary key, insertion order), `id` (UUID, unique), `owner_user_id` (references `users`, cascade delete), `iv`, `ciphertext` (encrypted `SafeEvent`, at most 4,096 characters). Index on `(owner_user_id, seq)`. The app keeps the newest 500 per owner. |

Only what the app needs without keys is stored in plaintext: owner, safe id, versions, `rev`, `deleted_at`, and the `user_keys` timestamps. Safe names, descriptions, icons, colours, the archived and password-each-time flags, order, default safe, preferences, item kinds, titles, every field, favourites, and item timestamps are encrypted.

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

### Migration 2 → 3

Migration 3 (`private-safes-and-verifier`, file `src/db/migrations/0003-private-safes.sql`) runs inside one SQLite transaction like every other step:

1. `ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1))`, so every existing person gets 0.
2. `ALTER TABLE users ADD COLUMN password_changed_at TEXT`, so every existing person gets null (their safes can never be stale on account of an earlier change).
3. `UPDATE users SET password_hash = ''`, removing the KEK-equal values from the database. Each person's next successful sign-in writes the HKDF verifier.
4. Create `user_keys`, `safes`, `secure_items`, and `safe_events` with their indexes, all empty.
5. Check foreign keys, set `user_version = 3`, record the step in `schema_migrations`, and run `PRAGMA quick_check`.

The record and backup envelopes are not touched. The first save after the upgrade keeps the untouched earlier record (1.0.0 or 1.1.0) as an `upgrade` archive, which still contains the old `password_hash` values.

### Migration 3 → 4

Migration 4 (`access-grants-and-sign-in-check`, file `src/db/migrations/0004-access-grants.sql`) creates `access_grants` with its two indexes and `user_totp`, all empty, then checks foreign keys, sets `user_version = 4`, records the step in `schema_migrations`, and runs `PRAGMA quick_check`. No existing row changes. The first save afterwards adds `clock_high_water` and keeps the untouched schema 3 record as an `upgrade` archive. Envelopes gain `grants[]` only when an Admin issues a code.

## Private safes

Private safes add a second layer of encryption inside the database. The DEK layer protects the whole file from outsiders; the safe layer protects one person's safes from everyone else who can decrypt the file, Admins included. The keys can only be derived with the owner's password or recovery code; nothing stored in the database is enough on its own. This section is enough to decrypt a safe with the owner's secrets and any Web Crypto implementation; the app has no command-line tool for it yet.

### Key hierarchy

```text
password ──PBKDF2(user_keys.kdf, salt = kdf_salt, 32 bytes)──► 256 bits
         ──HKDF-SHA-256(salt = empty, info = "moliya/personal-kek/v1")──► personal KEK
recovery code (15 bytes) ──HKDF-SHA-256(salt = recovery_salt, 16 bytes, info = "moliya/recovery-kek/v1")──► recovery KEK

personal KEK  ─┐
recovery KEK  ─┴─ AES-GCM unwrap ─► personal key (random AES-256, one per person)
                                      ├─ decrypts user_keys.meta_ciphertext   (UserSafeMeta)
                                      ├─ decrypts safe_events.ciphertext      (SafeEvent)
                                      └─ AES-GCM unwrap ─► safe key, version k (random AES-256, one per safe)
                                                            ├─ decrypts safes.meta_ciphertext   (SafeMeta)
                                                            └─ decrypts secure_items.ciphertext (item)
```

- The password is UTF-8 without normalisation, exactly as for the vault KEK. The PBKDF2 run is separate from the vault's: it uses its own salt (`user_keys.kdf_salt`) and parameters (`user_keys.kdf`, PBKDF2-SHA-256 with 600,000 iterations when written by 1.2.0, accepted within the same bounds as wraps). So the vault KEK, the stored verifier, and old `password_hash` values do not help to open safes.
- HKDF output is used directly as a 256-bit AES-GCM key. An empty HKDF salt is HKDF's default of 32 zero bytes.
- The recovery code is 15 random bytes (120 bits), used as HKDF input keying material.

### Encryption and AAD

Every encryption and every key wrap is AES-256-GCM with a fresh random 12-byte IV and a 16-byte tag, and with additional authenticated data (AAD). Wrapping is Web Crypto `wrapKey('raw', …)`: the plaintext is the 32-byte raw key and the stored ciphertext is 48 bytes.

The AAD is the UTF-8 encoding of a compact JSON array, `JSON.stringify([label, 1, ...parts])`, where `1` is `enc_version`. Strings are JSON strings and the key version is a JSON number. For example, item AAD looks like `["moliya.item",1,"<userId>","<safeId>","<itemId>",2]`.

| What | Key | Stored in | AAD |
| --- | --- | --- | --- |
| Personal key, password wrap | personal KEK | `user_keys.wrap_iv`, `wrapped_key` | `["moliya.pk",1,userId]` |
| Personal key, recovery wrap | recovery KEK | `user_keys.recovery_iv`, `recovery_wrapped_key` | `["moliya.pk-recovery",1,userId]` |
| User meta | personal key | `user_keys.meta_iv`, `meta_ciphertext` | `["moliya.user-meta",1,userId]` |
| Activity event | personal key | `safe_events.iv`, `ciphertext` | `["moliya.event",1,userId,eventId]` (`eventId` is `safe_events.id`) |
| Safe key | personal key | `safes.key_iv`, `wrapped_key` | `["moliya.safe-key",1,userId,safeId,keyVersion]` |
| Safe meta | safe key | `safes.meta_iv`, `meta_ciphertext` | `["moliya.safe-meta",1,userId,safeId,keyVersion]` |
| Item | safe key | `secure_items.iv`, `ciphertext` | `["moliya.item",1,userId,safeId,itemId,keyVersion]` |

`userId` is the owner's `users.id`. Because the AAD names the owner, the safe, the item, and the key version, a row copied to another person, safe, or item id fails to decrypt instead of being accepted.

JSON payloads (user meta, events, safe meta, items) are padded before encryption: `uint32 big-endian length ‖ UTF-8 JSON ‖ zero bytes`, up to the next multiple of 256 bytes. The padded plaintext may not exceed 32 KiB (32,768 bytes, including the 4-byte length). Readers check that the length fits and every padding byte is zero. The padding hides whether an item is a card, a subscription, or a short note: they all produce ciphertexts of the same size.

### Recovery code

The 15 bytes are read as one 120-bit big-endian integer and written as 24 Crockford base32 digits (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`), most significant first, followed by one check symbol: the integer modulo 37, taken from `0123456789ABCDEFGHJKMNPQRSTVWXYZ*~$=U`. The 25 characters are shown in groups of five joined by `-`, for example `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`. Input is upper-cased, spaces and dashes are removed, `O` becomes `0`, and `I` and `L` become `1`; a wrong length, an unknown character, or a wrong check symbol is rejected before any key is derived. The code itself is never stored. Creating a new code replaces the three `recovery_*` columns, so the old code stops working.

### Stale wraps and rewrapping

The safes are **stale** when `users.password_changed_at` is not null and `user_keys.rewrapped_at < users.password_changed_at` (comparison of the ISO 8601 strings). This happens after an Admin resets the password: the password wrap is still under the password the owner chose before the reset.

- The personal key is only ever unwrapped with a secret the owner chose: their own password, their previous own password, or the recovery code. The app never tries a password while `must_change_password = 1`.
- A stale wrap is opened with the previous password or the recovery code, and the current password must also be correct. The personal key is then wrapped again under the current password with a new `kdf_salt`, and `rewrapped_at` is set to now.
- When the owner changes their own password, was not in the must-change state, and the current password opens the wrap, the wrap is replaced in the same transaction and `rewrapped_at` equals the new `password_changed_at`, so it is not stale.
- When the wrap uses weaker KDF parameters than the current setting, it is rewrapped with the current ones on the next unlock.
- If the owner has neither the previous password nor the recovery code, the safes cannot be decrypted by anyone. "Reset private safes" deletes all their `safe_events`, `secure_items`, `safes`, and `user_keys` rows and creates a new personal key and one empty safe.

### Changing a safe key, moving, and copying

Changing a safe's encryption key creates a new random safe key at `key_version + 1`, decrypts the safe meta and every item in the safe (trashed ones included), encrypts them again under the new key with the new version in the AAD, and writes all rows in one transaction. Moving an item decrypts it with the source safe key and encrypts it under the target safe key and AAD, keeping the item id. Copying does the same with a new item id and new timestamps.

### Payloads

Every payload is a JSON object with `v: 1`. Readers must ignore unknown fields.

`UserSafeMeta` (in `user_keys`):

```json
{
  "v": 1,
  "order": ["<safeId>", "<safeId>"],
  "defaultSafeId": "<safeId>",
  "autoLockMinutes": 5,
  "clipboardSeconds": 30,
  "revealSeconds": 15
}
```

`autoLockMinutes` is 1, 5, 15, or 30; `clipboardSeconds` is 10, 30, or 60; `revealSeconds` is 15, 30, or 60. Unknown values fall back to the defaults shown. Since 1.3.1 `autoLockMinutes` is ignored (safes lock with the vault) but still validated and written back unchanged, so older versions keep reading it.

`SafeMeta` (in `safes`):

```json
{
  "v": 1,
  "name": "Personal",
  "description": "",
  "icon": "vault",
  "color": "pine",
  "archived": false,
  "requirePassword": false,
  "createdAt": "2026-09-29T09:00:00.000Z",
  "updatedAt": "2026-09-29T09:00:00.000Z"
}
```

`icon` is one of `vault`, `credit-card`, `wallet`, `briefcase`, `home`, `plane`, `heart`, `shield`. `color` is one of `pine`, `brass`, `clay`, `slate`.

Items (in `secure_items`) share `v`, `title`, `favorite`, `createdAt`, and `updatedAt`, and have a `kind`:

```json
{ "v": 1, "kind": "CARD", "title": "Family Visa", "favorite": true,
  "cardholder": "Aziza Karimova", "number": "4111111111111111", "brand": "VISA",
  "expMonth": 8, "expYear": 2029, "cvv": null, "bank": "Kapitalbank", "notes": "",
  "createdAt": "…", "updatedAt": "…" }

{ "v": 1, "kind": "SUBSCRIPTION", "title": "Netflix", "favorite": false,
  "url": "https://www.netflix.com/", "amountMinor": 999, "currency": "USD",
  "cycle": "MONTHLY", "customDays": null, "anchorDate": "2026-01-31", "status": "ACTIVE",
  "trialEndsOn": null, "remindDaysBefore": 3, "cardItemId": "<itemId or null>",
  "account": "", "notes": "", "createdAt": "…", "updatedAt": "…" }

{ "v": 1, "kind": "NOTE", "title": "Deposit box", "favorite": false,
  "body": "Box 42", "createdAt": "…", "updatedAt": "…" }
```

- Cards: `number` is digits only (12 to 19). `brand` is `VISA`, `MASTERCARD`, `AMEX`, `UNIONPAY`, `UZCARD`, `HUMO`, `MIR`, or `OTHER`. `expMonth` is 1 to 12 and `expYear` is 2000 to 2099; a card is valid through the last day of that month. `cvv` is null or 3 to 4 digits. There is no PIN field.
- Subscriptions: `amountMinor` is an integer in the currency's minor unit, as in `transactions`. `cycle` is `WEEKLY`, `MONTHLY`, `QUARTERLY`, `YEARLY`, or `CUSTOM`; `customDays` is 1 to 3,650 for `CUSTOM` and null otherwise. `anchorDate` and `trialEndsOn` are `YYYY-MM-DD`. `status` is `ACTIVE`, `PAUSED`, or `CANCELLED`. `remindDaysBefore` is 0 to 30. `cardItemId` is a bare item id of a card and may point to a deleted card or one in another safe.
- Notes: `body` is plain text, at most 10,000 characters.

`SafeEvent` (in `safe_events`):

```json
{ "v": 1, "type": "ITEM_MOVED", "at": "2026-09-29T09:00:00.000Z", "safeId": "<id or null>", "itemId": "<id or null>", "count": 2 }
```

`type` is one of `SAFES_INITIALIZED`, `SAFES_UNLOCKED`, `SAFE_CREATED`, `SAFE_UPDATED`, `SAFE_TRASHED`, `SAFE_RESTORED`, `SAFE_PURGED`, `SAFE_KEY_ROTATED`, `ITEM_CREATED`, `ITEM_UPDATED`, `ITEM_MOVED`, `ITEM_COPIED`, `ITEM_TRASHED`, `ITEM_RESTORED`, `ITEM_PURGED`, `RECOVERY_CREATED`, or `PASSWORD_REWRAPPED`. `count` is present only for actions on several items. Events contain ids, never names or field values. Safe activity is never written to the shared `audit_logs`.

### Trash and deletion

Moving a safe or an item to the trash sets `deleted_at`. Rows whose `deleted_at` is more than 30 days old are deleted when their owner next opens their safes; a trashed safe is deleted together with all its items. Permanent deletes, "Reset private safes", and removing a person delete the rows at once. With `secure_delete` on, the bytes are zeroed in the database, but copies remain in older backups and in the earlier copies the browser keeps (up to three). Crypto-shredding is complete only when those are gone too.

### Limits

50 safes and 5,000 items per person, and 1,000 items per safe, trashed ones included. Safe names up to 60 characters, descriptions 500, item titles 100, cardholder and bank 80, URLs 2,048, account and notes 2,000, note bodies 10,000. Each padded plaintext is at most 32 KiB.

### What the safe layer does not protect

- **A compromised device or browser**, or modified JavaScript served to it. Someone who controls the code the owner runs can capture the password.
- **An Admin who resets a password and also tampers with the database.** They can plant a personal key wrapped under the temporary password and trick the owner into storing new secrets under it. Secrets stored before the reset stay protected, because the app never unwraps with an Admin-set password. Owners must never enter the temporary password as their "previous password".
- **Metadata.** Anyone who can decrypt the database sees how many safes and items each person has, the size of each ciphertext in 256-byte steps, `deleted_at`, `key_version`, `rev`, the `user_keys` timestamps, and when rows change.
- **Rollback and deletion.** An Admin can delete rows or restore an older backup. Each row that is present is authenticated, but missing or older rows are not detected.

## One-time codes

Invite and reset codes (1.3.0) are the only secrets besides passwords that unwrap the DEK. They are random, not chosen by people, so they are long enough to resist offline guessing even though PBKDF2 is the only slow step.

### Code format

17 random bytes with the top bit of the first byte cleared give a 135-bit big-endian integer. It is written as 27 Crockford base32 digits (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`), most significant first, followed by one check symbol: the integer modulo 37, taken from `0123456789ABCDEFGHJKMNPQRSTVWXYZ*~$=U`. The 28 characters are shown in seven groups of four joined by `-`. Input longer than 128 characters is rejected; otherwise it is upper-cased, spaces and dashes are removed, `O` becomes `0`, and `I` and `L` become `1`. A wrong length, an unknown character, or a wrong check symbol is rejected before any key is derived. The canonical form (28 characters, no dashes) is what the key derivation uses.

### Keys

```text
code (canonical, UTF-8) ──PBKDF2(grant.kdf, salt = grant.salt)──► 256 bits
   ├─HKDF-SHA-256(salt = empty, info = "moliya/grant-kek/v1")──► grant KEK (AES-256-GCM)
   └─HKDF-SHA-256(salt = empty, info = "moliya/grant-verifier/v1")──► 256 bits ──hex──► access_grants.code_verifier
```

The grant KEK wraps the raw 32-byte DEK with AES-256-GCM, a fresh 12-byte IV (`grant.iv`), and additional data `UTF-8("moliya/grant/v1|" + id + "|" + kind + "|" + email)`, so a grant whose id, kind, or email was altered fails to unwrap. An empty HKDF salt is HKDF's default of 32 zero bytes.

### Using a code

1. Find the `grants[]` entry with the chosen kind and the normalised email. If there is none, the app still runs one PBKDF2 derivation, so an unknown address takes as long as a wrong code.
2. Derive the grant KEK and verifier, unwrap the DEK, and decrypt the body.
3. In the database, the `access_grants` row with the same `id` must be open, have the same kind and email, and have a `code_verifier` equal to the derived one (compared in constant time). The device clock must not be more than 5 minutes behind `clock_high_water`, and `expires_at` must be later than now.
4. For `INVITE`, a new `users` row is created with the row's role and group, the chosen password, and `must_change_password = 0`. For `RESET`, the person's `password_hash`, `salt`, and `password_changed_at` are replaced, `must_change_password` is set to 0, and their `user_totp` row is deleted. The row is ended as `USED`, and `INVITE_ACCEPTED` or `RESET_COMPLETED` is written, all in one transaction.
5. A normal password wrap replaces the grant in the envelope, and the vault is saved at once.

Expiry, one-time use, and revocation are enforced by the app, not by cryptography. The grant wrap stays inside any backup or earlier copy made while the code was open. Anyone with such a copy and the code can unwrap the DEK with other tools, whatever `expires_at` says. The 135-bit code is the real protection.

## Sign-in check (`user_totp`)

The optional sign-in check (1.3.0) asks for a time-based one-time password after the person's password has already opened the vault. It is an extra step in the app's sign-in flow, not an extra layer of encryption: the DEK and the database never depend on it, and anyone with a copy of the vault and the password can decrypt it without the check.

- **Codes**: RFC 6238 TOTP with HMAC-SHA-1, 6 digits, 30-second steps counted from the Unix epoch, accepting the current step and one step either side. A step is accepted only if it is greater than `last_step`, which is then updated, so a code cannot be used twice.
- **Secret**: 20 random bytes, given to the authenticator app as RFC 4648 base32 without padding inside `otpauth://totp/<label>?secret=…&issuer=Jaybi&algorithm=SHA1&digits=6&period=30`, where the label is `Jaybi:<email>`, URL-encoded. Up to 1.2.0 the issuer and label prefix were `Moliya`. The issuer is only a label in the authenticator app; it is not stored in the vault and does not affect the codes, so entries made with either name keep working. The QR code is drawn in the browser; nothing is sent anywhere.
- **Encryption of the secret**: `kdf` (JSON, same bounds as wraps) and `kdf_salt` (32 bytes, base64) feed a separate PBKDF2 run over the person's password; HKDF-SHA-256 with `info = "moliya/totp-kek/v1"` and an empty salt turns the output into an AES-256-GCM key. `secret_iv` and `secret_ciphertext` hold `{"secret":"<base32>"}`, padded and encrypted exactly like safe payloads (see [Encryption and AAD](#encryption-and-aad)), with AAD `["moliya.totp",1,userId]`. Nobody else's password, and no Admin, can read it.
- **Recovery codes**: 10 codes of 10 random bytes (80 bits) each, written as 16 Crockford base32 characters and shown as `XXXX-XXXX-XXXX-XXXX`, without a check symbol. Input is normalised like a one-time code. Each is stored as `hex(HMAC-SHA-256(key = recovery_salt, UTF-8("moliya/totp-recovery/v1|" + code)))`, where `recovery_salt` is 32 random bytes. Using a code removes its hash from `recovery_hashes` and writes `TOTP_RECOVERY_USED` with the number left.
- **Lifecycle**: changing one's own password re-encrypts the secret under the new password with a new salt in the same transaction and sets `rewrapped_at`. The row is deleted when its owner turns the check off (with their password), when an Admin turns it off for them (`TOTP_CLEARED`), and when an Admin sets a temporary password or the person uses a reset code.

## Compatibility rules

1. **Readers are forever.** Code that reads a released record, backup, or schema version is never removed. A new version adds a branch; it does not replace one.
2. **Migrations are forward-only and ordered.** Each has a number, runs in its own transaction, and is recorded in `schema_migrations`. A released migration is never edited.
3. **Refuse newer data.** If a record, backup, or schema is newer than the running build supports, the app refuses to open or overwrite it and says so (`FORMAT_TOO_NEW`). The data is left untouched.
4. **Keep the previous state.** The first save after an upgrade, and every import, keeps the replaced record as an archive in the same IndexedDB transaction.
5. **Optional fields are omitted when empty.** `grants` is written only when it has entries, so a vault with no open codes produces the same envelope layout as 1.2.0 apart from `schemaVersion`.
6. **Fixtures are immutable.** Every released format has a golden backup produced by that release. Fixtures are never edited or deleted.
7. **Old passwords keep working.** KDF parameters are stored per wrap and accepted within the bounds above. Strengthening happens by re-wrapping on sign-in, never by rejecting old parameters. The same holds for the password rules: a password that no longer meets them still opens the vault.
8. **Open formats only.** The payload is a plain SQLite file (a Library of Congress preferred format for datasets), wrapped in documented Web Crypto primitives, inside JSON.
9. **Safe rows carry their own version.** Every private safe row has `enc_version` (1 today: AES-256-GCM, 12-byte random IV, the AAD layout above, 256-byte padding). A new scheme gets a new number and a new reader branch; rows are upgraded when they are rewritten, never in bulk by a migration, because only the owner holds the keys.

## Golden fixtures

`tests/fixtures/backups/` holds real backups written by each release, with their passwords and expected contents. `MANIFEST.json` lists them; `SHA256SUMS` in each folder pins their bytes. `tests/unit/fixtures.test.ts` imports each one with the current code, runs all migrations, signs in as every person, and compares every record and the dashboard totals. For fixtures with private safes, it also opens each person's safes (through the previous password and the recovery code for a stale owner), compares every safe and item and the subscription totals, and checks that nobody else can unwrap them. For fixtures with one-time codes and the sign-in check, it checks that opening ends expired codes, that used, revoked, and expired codes are refused, and that the stored authenticator secret and recovery codes still pass the check. It fails if a fixture file changes or disappears, or if any record, backup, or schema version from 1 to the current one has no fixture. `tests/e2e/upgrade.spec.ts` loads the exact IndexedDB record 1.0.0 stored into a real browser and signs in with the new build.

| Fixture | Written by | Covers |
| --- | --- | --- |
| `v1/household-usd` | 1.0.0 | Record/backup/schema 1, three roles, two groups, custom category, USD/UZS/EUR, float edge cases (`0.1`, `1.005`, `2.675`, `999999.99`), receipt, edited and deleted records |
| `v1/business-uzs` | 1.0.0 | Single admin with a non-ASCII password, vault currency switched from USD to UZS |
| `v2/ledger-v2` | 1.1.0 | Record/backup/schema 2, 600,000-iteration wraps, comma decimals, grouped digits, the largest accepted amount, hash-chained audit log |
| `v3/safes-household` | 1.2.0 | Record/backup 2 with schema 3, HKDF verifiers, `PASSWORD_CHANGED` and `USER_PASSWORD_RESET` audit entries. Private safes for three people: cards (Visa with CVV, Humo without, Mastercard), subscriptions in USD, UZS, and EUR (monthly, yearly, cancelled, every 30 days with a trial), notes with non-ASCII text, an archived safe, a trashed item, a password-each-time safe, recovery codes, and a Viewer whose safes are stale after an admin reset |
| `v4/access-household` | 1.3.0 | Record/backup 2 with schema 4 and a `grants[]` entry. A UZS vault with a receipt; a Manager who joined with an invite code (non-ASCII password) and turned on the sign-in check with recovery codes; a Viewer created with a temporary password whose first reset code was revoked and whose second (stopping the old password) was used; one invite still open in the file but expired, so opening the fixture ends it with `INVITE_EXPIRED`. The expected file lists every code, the TOTP secret, and the recovery codes, so the tests check that used, revoked, and expired codes are refused and that the sign-in check still works |

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

A single file downloads as-is; several files (or any encrypted choice) download as one ZIP with a `README.txt`. The downloaded name is `jaybi-<vault>-<yyyy-mm-dd>.<ext>`, `…-encrypted.zip`, or `…-encrypted.sqlite`. `<vault>` is the vault name normalised to NFC, with `\/:*?"<>|`, control characters, and whitespace replaced by `-`, at most 48 characters, falling back to `vault`. The vault name is therefore visible in the file name even for encrypted exports.

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

### Table view exports

The **Export** button above a table (`src/services/export/view.ts`) writes the rows and columns the table shows. It is write-only, like export format 1, and changes no vault, backup, schema, or export format version. Allowed tables and the permission each needs besides `EXPORT_VAULT` are in `VIEW_TABLES` (`src/services/view-access.ts`): `transactions` (`READ_TRANSACTIONS`), `users` and `grants` (`MANAGE_USERS`), `groups` (`MANAGE_GROUPS`), `audit` (`READ_AUDIT`), `categories` (`MANAGE_SETTINGS`), and `archives` (`EXPORT_VAULT`). Private safe tables cannot be exported. The service checks the permission, that the plain-file box was ticked, and every cell against its column kind (`text`, `number`, `money`, `date`, `when`, `boolean`; at most 100,000 rows) before it writes the `DATA_EXPORTED` audit entry with details `{ formats: [format], protection: "none", scope: { view, columns, filtered, from, to, groupId }, includesAudit, includesReceipts: false, counts: { rows, total } }`. The rows are never in the audit entry.

Files are named `<app>-<vault>-<yyyy-mm-dd>-<table>.<ext>` and are never encrypted:

- **CSV**: the same rules and formula protection as `transactions.csv`. The header is the visible column headings in the reader's language; a money column becomes two columns, the decimal amount and `<heading> · Currency`.
- **JSON**: `{ "format": "jaybi-view", "version": 1, table, title, vault, exportedAt, exportedBy, filtered, totalRows, columns: [{ id, header, kind }], rows: [{ <column id>: value }] }`. Money is `{ amount, amountMinor, currency }`. `version` counts this document shape only.
- **Excel**: one sheet with the same columns; dates are date cells, money is a number cell with its currency in the next column, and formula-like text is stored as text.
- **PDF**: A4 (landscape above 5 columns) with the title, vault, who exported it, and when; at most 10,000 rows.

## Recovering data without the app

`tools/moliya-decrypt.mjs` needs only Node.js 22 or newer (22.13+ to blank password material automatically):

```bash
node tools/moliya-decrypt.mjs backup.moliya --list
MOLIYA_PASSWORD='…' node tools/moliya-decrypt.mjs backup.moliya --email admin@example.com --out ledger.sqlite
sqlite3 ledger.sqlite "SELECT transaction_date, type, amount_minor / 100.0, currency, notes FROM transactions ORDER BY 1"
```

The password comes from `MOLIYA_PASSWORD`, or the tool prompts for it. Without `--out` the output is the backup's name with `.sqlite`; an existing file is only overwritten with `--force`. `--help` prints the usage. Exit code 2 means bad arguments.

For schema version 1 files the amount column is `amount` instead of `amount_minor`. The tool is about 240 lines of dependency-free JavaScript and doubles as a reference implementation of this document. Any language with PBKDF2 and AES-GCM can do the same in three steps: derive the KEK, decrypt `wrappedDek` to get the DEK, decrypt `body.ciphertext`.

With Node.js 22.13 or newer, the tool blanks `users.password_hash` and `users.salt`, deletes every row of `safe_events`, `secure_items`, `safes`, `user_keys`, and `user_totp`, and blanks `access_grants.code_verifier` in the output before vacuuming it. `--keep-keys` skips this step, which keeps the verifiers, salts, the private safe rows, and the sign-in check rows, still encrypted with each owner's keys. On older Node.js versions without `node:sqlite` nothing is removed and the tool prints a warning.

The tool only opens a backup with a person's password. It never tries invite or reset codes. `--list` prints the people and their KDF parameters and, as `pendingCodes`, the kind and email of every entry in `grants[]` (never the code, which the file does not contain).

Use the tool from the release you are recovering with, or newer. The tool shipped with 1.2.0 and earlier opens a 1.3.0 backup, because it ignores the unknown `grants` key and does not check the schema version, but it does not know about `user_totp` and `access_grants`: its output keeps each person's encrypted sign-in check secret and recovery code hashes, and the code verifiers. Treat such a file as sensitive, or run the current tool instead.

The tool does not decrypt private safes. An owner can still recover them from a copy made with `--keep-keys`, with their password or recovery code and any Web Crypto implementation, by following [Private safes](#private-safes):

1. Read the owner's `user_keys` row. Derive the personal KEK from the password (`kdf`, `kdf_salt`, then HKDF with `moliya/personal-kek/v1`), or the recovery KEK from the parsed recovery code (`recovery_salt`, HKDF with `moliya/recovery-kek/v1`).
2. Unwrap `wrapped_key` (or `recovery_wrapped_key`) with AAD `["moliya.pk",1,userId]` (or `["moliya.pk-recovery",1,userId]`) to get the personal key.
3. For each `safes` row, unwrap `wrapped_key` with AAD `["moliya.safe-key",1,userId,safeId,keyVersion]` to get the safe key.
4. Decrypt each `secure_items` row of that safe with AAD `["moliya.item",1,userId,safeId,itemId,keyVersion]`, read the 4-byte big-endian length, and parse that many bytes as UTF-8 JSON.

If the wrap is stale, the current password does not open it; use the previous password or the recovery code.

## Published exchange-rate snapshot

The dashboard's exchange rates are public data, not part of the vault. They are never written to SQLite, backups, or IndexedDB, and the ten-year guarantee above does not cover them. The format is still versioned so that old and new builds fail safely.

`rates/latest.json` on the site (and `rates/history/YYYY-MM-DD.json` for each UTC day a run changed it) holds one JSON object, schema 1. The browser keeps the last verified copy, as the exact text it received, in `localStorage` under `moliya.fx.snapshot.v1`.

| Field | Meaning |
| --- | --- |
| `schema` | `1`. A reader refuses any other value. |
| `generatedAt` | ISO 8601 UTC time the publisher built the snapshot. A reader keeps the newer of its cached and fetched copies. |
| `quotes[]` | Exactly three, in the order UZS, KRW, ILS. Each is units of `quote` per 1 `base` (`USD`). |
| `quotes[].rate` | Decimal string, digits and at most one dot, no exponent. Official rates exactly as the source published them; cross rates to 12 significant digits, half-even. |
| `quotes[].date` | `YYYY-MM-DD` the source says the rate is valid for. |
| `quotes[].source`, `method` | `CBU`, `ECB`, or `BOI`; `official` or `cross`. |
| `quotes[].legs` | For `cross`: the two official rates `[numerator, denominator]` it was computed from, such as EUR/KRW and EUR/USD. `null` for `official`. The reader recomputes the cross rate and rejects a mismatch. |
| `quotes[].previous` | The previous official rate and its earlier date, or `null`. Used for the change figure. |
| `fetches[]` | Each upstream request: `source`, `url` (https), `fetchedAt`, and `sha256` of the exact response bytes. The bytes are kept on the `fx-data` branch under `archive/YYYY-MM-DD/`. |
| `checks[]` | Cross-checks that were run: `subject`, `reference`, `deviationPercent`, `tolerancePercent`, `passed`. A published snapshot only contains passed checks. |
| `digest` | Lowercase hex SHA-256 of `JSON.stringify` of the same object without `digest`, keys in file order. A checksum against truncation and corruption, not a signature: the protection against forgery is that only the repository's workflow can write the site. |

Readers also reject rates outside plausible bounds (UZS 1,000–100,000, KRW 100–10,000, ILS 1–20 per USD) and dates more than four days after `generatedAt`. `tests/fixtures/fx/snapshot.json` is a complete example.

## Changing a format

1. Bump the relevant constant in `src/db/versions.ts`. Add a migration file for schema changes (`src/db/migrations/000N-name.ts`, or `.sql` imported with `?raw`) and append it to `MIGRATIONS`.
2. Add a reader branch for the new record or backup version; keep every existing branch.
3. Release, then generate a fixture with the released code (`tools/fixtures/<version>/generate.gen.ts`, run with `npm run fixtures:generate -- tools/fixtures/<version>`), add it to `MANIFEST.json`, and commit it with its `SHA256SUMS`.
4. Update the version matrix and the relevant sections above, and the CHANGELOG.
