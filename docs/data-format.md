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
| 1.2.0 | 2 | 2 | 3 | PBKDF2-SHA-256, 600,000 iterations |

1.2.0 reads every row above it. Readers never lose support for a version once it has been released. Private safes (1.2.0) live inside the encrypted database, so they changed only the schema version; the record and backup formats are the same as in 1.1.0. Because the backup carries `schemaVersion`, 1.1.0 refuses a 1.2.0 vault or backup with `FORMAT_TOO_NEW` instead of misreading it.

The constants live in `src/db/versions.ts`. The KDF parameters live in `src/crypto/crypto.service.ts`.

## Layers

```text
.moliya backup file (JSON, UTF-8)          IndexedDB record (structured clone)
  ├─ metadata: format, versions, dates        ├─ same metadata
  ├─ wraps[]: one per user                    ├─ wraps[] with ArrayBuffers
  │    KDF(password, salt) = KEK              │
  │    AES-GCM(KEK).decrypt(wrappedDek) = DEK │
  └─ body: AES-GCM(DEK).decrypt = SQLite file └─ body
              └─ private safe tables (schema 3): a second layer, encrypted with each owner's own keys
```

A backup and an IndexedDB record carry the same information. The backup uses base64 text for binary fields; IndexedDB stores `ArrayBuffer`s. Anyone who can decrypt the body can read the ledger, but not the private safe rows inside it; those need the owner's password or recovery code (see [Private safes](#private-safes)).

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

### Password verifier (`users.password_hash`)

Sign-in never compares `users.password_hash`; it succeeds only if the wrap unwraps and the body decrypts. The column is kept as a verifier and nothing derives keys from it.

| Schema | Value |
| --- | --- |
| 1 and 2 (1.0.0, 1.1.0) | Lower-case hex of the raw 256 PBKDF2 bits, which are the KEK itself. Anyone who reads the decrypted database can unwrap that person's `wrappedDek` without the password. |
| 3 (1.2.0) | Empty string after migration 3, until the person's next successful sign-in. Then `hex(HKDF-SHA-256(ikm = raw PBKDF2 bits, salt = empty, info = UTF-8 "moliya/verifier/v1"))`: 256 bits, 64 lower-case hex characters, no prefix. The empty salt is HKDF's default of 32 zero bytes. Written without an audit entry. New, reset, and changed passwords store this form directly. |

