# Changelog

All notable changes to Moliya are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Data formats are versioned separately from the app. Each release lists the formats it reads and writes; the full specification is in [docs/data-format.md](docs/data-format.md).

## [Unreleased]

### Added

- **Export data** on the Backup page (Admins only): CSV, JSON, JSON Lines, Excel workbook, PDF report, and SQLite database, for all data or a selected period, all groups or one group, with the audit log and receipt images as options.
- Encrypted outputs: AES-256 ZIP (default; opens in 7-Zip, WinZip, WinRAR, Keka) and SQLCipher 4 database (opens in DB Browser for SQLite and `sqlcipher`), with a password generator and strength meter. Unencrypted exports need an explicit confirmation.
- `DATA_EXPORTED` audit entry with formats and scope (never content or passwords).
- JSON Schemas for the `moliya-export` format version 1 in `docs/schemas/`.

### Changed

- CSV formula protection now also covers line feeds, leading spaces, and the full-width `＝＋－＠` characters. CSV gains `category_id`, `group_id`, and `user_id` columns at the end.
- The SQLite export copies an allowlist of tables into a fresh file instead of copying the whole vault.
- Downloads keep their object URL for 60 seconds, so large files finish in Safari and Firefox.

### Security

- Private safes, password hashes, and other secrets are never exported; new tables are excluded until explicitly allowed.
- Export passwords need at least 14 characters and cannot be the sign-in password.

### Data formats

- Reads and writes the same vault, backup, and schema versions as before. New: export format version 1 (write-only).

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

[Unreleased]: https://github.com/kool277/iqtisod/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/kool277/iqtisod/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/kool277/iqtisod/releases/tag/v1.0.0
