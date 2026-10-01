# Changelog

All notable changes to Jaybi (called Moliya up to 1.2.0) are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Data formats are versioned separately from the app. Each release lists the formats it reads and writes; the full specification is in [docs/data-format.md](docs/data-format.md).

## [Unreleased]

## [1.4.2] - 2026-10-01

Reads backup and record versions 1–2 and schema versions 1–4. Writes backup 2, record 2, schema 4, and export format 1, the same version numbers as 1.4.1. Every vault and backup made by an earlier version opens. Records and backups gain optional fields (a binding label on new password copies, an expiry on new codes, the audit head); see the [version matrix](docs/data-format.md#version-matrix). **1.4.1 cannot open password copies or codes created by 1.4.2**, so roll back only to a backup made before the upgrade.

### Security

This release fixes the findings of an authorized review of the app's cryptography, sign-in, and website in September 2026.

- **Password copies are bound to their person.** Someone who could edit a stored vault or backup could swap the email on two password copies and sign in as the other person, rewriting their credentials. Sign-in now loads the person named by the copy and requires the email, salt, and check value to match; relabelled or duplicate copies and codes are refused. New copies bind the person into their encryption (`aad: moliya/wrap/v1`).
- **Stronger export passwords.** Encrypted ZIP exports use a fast password check, so they now need a **strong** password, and the form starts with a generated one. Both encrypted formats refuse common passwords (also with look-alike characters such as `P@ssw0rd`) and passwords built from the vault name or members' emails.
- **A shortened or rewritten audit log is reported.** The audit log's fingerprint chain has no secret, so someone with the vault key could cut off or recompute it. Records and backups now carry the chain head, each browser remembers the furthest head it saw, and sign-in compares them. Admins see a warning with a link to the log and can accept it, which is audited. The documentation no longer calls the log tamper-proof; see Known limits.
- **Locking clears memory.** Every lock (manual, automatic, or for an update) reloads the page into sign-in, so decrypted data and keys from the session do not stay in memory. Decrypted copies made while opening, saving, and exporting are wiped. An automatic lock still returns to the same page after sign-in.
- **Private safe items look alike.** Items are padded to size classes (1 KiB, then powers of two up to 32 KiB) instead of 256-byte steps, so a PIN, a card, and a short note can no longer be told apart by size. Existing items open as before and move to a class when next saved.
- **Recovery tool (`npm run decrypt`).** Iterations are capped at 2,000,000 like the app, the database is scrubbed in a private temporary folder before it is written, key material is wiped after use, and a wrong password and a damaged file give the same message.
- **Sign-in failures stay visible.** The failed-attempt counters were cleared as soon as the password was right, before the sign-in check (authenticator code). They now clear only after a full sign-in, sign-ins stopped at the sign-in check are counted and audited, and the counters are kept in local storage and IndexedDB so clearing one does not reset them. The global counter no longer locks out an email with no failures of its own.
- **Setting the clock back no longer revives expired codes.** Each browser keeps a clock mark (`moliya.clock.v1`), and code expiry uses the later of it and the vault's own mark. New codes carry their expiry, bound into their encryption, and expired codes are removed from the stored vault at every load. A mark moves forward by at most two days per save, so one save under a wrong clock cannot block codes for years, and Admins can reset the marks from **People** with their password (audited as **Clock check reset**).
- **Member limit counts open resets.** A person whose password was stopped by a reset code no longer frees a slot, and using a reset code or a temporary password checks the limit.
- **Browser archives never keep codes.** The copies kept on upgrade and import are stored without one-time codes, older archives are cleaned when the vault loads, and archive downloads leave codes out, so a used or revoked code plus an old archive no longer opens the vault key.
- **Defense in depth.** A pending forced password change blocks every service, not only the screens; all-groups access comes from the permission, not the role name; only people managers see who has a sign-in check; the common-password check undoes look-alike characters, separators, and repeats, also around digits (`Summer2026Summer`); the automatic lock re-checks when a page returns from the browser's back/forward cache.
- **CSV exports quote every text cell.** In Excel with `;` as the list separator (the default for Russian and Uzbek), an unquoted cell such as `x;=1+1` was split and its second half ran as a formula. Text cells are always quoted, and a formula start after `;`, a tab, or a line break is neutralised like one at the start of a cell.
- **Strict schema check.** An opened or imported database must match the app's schema object by object, including the SQL of every table, index, trigger, and view, not only their names, so a crafted file cannot drop a `UNIQUE` or `CHECK` rule. The SQLite export's working connection gets the same hardening as every other connection.
- **Exchange-rate job.** A line break in an upstream bank's data could inject a GitHub Actions command into the job log. Messages are now escaped, and upstream values are quoted, ASCII-only, and shortened.

### Fixed

- The app starts when the browser blocks or fills local storage; the theme, language, and sidebar choices fall back to their defaults.
- An exchange-rate snapshot dated more than an hour ahead, cached or served, is ignored instead of winning over every real update.
- An expired code says it expired again, instead of "no open invitation".

### Changed

- Only the English strings ship in the first download. Russian and Uzbek load before the first screen, and when you switch to them. The first load is about 31 KB (gzip) smaller than 1.4.1 in English and about 17 KB smaller in the other languages, including the new security code.
- The SQLite worker and OPFS helper scripts, which the app never starts, are no longer published, and the build fails if a package update changes how they are referenced.
- `CODEOWNERS` also covers the rate job, the entry points, exports, the audit and clock code, and `package.json`.

### Docs

- `SECURITY.md` lists 1.4.x as supported and spells out the known limits. The admin guide, data format, developer guide, and README describe the new fields, the audit warning, clock marks, and archives.
- The DevOps guide now requires GitHub Pages domain verification (`_github-pages-challenge-kool277.jaybi.uz`) and warns that removing the custom domain without it lets someone else claim it. It adds `www` as a `CNAME` to `kool277.github.io`, SPF `-all`, DMARC moving from `quarantine` to `reject` with reports, a CAA record for Let's Encrypt, FTPS, and HSTS through a proxy.

### Known limits

Not addressed in this release, and listed in `SECURITY.md` and the admin guide:

- Audit entries are not signed by each person. Someone with a password and other tools can still rewrite the log; the new check only catches it on a browser that saw the log before.
- The vault key does not rotate when a person is removed or a password is reset. That needs a key pair per person (ECDH) so an Admin can re-wrap a new key.
- Passwords are stretched with PBKDF2-SHA-256 (600,000 rounds), not a memory-hard function such as Argon2id.
- Private safe items can be put back to an older copy by someone with the vault key; a new item format with the revision in its additional data is planned.
- The unencrypted fields of the vault file (dates, app and schema versions) are not covered by one authentication tag.
- Older password copies are not rewritten with the new binding until the password changes; they rely on the salt and check-value match.
- GitHub Pages cannot send HSTS or other security headers; that needs a proxy such as Cloudflare.

## [1.4.1] - 2026-10-01

Reads backup and record versions 1–2 and schema versions 1–4. Writes backup 2, record 2, schema 4, and export format 1, the same as 1.4.0. No data format changes.

### Fixed

- **Links to a page no longer end on "404".** Opening, refreshing, or sharing an address written as a path, such as `https://jaybi.uz/app/transactions`, `https://jaybi.uz/register`, or an old link that still has `/iqtisod/` in it, showed GitHub's "404 File not found". The site now has its own 404 page that opens the same page in the app (`https://jaybi.uz/#/app/transactions`), keeping a filter such as `?group=3`. It only ever opens a page of this site: anything unusual in the address (other characters, `..`, `//`, a very long path) opens the start page instead, and a missing file such as an old `assets/` script still answers "not found".
- **After signing in you are back on the page you asked for.** A link opened while the vault was locked, and a page left open when the vault locked after inactivity, used to show the dashboard after sign-in. Sign-in now returns to that page (`#/login?next=…`, which only accepts pages inside the app). **Lock** still ends the visit: whoever signs in next starts on the dashboard.
- **Unknown addresses say so.** An address inside the app that matches no page used to jump to the dashboard without a word; it now shows **Page not found** with a button back to the dashboard, in all four languages.
- **Skip to content** (the first Tab stop) moved to the dashboard instead of to the page's content.

## [1.4.0] - 2026-09-29

Reads backup and record versions 1–2 and schema versions 1–4. Writes backup 2, record 2, schema 4, and export format 1, the same as 1.3.1. No data format changes: 1.3.0 and 1.3.1 open everything 1.4.0 saves. The new table export is a separate write-only file described under [Exports](docs/data-format.md#table-view-exports).

### Added

- **Tables with sorting, search, filters, and column choices** on Transactions, People, Open codes, Groups, Audit log, Categories, earlier copies on the Backup page, and the private-safe item, trash, and activity lists:
  - Choose a column heading to sort (again for the other direction, a third time to clear); Shift-choose adds up to three sort columns. Amounts sort exactly and per currency, dates by date, and text in the order of the chosen language.
  - **Search this table** looks at the visible columns and ignores case, accents, apostrophes, and script, so `taksi`, `Такси`, and `Taksi` find the same record, and `oʻzbek`, `ozbek`, and `ўзбек` match.
  - **Filters** per column: text, one or more values, a date range, or a number or amount range. A badge shows how many are on; **Clear filters** removes them.
  - **Columns** shows, hides, and reorders columns, switches to compact rows, and resets the layout. The layout, sort, and rows per page are remembered per table in this browser (`moliya.table.<id>`). Search text and filters are never stored.
  - 10, 25, 50, 100, or all rows per page, with "Showing 1–25 of 140 (filtered from 900)".
  - **Export** downloads exactly what the table shows (visible columns, filtered and sorted rows) as CSV, Excel, PDF, or JSON. Only Admins can export, and only from tables they can open. Each export is written to the audit log as **Data exported** with the table, columns, row counts, and period. The file is not encrypted, so you tick "I understand" first. Private safes cannot be exported.
  - **Edit in place** on Transactions (date, category, group, amount, notes) and Categories (the four names): choose the pencil, then Enter saves and Esc cancels. Errors show under the field. The change goes through the same checks, permissions, and audit entry as the full form, which stays available under **Edit**.
  - **Delete selected** on Transactions for people who can delete records, with a confirmation. Each deletion is audited on its own.
  - On a phone, rows become cards with labels, and a **Sort by** menu replaces the headings.
- **Group filter on the dashboard.** Next to the period buttons, **All groups** or one group narrows the four totals, the charts, and the per-currency list. The exchange-rate panel is not affected. Admins can pick any group; Managers and Viewers only see their own group, so the choice there is **All groups** or that group, which show the same figures. The choice is remembered in this browser (`moliya.dashboard.group`) and ignored if the group is removed or not yours. With one group chosen, Admins see **Who spent** instead of **Spending by group**.
- **Income, expenses, and net per group.** The **Groups** table has sortable **Income**, **Expenses**, **Net**, **Transactions**, and **Last activity** columns for the selected period. A group with records in several currencies shows one line per currency in each amount cell; amounts in different currencies are never added together or converted, and sorting uses the vault currency. With two or more groups, an **All groups** strip above the table combines them, again per currency.
- **From a group to its records.** Choosing a group's name on **Groups** opens **Transactions** with the group filter already set, for the same period. The link (`#/app/transactions?group=<id>`) only applies a group the reader can already see; any other value is ignored, so it never shows more than the ledger would.
- The period buttons and the **All / Income / Expense** filter now sit in the ledger table's toolbar.

### Changed

- Exchange rates are easier to read: each rate's change is shown in dark green when it went up and dark red when it went down, in a lightly tinted pill with an arrow and a screen-reader label. Each direction gets a thin accent line in the same color, and the converter result is shown in green. Every colored label meets WCAG AA contrast (at least 4.5:1) in the light and dark themes.
- Managers and Viewers can open **Groups** and see their own group's summary, read-only. Adding and removing groups stays Admin-only.
- The audit log shows up to the latest 10,000 entries instead of 200, 100 per page by default.
- Categories are one table with a Type column instead of two lists.
- Search inside a private safe now also matches the card, subscription, or note details shown in the list (never card numbers beyond the last four, CVV, or note text), and ignores accents and script.
- The table strings load with the first page that shows a table, so the first screen stays within 1.3 KB (gzip) of 1.3.1.
- Playwright uses `E2E_PORT` when set, and the dev server fails instead of switching ports when the port is taken.
- Two tests that failed now and then no longer do: the invite-code browser test accepts every check symbol a code can end with (`*`, `~`, `$`, `=`, `U`), and the timing checks for hostile input take the fastest of five runs.

### Docs

- The user, admin, developer, and DevOps guides, the README, the data format, and `SECURITY.md` are brought up to date for 1.3.1 and `jaybi.uz`, then for this release: tables, the dashboard group filter, group summaries, the ledger link, and table exports.

## [1.3.1] - 2026-09-29

Reads backup and record versions 1–2 and schema versions 1–4. Writes backup 2, record 2, schema 4, and export format 1, the same as 1.3.0. No data format changes.

### Fixed

- Private safes no longer lock while you are using them. They had their own 5-minute idle timer (1, 5, 15, or 30 minutes in Account) that was separate from the vault's, and they also locked when the tab had been hidden for more than 60 seconds, for example while you switched to another tab to pay with a card, both shown as "Your safes were locked after a period of inactivity." Safes now stay open until you choose **Lock safes**, lock the vault, refresh or close the tab, or the vault locks by itself after the time under **Account → Lock automatically** (15 minutes by default). Activity anywhere in the app, including inside safes, keeps both open. When the vault locks, the safe keys are still removed from memory.
- The inactivity notice is shown only when that was the reason: the sign-in screen now says "The vault was locked after a period of inactivity." after an automatic lock, and not after **Lock**.

### Changed

- The **Lock safes after inactivity** choice is removed from **Account → Private safes**, which now explains that safes lock with the vault. The stored preference is kept unchanged in the encrypted safe settings, so 1.2.0 and 1.3.0 still read it, but it is no longer used.
- Idle activity is detected in the capture phase, so clicks and keys in parts of the page that stop event propagation still count.

## [1.3.0] - 2026-09-29

Reads backup and record versions 1–2 and schema versions 1–4. Writes backup 2, record 2, schema 4, and the new write-only export format 1. Vaults and backups made by 1.0.0, 1.1.0, and 1.2.0 upgrade automatically on first sign-in, and the original stored copy is kept in the browser. Moliya 1.1.0 and 1.2.0 refuse a schema 4 vault or backup with "made by a newer version" and leave it untouched. The 1.2.0 recovery tool still decrypts schema 4 backups but does not remove the new sign-in check and code data from its output.

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
- **Export data** on the Backup page (Admins only), replacing the 1.1.0 unencrypted CSV and SQLite buttons: CSV, JSON, JSON Lines, Excel workbook, PDF report, and SQLite database, for all data or a selected period, all groups or one group, with the audit log and receipt images as options (receipts off by default). The PDF lists up to 10,000 records.
- Encrypted exports: AES-256 ZIP (the default; opens in 7-Zip, WinZip, WinRAR, and Keka, not in the built-in Windows or macOS tools) and an SQLCipher 4 database (opens in DB Browser for SQLite and `sqlcipher`), with a password generator, strength meter, and cancel. Unencrypted exports need an explicit confirmation.
- "Data exported" audit entry with the formats, protection, scope, and counts, never content or passwords. Entries written by 1.1.0 keep their "Unencrypted export" label.
- JSON Schemas for the `moliya-export` format version 1 in `docs/schemas/`, and an Exports section in `docs/data-format.md` with the exact SQLCipher and ZIP details.
- Exchange rates on the dashboard: official rates for UZS↔USD, KRW↔USD, and ILS↔USD from the Central Bank of Uzbekistan, the European Central Bank (won, as a cross rate via the euro), and the Bank of Israel, with the rate date, a link to the source, the change since the previous official rate, and a Stale badge after 2 business days.
- Converter between USD and soʻm, won, or shekel, rounded half-even to the currency's minor unit (whole won for KRW), with the exact value alongside.
- Exact decimal arithmetic (`src/lib/decimal.ts`), a dependency-free BigInt decimal with explicit scale, precision, and rounding mode; no exchange-rate figure passes through floating point.
- `fx-rates.yml` workflow and `npm run rates:fetch`: fetches the three central banks twice a day, cross-checks them against each other, rejects implausible values and unconfirmed jumps over 10%, keeps every published snapshot and raw response on the `fx-data` branch, and publishes `rates/latest.json` on the site.
- Specification of the published rates snapshot in `docs/data-format.md`, recorded central-bank responses in `tests/fixtures/fx/`, and unit and browser tests for the rates and the converter.
- Translations for all new text in Oʻzbekcha (Latin and Cyrillic), Russian, and English.

### Changed

- New passwords need 12 to 256 characters, must not be common (a built-in list, even with digits or symbols added), repetitive, a keyboard run, or built from the email or vault name. Existing passwords keep working; people whose password falls short see a banner asking them to change it. (Audit 2)
- Importing a backup on the setup screen works only when the browser has no vault. Replacing an existing vault checks `IMPORT_VAULT`, asks for the password and the vault name, writes "Vault replaced by a backup" into the old vault, and keeps it as **Before import**. (Audit 5)
- The import cap rises from 20 MiB to 72 MiB to match the database budget, so every vault the app allows can be imported again. (Audit 6)
- Receipts must be PNG, JPEG, WebP, or GIF with a matching file signature. SVG is refused. Existing receipts are kept. (Audit 11)
- Group names and the setup vault name are limited to 80 characters. (Audit 10)
- A vault holds at most 256 people. Adding a person, creating an invite, and accepting one are refused once the people and open invites would exceed what a backup can hold.
- Adding a person with a temporary password ends any open invite for that email. Removing a person ends their codes.
- The SQLite export is built from an allowlist of tables into a fresh file (4096-byte pages) instead of a scrubbed copy of the vault, so tables added later are never exported by accident. CSV gains `category_id`, `group_id`, and `user_id` columns at the end.
- `npm run decrypt` (unless `--keep-keys` is given) removes sign-in check rows and code verifiers. `npm run decrypt --list` shows pending codes by kind and email.
- Deploys include the latest published rates in `rates/`. The browser still connects only to the site itself.
- CI installs with `npm ci --ignore-scripts` and runs `npm audit signatures`. Dependabot waits 7 days before proposing a release. `CODEOWNERS` requires the owner's review for key handling, storage, auth, grants, users, the sign-in check, limits, what the browser loads, fixtures, the lock file, and CI.

### Security

- Attempt limits slow down password, code, and sign-in check guessing in the app. They do not protect a copied vault or backup against offline guessing; only a strong password does. (Audit 3)
- The main vault now locks after a period without activity. (Audit 4)
- The stricter Content Security Policy: `default-src 'none'`, `style-src 'self'` without `'unsafe-inline'`, no `blob:`, `base-uri 'none'`, `frame-src` and `child-src 'none'`, `upgrade-insecure-requests`, and Trusted Types with a `default` policy that allows only the isolation service worker's URL. The charset, `referrer: no-referrer`, and the policy are the first tags in `<head>`. (Audit 15)
- The app refuses to run inside a frame and offers a link to open it in its own tab. The isolation service worker does not register when framed. (Audit 16)
- Every decrypted database is hardened (defensive mode, `trusted_schema` off, `cell_size_check`, 8 MiB value limit, `ATTACH` disabled) and must match the schema the app's own migrations create before it is used. `PRAGMA quick_check` runs on every open. (Audit 13)
- Envelope and backup readers enforce caps: 1–256 wraps, at most 64 code wraps, salts of 16–64 bytes, ciphertext up to 64 MiB, KDF iterations up to 2,000,000 in the app, JSON size, depth, and prototype keys. (Audit 14)
- Sign-in with an unknown email, and a code for an unknown email, spend the same key-derivation time as a real attempt, and verifiers are compared in constant time. (Audit 8)
- The CSV formula guard also catches leading whitespace, line feeds, and full-width `=`, `+`, `-`, and `@`. (Audit 12)
- Exports never contain private safes, password verifiers or salts, key wraps, sign-in check secrets, or code verifiers, in any format. Export passwords need at least 14 characters and cannot be the sign-in password; they are never stored or logged. Export libraries load only when an export starts and run under the same Content Security Policy and Trusted Types rules, with jsPDF's HTML and SVG helpers left out of the build.
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

[Unreleased]: https://github.com/kool277/iqtisod/compare/v1.4.2...HEAD
[1.4.2]: https://github.com/kool277/iqtisod/compare/v1.4.1...v1.4.2
[1.4.1]: https://github.com/kool277/iqtisod/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/kool277/iqtisod/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/kool277/iqtisod/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/kool277/iqtisod/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/kool277/iqtisod/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/kool277/iqtisod/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/kool277/iqtisod/releases/tag/v1.0.0
