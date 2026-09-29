# Changelog

All notable changes to Jaybi (called Moliya up to 1.2.0) are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Data formats are versioned separately from the app. Each release lists the formats it reads and writes; the full specification is in [docs/data-format.md](docs/data-format.md).

## [Unreleased]

Reads backup and record versions 1–2 and schema versions 1–4. Writes backup 2, record 2, schema 4. Vaults and backups made by 1.0.0, 1.1.0, and 1.2.0 upgrade automatically on first sign-in, and the original stored copy is kept in the browser. Moliya 1.1.0 and 1.2.0 refuse a schema 4 vault or backup with "made by a newer version" and leave it untouched. The 1.2.0 recovery tool still decrypts schema 4 backups but does not remove the new sign-in check and code data from its output.

### Added

- The app is renamed **Jaybi** (Жайби in Uzbek Cyrillic, Джайби in Russian), with the Arabic-script mark جيبي in the sidebar, on the sign-in screens, and in the collapsed sidebar. Only names shown to people change: format ids, storage and database names, local storage keys, the `.moliya` backup extension and file names, key-derivation labels, fixtures, and the recovery tool keep the name `moliya`, so every existing vault and backup keeps opening. New authenticator set-ups show "Jaybi"; existing entries named "Moliya" keep working. Release assets are now `jaybi-X.Y.Z.zip`.
- The app moves from `kool277.github.io/iqtisod` to its own domain, [jaybi.uz](https://jaybi.uz) (`www.jaybi.uz` redirects there). `public/CNAME` carries the domain, and the deploy publishes it only once the domain is set in the repository settings, so this release reaches users at the old address first. At the old address a notice on every screen asks people to download an encrypted backup and import it at jaybi.uz, with a one-click download for Admins. At jaybi.uz an empty browser's setup screen points people coming from the old address to the backup import. The devops guide has the DNS records and the cut-over order.
- Invite codes. Admins create a one-time code for an email, role, and group under **Invite someone**, valid for 15 minutes, 1 hour, 24 hours (default), 3 days, or 7 days. The person enters it with their email on the new join page and chooses their own password, so the Admin never knows it. Codes carry 135 random bits with a check symbol (seven groups of four), are shown once with **Copy code** and **Copy link** (clipboard cleared after 60 seconds), and are stored only as a key-derived verifier and a wrapped copy of the vault key. One open code per email, at most 20 open invites. Codes work only in the browser where the vault is stored, which the join page and the admin guide explain.
- Reset codes: **Issue reset code** replaces the Admin-set temporary password as the default. Optionally, **Stop their current password from working now** removes the person's key at once. Using the code sets the new password and turns off the person's sign-in check. The temporary password stays available as an advanced option.
- **Open codes** list with **Revoke**. Expired codes are ended at the next sign-in and logged as "Code expired". Creating or using a code is refused if the device clock is more than 5 minutes behind the latest time the vault has seen.
- Optional sign-in check per person: a 6-digit authenticator code (RFC 6238, SHA-1, 30-second steps, each step usable once) after the password, with a locally drawn QR code and 10 single-use recovery codes. The secret is encrypted under a key derived from the person's password and re-sealed when the password changes. Admins can turn it off for someone who lost both their app and their codes. The app says plainly that it adds a second step to signing in, not encryption.
- Attempt limits for sign-in, codes, and the sign-in check: 5 free failures per email and 20 per kind in the browser, then a wait that doubles from 30 seconds to 15 minutes, with a countdown. After signing in, people see how many failed attempts there were for their account in that browser.
- **Lock automatically** in Account: 5, 15 (default), 30, or 60 minutes, per browser.
- **Replace this vault with a backup** on the Backup page, which needs the import permission, the Admin's password, and the vault name typed out.
- Size limits: a 48 MiB database budget enforced when adding receipts, with a warning at 36 MiB, and caps for names, emails, and notes.
- Audit entries: "Invite code created", "Invite code revoked", "Invite accepted", "Code expired", "Reset code issued", "Reset code revoked", "Password reset with code", "Vault replaced by a backup", "Failed sign-in attempts seen", "Sign-in check turned on", "Sign-in check turned off", "Sign-in check removed", and "Sign-in recovery code used". No code, password, or secret is ever logged.
- Schema version 4: tables `access_grants` and `user_totp`, and the `clock_high_water` setting. Envelopes gain an optional `grants[]` list of code wraps.
- `SECURITY.md` with supported versions, how to report a vulnerability privately, and a threat model summary. A threat model section in the developer guide.
- Golden backup `v4/access-household` made by 1.3.0: a Manager who joined by invite with the sign-in check and recovery codes, a Viewer reset with a stop-old reset code after a first code was revoked, and an expired invite that is swept on open.
- Translations for all new text in Oʻzbekcha (Latin and Cyrillic), Russian, and English.

### Changed

- New passwords need 12 to 256 characters, must not be common (a built-in list, even with digits or symbols added), repetitive, a keyboard run, or built from the email or vault name. Existing passwords keep working; people whose password falls short see a banner asking them to change it. (Audit 2)
- Importing a backup on the setup screen works only when the browser has no vault. Replacing an existing vault checks `IMPORT_VAULT`, asks for the password and the vault name, writes "Vault replaced by a backup" into the old vault, and keeps it as **Before import**. (Audit 5)
- The import cap rises from 20 MiB to 72 MiB to match the database budget, so every vault the app allows can be imported again. (Audit 6)
- Receipts must be PNG, JPEG, WebP, or GIF with a matching file signature. SVG is refused. Existing receipts are kept. (Audit 11)
- Group names and the setup vault name are limited to 80 characters. (Audit 10)
- A vault holds at most 256 people. Adding a person, creating an invite, and accepting one are refused once the people and open invites would exceed what a backup can hold.
- Adding a person with a temporary password ends any open invite for that email. Removing a person ends their codes.
- The unencrypted SQLite export and `npm run decrypt` (unless `--keep-keys` is given) remove sign-in check rows and code verifiers. `npm run decrypt --list` shows pending codes by kind and email.
- CI installs with `npm ci --ignore-scripts` and runs `npm audit signatures`. Dependabot waits 7 days before proposing a release. `CODEOWNERS` requires the owner's review for key handling, storage, auth, grants, users, the sign-in check, limits, what the browser loads, fixtures, the lock file, and CI.

### Security

- Attempt limits slow down password, code, and sign-in check guessing in the app. They do not protect a copied vault or backup against offline guessing; only a strong password does. (Audit 3)
- The main vault now locks after a period without activity. (Audit 4)
- The stricter Content Security Policy: `default-src 'none'`, `style-src 'self'` without `'unsafe-inline'`, no `blob:`, `base-uri 'none'`, `frame-src` and `child-src 'none'`, `upgrade-insecure-requests`, and Trusted Types with a `default` policy that allows only the isolation service worker's URL. The charset, `referrer: no-referrer`, and the policy are the first tags in `<head>`. (Audit 15)
- The app refuses to run inside a frame and offers a link to open it in its own tab. The isolation service worker does not register when framed. (Audit 16)
- Every decrypted database is hardened (defensive mode, `trusted_schema` off, `cell_size_check`, 8 MiB value limit, `ATTACH` disabled) and must match the schema the app's own migrations create before it is used. `PRAGMA quick_check` runs on every open. (Audit 13)
- Envelope and backup readers enforce caps: 1–256 wraps, at most 64 code wraps, salts of 16–64 bytes, ciphertext up to 64 MiB, KDF iterations up to 2,000,000 in the app, JSON size, depth, and prototype keys. (Audit 14)
- Sign-in with an unknown email, and a code for an unknown email, spend the same key-derivation time as a real attempt, and verifiers are compared in constant time. (Audit 8)
- The CSV formula guard also catches leading whitespace and full-width `=`, `+`, `-`, and `@`. (Audit 12)
- The devops guide now covers a dedicated custom domain (verified for the account, optionally behind Cloudflare with full security headers) and advises keeping no other GitHub Pages sites on the account until then, because they share the vault's origin. (Audit 1)
- `SECURITY.md` and private vulnerability reporting. (Audit 18)

### Fixed

- The email check took quadratic time on long input. Emails are limited to 254 characters and checked with a linear pattern. (Audit 7)
- A temporary-password reset could match another key with the same email; wraps are now matched by person only. (Audit 9)
- Downloads could be cancelled in some browsers because the file's temporary URL was revoked at once; it is now revoked after 60 seconds. (Audit 19)
- Reading an amount with a very long run of zeros took quadratic time. Trailing zeros are now trimmed in one pass.

## [1.2.0] - 2026-09-29

Reads backup and record versions 1–2 and schema versions 1–3. Writes backup 2, record 2, schema 3. Vaults and backups made by 1.0.0 and 1.1.0 upgrade automatically on first sign-in, and the original stored copy is kept in the browser. Moliya 1.1.0 refuses a schema 3 vault or backup with "made by a newer version" and leaves it untouched.

### Added

- Private safes: encrypted containers for payment cards, subscriptions, and notes that only their owner can open. Every role has its own safes. Nobody else can read safe names, item fields, item types, or timestamps, including Admins with the decrypted database, the recovery tool, or someone holding a backup and another person's password. Safes are not money accounts and do not appear in the ledger or on the dashboard.
- Cards store the cardholder, number, brand (Visa, Mastercard, American Express, UnionPay, UzCard, Humo, Mir, Other), expiry, bank, and notes. The security code (CVV) is optional, hidden behind "Add security code", and comes with a warning. There is no PIN field. Numbers fail the check-digit (Luhn) test with an error for Visa, Mastercard, American Express, and Mir, and with a warning only for UzCard, Humo, UnionPay, and Other. Cards show only the last four digits, and cards expiring within 60 days are listed.
- Subscriptions with price, billing cycle (weekly, monthly, every 3 months, yearly, or every N days), status, trial end, reminder, and a linked card. Monthly and yearly totals per currency (no conversion, exact half-even rounding) and payments due in the next 30 days.
- Opening safes needs the password again. Safes lock after 5 minutes without activity (1, 5, 15, or 30 in Account), after the tab is hidden for more than 60 seconds, and when the vault locks. Showing or copying a card number or security code, permanent deletes, changing a safe's key, resetting safes, and creating a recovery code need the password within the last 2 minutes. Shown values hide after 15 seconds (15, 30, or 60) and copied values are cleared from the clipboard after 30 seconds (10, 30, or 60), when safes lock, and when the page is closed.
- Optional recovery code (25 characters, shown as five groups of five), offered and recommended at setup. Skipping it needs an explicit acknowledgement. It can be created or replaced later in Account; replacing it makes the old code stop working.
- A per-safe option to ask for the password every time the safe is opened, archived (read-only) safes, a 30-day trash for safes and items, moving and copying items between safes, changing a safe's encryption key, and an activity list that only the owner can read.
- Account page for every role: change your own password (which also moves your safes to the new password), safe preferences, recovery code, and "Reset private safes" for when both the previous password and the recovery code are lost.
- The whole vault locks after 15 minutes without activity.
- Golden backup `v3/safes-household` made by 1.2.0, with safes for three people, one of them after an admin password reset.

### Changed

- New accounts created by an Admin, and people whose password an Admin resets, must choose their own password at their next sign-in. Every page redirects to Account until they do.
- Admins can no longer reset their own password from Users; they use Account → Change password.
- Resetting a password or removing a person always shows a warning about private safes, whether or not the person has any. Removing a person destroys their safes.
- After an admin reset, safes open only with the previous password the person chose, or their recovery code, together with the new password. They are never opened with a password an Admin set.
- The unencrypted SQLite export and `npm run decrypt` (unless `--keep-keys` is given) leave out all private safe tables.
- Deleted database rows are overwritten with zeros (`PRAGMA secure_delete = ON`).
- Schema version 3: tables `user_keys`, `safes`, `secure_items`, and `safe_events`, and columns `users.must_change_password` and `users.password_changed_at`. The backup and stored record formats are unchanged.
- Translations for all new text in Oʻzbekcha (Latin and Cyrillic), Russian, and English.

### Security

- In 1.0.0 and 1.1.0, `users.password_hash` held the hex of the raw PBKDF2 output, which is the key that unwraps that person's copy of the vault key. Anyone who could read the decrypted database, for example an Admin with the unencrypted SQLite export or developer tools, could read it for every person. Migration 3 blanks every `password_hash`, and each person's next successful sign-in stores `hex(HKDF-SHA-256(raw, salt = empty, info = "moliya/verifier/v1"))` instead. Nothing derives keys from `password_hash`. Backups and earlier copies in the browser made by 1.0.0 or 1.1.0 still contain the old values: treat them as sensitive and replace them. The first 1.2.0 sign-in also re-wraps that person's copy of the vault key under a fresh salt, so a value read earlier no longer opens the stored vault.

## [1.1.0] - 2026-09-29

Reads backup, record, and schema versions 1 and 2. Writes version 2 of each. Vaults and backups made by 1.0.0 upgrade automatically on first sign-in, and the original stored copy is kept in the browser.

### Added

- Versioning: the app version, build, and build date are shown in the sidebar, on the sign-in screens, and in Settings → About, together with the data schema, vault, and backup format versions.
- `version.json` is published with each build. Open tabs detect a new deployment and offer a reload that saves and locks the vault first.
- Schema migrations based on `PRAGMA user_version`, one transaction per step, with foreign key and integrity checks. 1.0.0 databases are detected and upgraded.
- Archives: before an upgrade or an import replaces the stored vault, the previous record is kept in the browser (up to three) and can be downloaded as a backup from the Backup page.
- Backup reminder when no backup was downloaded or the last one is more than 7 days old, the last backup time, and the browser's storage protection state on the Backup page.
- Backups show the version that made them and their export date before import.
- Unencrypted CSV (RFC 4180, UTF-8 with BOM, spreadsheet-formula safe) and SQLite exports for Admins, with a warning and an audit entry. The SQLite export has password information removed.
- Tamper-evident audit log: entries are append-only and hash-chained, and the Audit page shows whether the chain is intact. Record changes store values before and after.
- Dashboard section listing records in currencies other than the vault currency, per currency, instead of hiding them.
- `tools/moliya-decrypt.mjs` (`npm run decrypt`): a dependency-free Node.js tool that lists and decrypts any backup version to a plain SQLite file.
- Golden backups made by 1.0.0 and 1.1.0 in `tests/fixtures/backups/`, pinned by SHA-256 and opened by every test run, plus browser tests that upgrade a real 1.0.0 vault.
- `docs/data-format.md`, the long-term specification of every stored format.
- CI for pull requests and branches (typecheck, unit tests, dependency audit, build, browser tests against the production build, dependency review), a release workflow for `vX.Y.Z` tags with checksums and build provenance, CodeQL, and Dependabot.
- Translations for all new text in Oʻzbekcha (Latin and Cyrillic), Russian, and English.

### Changed

- Amounts are stored as integer minor units (`amount_minor`) with ISO 4217 exponents, parsed and totalled exactly, and percentages are computed with exact half-even rounding. Amounts accept a dot or a comma and spaces between thousands; extra decimals are rejected instead of rounded.
- Backup and stored record format version 2: key-derivation parameters per person, and the app version, schema version, and timestamps recorded in the file.
- New and changed passwords use PBKDF2-SHA-256 with 600,000 iterations (was 200,000). Existing wraps are strengthened at each person's next sign-in. Any parameters within documented bounds are accepted, so older files keep opening.
- Saves use compare-and-swap: if the vault was changed in another tab or by an import, the app stops saving and says so instead of overwriting.
- Only one tab can have the vault unlocked at a time.
- The app requests persistent storage so browsers do not clear the vault under storage pressure.
- Pages, Chart.js, and SQLite load on demand; the first screen loads about half of the previous JavaScript and the build has no oversized chunks.
- Deploys publish the exact build that passed CI, through the `production` environment. All actions are pinned to commit SHAs.
- Node.js 22.12 or newer is required for development.
- Refreshed colour tokens for green and red text with better contrast in dark mode, and a narrower collapsed sidebar with centred icons.
- The Moliya name at the top of the sidebar links to the dashboard.

### Security

- Production builds include a Content Security Policy (`script-src 'self' 'wasm-unsafe-eval'`, no inline scripts, `object-src 'none'`, `form-action 'none'`).
- A vault or backup made by a newer version is refused with a clear message and left untouched, instead of being misread.

### Fixed

- Amounts such as 2.675 were rounded through floating point (to 2.68) and some sums could drift by a cent. Totals are now exact.

## [1.0.0] - 2026-09-29

First production release (commit `46105ec`).

Writes backup, record, and schema version 1.

### Added

- Encrypted vault (SQLite in memory, AES-256-GCM, per-person PBKDF2 key wraps) stored in IndexedDB.
- Admin, Manager, and Viewer roles, and groups.
- Income and expense records with categories, currencies, notes, and receipts.
- Dashboard with totals, savings rate, and four charts; period filters.
- Settings for the vault name, currency, and categories in four languages.
- Audit log, encrypted `.moliya` backups, day and night themes, and a collapsible sidebar.
- Deployment to GitHub Pages.

[Unreleased]: https://github.com/kool277/iqtisod/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/kool277/iqtisod/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/kool277/iqtisod/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/kool277/iqtisod/releases/tag/v1.0.0
