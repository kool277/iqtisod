# iqtisod

Take control of your finances without handing them to anyone.

iqtisod is the repository for **Moliya**, a private income and expense ledger for a person, a family, or a small team. It runs entirely in the browser. There is no server, no account to sign up for, and no analytics. The ledger is an SQLite database encrypted with AES-256-GCM and stored on your device. The website itself is only static files, so it can be hosted free on GitHub Pages.

## Why it exists

Most budgeting apps ask you to trust a company with your bank-level details. Spreadsheets keep the data local, but they are easy to lose, hard to share safely, and have no access control. Moliya sits between the two:

- **Private by default.** Records are encrypted before they are saved. The hosting provider only ever serves the app's code and never sees your numbers.
- **Shared without a server.** Several people can use the same vault, each with their own password and role.
- **Understandable at a glance.** A dashboard shows where the money came from and where it went for any period.
- **Local language.** The interface is available in Oʻzbekcha (Latin and Cyrillic), Russian, and English.

It suits a household tracking a shared budget, a small business or community group keeping simple books, or anyone who wants a finance tool that works offline once loaded and keeps data on their own device.

## Features

- Encrypted vault created on first run with a master (admin) password.
- Three roles: **Admin** (everything), **Manager** (add, edit, and delete records for their group), and **Viewer** (read-only dashboard and ledger for their group).
- Groups, so one vault can hold separate budgets (for example "Home" and "Shop").
- Income and expense records with category, date, currency, notes, and an optional receipt photo.
- Timeline filters for today, this week, this month, last month, year to date, or a custom range.
- Dashboard with net balance, total income, total expenses, savings rate, and four charts: monthly income against expenses, expenses by category, spending over time, and spending by group or by person.
- Official exchange rates on the dashboard for soʻm, won, and shekel against the US dollar in both directions (UZS↔USD, KRW↔USD, ILS↔USD), from the Central Bank of Uzbekistan, the European Central Bank, and the Bank of Israel, with the rate date, the source, the change since the previous rate, a stale warning, and an exact converter. Rates are fetched and cross-checked once or twice a day by a GitHub Actions job and published on the same site, so the browser never contacts a third party.
- Admin settings page for the vault name, vault currency, and income and expense categories in all four languages.
- Collapsible sidebar that remembers its state.
- Exact money: amounts are stored as whole minor units (cents, tiyin) and never rounded, with per-currency subtotals for records outside the vault currency.
- Tamper-evident audit log of every change, with before and after values.
- Encrypted backup file (`.moliya`) for moving a vault to another browser or keeping a safe copy, with a reminder when the last backup is older than 7 days.
- Unencrypted CSV and SQLite exports for spreadsheets, accountants, and long-term archiving.
- Versioned data formats: every vault and backup made by any release keeps opening in every later release, and a standalone tool opens backups without the website.
- In-app version display and a prompt to reload when a new version is deployed.
- Day, night, and system themes. Language and theme choices are remembered.

## How it works

```mermaid
flowchart LR
  password[UserPassword] --> kdf["PBKDF2 600k"]
  kdf --> kek[UserKey]
  kek -->|unwrap| dek[VaultKey]
  dek -->|decrypt| db[SQLiteInMemory]
  db -->|export and encrypt| idb[IndexedDB]
  idb -->|download| backup[BackupFile]
```

1. A random 256-bit **vault key** encrypts the whole SQLite database.
2. Each person's password is stretched with PBKDF2 (SHA-256, 600,000 iterations, 32-byte salt) into a **personal key**, which wraps a copy of the vault key. Adding a person adds one more wrapped copy. Wraps made by 1.0.0 (200,000 iterations) still open and are strengthened at the person's next sign-in.
3. Signing in unwraps the vault key and decrypts the database into memory. Nothing readable is written to disk.
4. Changes are re-encrypted and saved to the browser's IndexedDB within about a second of each edit, every 5 seconds while changes are pending, and when the tab is hidden or the vault is locked.

Refreshing or closing the tab locks the vault. Signing in again is required.

## Versions and data longevity

Moliya uses [Semantic Versioning](https://semver.org/); see the [changelog](CHANGELOG.md). The database schema, the stored browser record, and the backup file each carry their own format version, independent of the app version, and every backup records the app version that made it.

Every release must open every vault and backup ever produced, for at least ten years. Upgrades run automatically on first sign-in, one step at a time, inside transactions, and keep the original copy in the browser. Real backups from each release are kept in `tests/fixtures/backups/` and must open, with exact totals, in every build. The formats are specified in [docs/data-format.md](docs/data-format.md), and `npm run decrypt` opens any backup with Node.js alone.

## Quick start

Requirements: Node.js 22.12 or newer and npm.

```bash
npm install
npm run dev
```

Open the address Vite prints (usually `http://localhost:5173`), create a vault, and start adding records.

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the development server |
| `npm run build` | Type-check and build static files into `dist/` |
| `npm run preview` | Serve the built `dist/` locally |
| `npm run typecheck` | Type-check only |
| `npm test` | Run unit tests, including every golden backup (Vitest) |
| `npm run test:e2e` | Run browser tests (Playwright) against the dev server. Run `npx playwright install chromium` once first |
| `npm run test:e2e:preview` | Build, then run the browser tests against the production bundle, as CI does |
| `npm run rates:fetch -- --out .fx-data` | Fetch, validate, and write an exchange-rate snapshot (copy `.fx-data/rates` to `public/rates` to see live rates in `npm run dev`) |
| `npm run decrypt -- <file> --list` | Open a backup without the website (see the [admin guide](docs/admin-guide.md#opening-a-backup-without-the-website)) |

## Documentation

- [User guide](docs/user-guide.md) is for Managers and Viewers who record and review money.
- [Admin guide](docs/admin-guide.md) covers setting up a vault, settings and categories, people, groups, backups, and recovery.
- [Developer guide](docs/developer-guide.md) covers architecture, code layout, conventions, and how to extend the app.
- [DevOps guide](docs/devops-guide.md) covers building, CI, releases, GitHub Pages, other hosts, and operational risks.
- [Data format](docs/data-format.md) specifies every stored format and the rules that keep old data readable.
- [Changelog](CHANGELOG.md) lists what changed in each release.

## Security in one paragraph

Data is protected by encryption at rest and by passwords. It is **not** protected from someone who already holds a valid password: the vault is a single encrypted database, so any person who can sign in could, with developer tools, read every group's records, not only their own. Roles control what the app shows and allows, not what the cryptography hides. Email addresses are stored unencrypted next to the ciphertext so the app knows whose key to try. There is no password recovery. If every password is lost, the data cannot be recovered. See the [admin guide](docs/admin-guide.md#security-limits-to-know) for the full list.

## Tech stack

React 19, TypeScript, Vite, Tailwind CSS 4, Chart.js, Lucide icons, `@sqlite.org/sqlite-wasm`, the Web Crypto API, Vitest, Playwright, GitHub Actions, CodeQL, and Dependabot.

## Status

Version 1.1.0, in production since 1.0.0. The core features work and are covered by unit tests, browser tests, and golden backups from every release. Known gaps and suggested next steps are listed in the [developer guide](docs/developer-guide.md#known-gaps-and-next-steps).