Whenever the stored value is not the verifier (a pre-1.2.0 raw value, or the empty string left by migration 3), sign-in also wraps the same DEK again under a fresh salt with the current KDF, exactly like a KDF upgrade but without an audit entry when the KDF parameters do not change. A KEK-equal value read before that sign-in therefore no longer opens the stored wrap. Backups and archives written by 1.0.0 and 1.1.0 still contain the old KEK-equal values together with the old wraps they open. Plaintext exports blank the column (see [Plaintext exports](#plaintext-exports)).

## Backup file

A `.moliya` file is a single JSON object encoded as UTF-8. Readers must ignore unknown fields. Binary fields are standard base64 with padding (RFC 4648 section 4).

### Backup version 2 (written by 1.1.0 and 1.2.0)

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
| `schemaVersion` | integer | SQLite schema version inside `body` (2 from 1.1.0, 3 from 1.2.0). |
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

The connection runs with `PRAGMA foreign_keys = ON` and, from 1.2.0, `PRAGMA secure_delete = ON`, so deleted rows are overwritten with zeros in the database file instead of lingering in free pages.

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

`autoLockMinutes` is 1, 5, 15, or 30; `clipboardSeconds` is 10, 30, or 60; `revealSeconds` is 15, 30, or 60. Unknown values fall back to the defaults shown.

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

## Compatibility rules

1. **Readers are forever.** Code that reads a released record, backup, or schema version is never removed. A new version adds a branch; it does not replace one.
2. **Migrations are forward-only and ordered.** Each has a number, runs in its own transaction, and is recorded in `schema_migrations`. A released migration is never edited.
3. **Refuse newer data.** If a record, backup, or schema is newer than the running build supports, the app refuses to open or overwrite it and says so (`FORMAT_TOO_NEW`). The data is left untouched.
4. **Keep the previous state.** The first save after an upgrade, and every import, keeps the replaced record as an archive in the same IndexedDB transaction.
5. **Fixtures are immutable.** Every released format has a golden backup produced by that release. Fixtures are never edited or deleted.
6. **Old passwords keep working.** KDF parameters are stored per wrap and accepted within the bounds above. Strengthening happens by re-wrapping on sign-in, never by rejecting old parameters.
7. **Open formats only.** The payload is a plain SQLite file (a Library of Congress preferred format for datasets), wrapped in documented Web Crypto primitives, inside JSON.
8. **Safe rows carry their own version.** Every private safe row has `enc_version` (1 today: AES-256-GCM, 12-byte random IV, the AAD layout above, 256-byte padding). A new scheme gets a new number and a new reader branch; rows are upgraded when they are rewritten, never in bulk by a migration, because only the owner holds the keys.

## Golden fixtures

`tests/fixtures/backups/` holds real backups written by each release, with their passwords and expected contents. `MANIFEST.json` lists them; `SHA256SUMS` in each folder pins their bytes. `tests/unit/fixtures.test.ts` imports each one with the current code, runs all migrations, signs in as every person, and compares every record and the dashboard totals. For fixtures with private safes, it also opens each person's safes (through the previous password and the recovery code for a stale owner), compares every safe and item and the subscription totals, and checks that nobody else can unwrap them. It fails if a fixture file changes or disappears, or if any record, backup, or schema version from 1 to the current one has no fixture. `tests/e2e/upgrade.spec.ts` loads the exact IndexedDB record 1.0.0 stored into a real browser and signs in with the new build.

| Fixture | Written by | Covers |
| --- | --- | --- |
| `v1/household-usd` | 1.0.0 | Record/backup/schema 1, three roles, two groups, custom category, USD/UZS/EUR, float edge cases (`0.1`, `1.005`, `2.675`, `999999.99`), receipt, edited and deleted records |
| `v1/business-uzs` | 1.0.0 | Single admin with a non-ASCII password, vault currency switched from USD to UZS |
| `v2/ledger-v2` | 1.1.0 | Record/backup/schema 2, 600,000-iteration wraps, comma decimals, grouped digits, the largest accepted amount, hash-chained audit log |
| `v3/safes-household` | 1.2.0 | Record/backup 2 with schema 3, HKDF verifiers, `PASSWORD_CHANGED` and `USER_PASSWORD_RESET` audit entries. Private safes for three people: cards (Visa with CVV, Humo without, Mastercard), subscriptions in USD, UZS, and EUR (monthly, yearly, cancelled, every 30 days with a trial), notes with non-ASCII text, an archived safe, a trashed item, a password-each-time safe, recovery codes, and a Viewer whose safes are stale after an admin reset |

## Plaintext exports

Admins can download unencrypted copies from the Backup page. Both are written to the audit log as `PLAINTEXT_EXPORTED`.

- **CSV** (`moliya-records-YYYY-MM-DD.csv`): UTF-8 with a byte order mark, CRLF line endings, RFC 4180 quoting. Columns: `id, date, type, category, amount, currency, amount_minor, minor_unit, group, recorded_by, notes, has_receipt, created_at, updated_at`. `amount` is a plain decimal with a dot (`10.50`). Text cells that start with `=`, `+`, `-`, `@`, tab, or carriage return are prefixed with `'` so spreadsheets do not run them as formulas.
- **SQLite** (`moliya-database-YYYY-MM-DD.sqlite`): the decrypted database with `users.password_hash` and `users.salt` blanked, every row of `safe_events`, `secure_items`, `safes`, and `user_keys` deleted (the tables stay, empty), and the file vacuumed, so no password-derived material and no private safe data remains.

Neither export includes private safes. There is no plaintext export of safes.

## Recovering data without the app

`tools/moliya-decrypt.mjs` needs only Node.js 22 or newer (22.13+ to blank password material automatically):

```bash
node tools/moliya-decrypt.mjs backup.moliya --list
MOLIYA_PASSWORD='…' node tools/moliya-decrypt.mjs backup.moliya --email admin@example.com --out ledger.sqlite
sqlite3 ledger.sqlite "SELECT transaction_date, type, amount_minor / 100.0, currency, notes FROM transactions ORDER BY 1"
```

For schema version 1 files the amount column is `amount` instead of `amount_minor`. The tool is about 200 lines of dependency-free JavaScript and doubles as a reference implementation of this document. Any language with PBKDF2 and AES-GCM can do the same in three steps: derive the KEK, decrypt `wrappedDek` to get the DEK, decrypt `body.ciphertext`.

With Node.js 22.13 or newer, the tool blanks `users.password_hash` and `users.salt` and deletes every row of `safe_events`, `secure_items`, `safes`, and `user_keys` from the output before vacuuming it. `--keep-keys` skips this step, which keeps the verifiers, salts, and the private safe rows, still encrypted with each owner's keys. On older Node.js versions without `node:sqlite` nothing is removed and the tool prints a warning.

The tool does not decrypt private safes. An owner can still recover them from a copy made with `--keep-keys`, with their password or recovery code and any Web Crypto implementation, by following [Private safes](#private-safes):

1. Read the owner's `user_keys` row. Derive the personal KEK from the password (`kdf`, `kdf_salt`, then HKDF with `moliya/personal-kek/v1`), or the recovery KEK from the parsed recovery code (`recovery_salt`, HKDF with `moliya/recovery-kek/v1`).
2. Unwrap `wrapped_key` (or `recovery_wrapped_key`) with AAD `["moliya.pk",1,userId]` (or `["moliya.pk-recovery",1,userId]`) to get the personal key.
3. For each `safes` row, unwrap `wrapped_key` with AAD `["moliya.safe-key",1,userId,safeId,keyVersion]` to get the safe key.
4. Decrypt each `secure_items` row of that safe with AAD `["moliya.item",1,userId,safeId,itemId,keyVersion]`, read the 4-byte big-endian length, and parse that many bytes as UTF-8 JSON.

If the wrap is stale, the current password does not open it; use the previous password or the recovery code.

## Changing a format

1. Bump the relevant constant in `src/db/versions.ts`. Add a migration file for schema changes (`src/db/migrations/000N-name.ts`, or `.sql` imported with `?raw`) and append it to `MIGRATIONS`.
2. Add a reader branch for the new record or backup version; keep every existing branch.
3. Release, then generate a fixture with the released code (`tools/fixtures/<version>/generate.gen.ts`, run with `npm run fixtures:generate -- tools/fixtures/<version>`), add it to `MANIFEST.json`, and commit it with its `SHA256SUMS`.
4. Update the version matrix and the relevant sections above, and the CHANGELOG.
