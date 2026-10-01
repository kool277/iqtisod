# Admin guide

This guide is for the person who owns a Jaybi vault. Admins can do everything in the [user guide](user-guide.md) and can also manage people, groups, vault settings and categories, the audit log, and backups.

## Key ideas

- **A vault is one encrypted database in one browser.** It lives in that browser's storage for that website address. A different browser, device, browser profile, or website address starts with no vault.
- **Every person has their own password.** Each password unlocks the same vault. Removing a person removes their key from the vault.
- **Nobody can recover a lost password**, including the developers. Keep at least two Admin accounts, and keep a recent backup.
- **Private safes are not yours to see.** Every person, Admins included, can keep private safes for cards, subscriptions, and notes. They are encrypted with keys only their owner holds. As Admin you cannot see them, list them, open them, or recover them, even with the decrypted database, a backup, or the recovery tool. See [Private safes and Admins](#private-safes-and-admins).

## First run: creating the vault

1. Open the app. With no vault in this browser you will see **Create your vault**.
2. Fill in:
   - **Vault name**: shown in the top bar. It also becomes the name of the first group.
   - **Admin email**: your sign-in name. It is stored in lowercase.
   - **Master password** (twice): at least 12 characters, not a common password, and not built from your email or the vault name. Use a long passphrase of a few unrelated words. This is your admin password, and it is the only thing that protects backups against guessing.
   - **Currency**: USD, UZS, EUR, or RUB. Totals are calculated in this currency only. You can change it later under **Settings**.
3. Choose **Create encrypted vault**. You are signed in and taken to the dashboard.

Your admin account does not belong to any group, so you see every group's records.

## Roles

| Permission | Admin | Manager | Viewer |
| --- | --- | --- | --- |
| View dashboard and ledger | All groups | Own group | Own group |
| Add, edit, delete records | All groups | Own group | No |
| Manage people and groups | Yes | No | No |
| Vault settings and categories | Yes | No | No |
| Audit log | Yes | No | No |
| Download backups, export data, replace the vault with a backup | Yes | No | No |
| Own private safes, own password, own sign-in check (Account) | Yes | Yes | Yes |
| See or open anyone else's private safes | No | No | No |

Managers and Viewers must belong to exactly one group. An Admin can optionally be placed in a group, but still sees everything.

## Groups

Open **Groups**.

- **Add a group**: type a name and choose **Add group**. Use groups to separate budgets, for example "Home" and "Shop", or one group per family branch.
- **Remove a group**: only possible when no people and no records belong to it. Move or delete those first.
- **Summaries**: the table shows each group's **Income**, **Expenses**, **Net**, **Transactions**, and **Last activity** for the period chosen with the period buttons. A group with records in several currencies has one line per currency in each amount cell. Sorting by an amount uses the vault currency; amounts in other currencies are never added in or converted. With two or more groups, the **All groups** strip above the table combines them, again per currency. Managers and Viewers can open **Groups** too, but they only see their own group's summary and cannot add or remove groups.
- **Records of one group**: choose a group's name to open **Transactions** with that group's filter already set, for the same period.

Groups cannot be renamed from the app yet.

## People

Open **Users** (the page is titled **People**).

### Inviting a person

An invite is a one-time code. The person enters it with their email and chooses their own password, so you never know it.

1. Under **Invite someone**, enter **Their email**.
2. Choose how long the code works under **Code works for**: 15 minutes, 1 hour, 24 hours (the default), 3 days, or 7 days. Shorter is safer.
3. Choose a **role**, and a **group** for Managers and Viewers. You can invite another Admin; Admins need no group.
4. Choose **Create invite code**.

Jaybi shows the code once, with the time it stops working. **Copy code** copies the code; **Copy link** copies a link that opens the join page with their email and the code filled in. Jaybi clears the clipboard after 60 seconds where the browser allows it. Choose **Done** when you have passed it on. The code is not stored anywhere in readable form, so it cannot be shown again. If it is lost, revoke it and create a new one.

Give the code in person, or over a channel you trust (not a group chat, not a public email thread). The person then follows [Joining with a code](user-guide.md#joining): on **Unlock vault** they choose **Have a one-time code? Join the vault**.

**A code works only in the browser where the vault is stored.** There is no server: the code opens the vault that is in this browser's storage, nowhere else. If the person opens the app on their own phone or computer, they see an empty setup screen and the code does nothing there. Either they join on this device, in this browser, or you [move a copy](#moving-to-another-device) of the vault to their device first; a backup made while the code is open contains it.

Things to know:

- **Backups made before the code is used contain it.** Jaybi shows this warning with every code: "Backups made before the code is used also contain it. Anyone with such a backup and the code can join until it expires. Revoke the code if it was shared by mistake." Expiry and revocation are checked by the app on the device that holds the copy. Someone with an old backup, the code, and a computer clock set back could still open that old copy after the code expired. Use short validity, and do not hand out backups while codes are open.
- **One open code per email.** Creating another code for the same email is refused until you revoke the first. At most 20 invites can be open at once.
- **The device clock matters.** Codes use this device's clock. If it is more than 5 minutes behind the latest time the vault or this browser has seen, creating and using codes is refused with "This device’s clock is behind…". Correct the date and time. If a clock that was wrong in the future pushed that time ahead, the refusals continue for up to two days after the clock is corrected (each save or visit can move it forward by at most two days); an Admin can end them at once under **People → Clock check for codes → Reset to the current time**, with their password. This is recorded as "Clock check reset".
- **Failed attempts are limited.** Wrong codes count like wrong passwords (see [Security limits](#security-limits-to-know)).

### Open codes

**Open codes** lists every invite and reset code that has not been used, revoked, or cleaned up yet, with the email, **Invite** (with role and group) or **Password reset**, and when it **Expires**. Codes past their time show **Expired**. Expired codes are ended and removed the next time anyone signs in, and the audit log shows "Code expired".

Choose **Revoke** to end a code at once, for example if it was sent to the wrong person. Revoking does not undo **Stop their current password from working now**; see below.

### Adding a person with a temporary password

**Advanced: set a temporary password instead** opens the old way of adding people: enter their **Email**, a **Password**, a role and a group, and choose **Add user**. The password must follow the same rules as any other (at least 12 characters, not common). Give it privately. At their first sign-in Jaybi makes them choose a new password that only they know, and every page leads to **Account** until they do.

Prefer an invite. With a temporary password you know their password until they change it, and a backup made in between opens with it. Adding someone this way ends any open invite for the same email.

After joining, people change their password themselves under **Account → Change password**.

### Resetting a password

Choose **Issue reset code** on the person's row. The same form shows a warning about private safes, a **Code works for** choice (24 hours by default), and a box, ticked by default:

- **Stop their current password from working now**: choose this if someone else may know the password. The old password stops working as soon as the change is saved, and the person cannot sign in at all until they use the code. If the code expires or you revoke it, they stay locked out until you issue a new code or set a temporary password.
- Untick it if the person simply forgot their password. The old password keeps working until the code is used.

Choose **Issue reset code**. The code is shown once, as for invites. The person uses it with **Have a reset code?** on **Unlock vault** and chooses a new password; see [Resetting your password with a code](user-guide.md#reset-code). Using the code also turns off their sign-in check. Issuing a new reset code for the same person replaces the open one they had; the audit log shows the old one as revoked.

**Set a temporary password instead** (in the same form) is the advanced option: enter a **New password** and choose **Save**. The old password stops working when the change is saved, any open reset code for the person is ended, their sign-in check is turned off, and at their next sign-in they must replace the temporary password. Give it privately.

The form always warns about private safes, whether or not the person has any, so the warning does not tell you whether they use them. With a reset code the warning says they choose the new password themselves when they use the code; with a temporary password it says they must choose one at their next sign-in. What the warning means in both cases:

- Their safes stay locked. They open only with the password the person chose before the reset, or their recovery code, together with their new password. Jaybi never opens safes with a password an Admin set.
- You cannot open or recover their safes.
- If they have no recovery code and have forgotten their previous password, their safes are lost for good. They can then reset their safes and start again with empty ones.

If you set a temporary password, tell the person not to type it as their "previous password".

You cannot reset your own password from **Users**. Use **Account → Change password**, which needs your current password and also moves your own safes to the new one. If you have forgotten your password, another Admin must reset it.

### Turning off someone's sign-in check

People who turned on the [sign-in check](user-guide.md#sign-in-check) show **Sign-in check on** next to their role. If they lose both their authenticator app and their recovery codes, choose **Turn off sign-in check** on their row and confirm. They can then sign in with their password alone and set it up again. Do this only after you have confirmed who is asking. You cannot turn off your own check here; use **Account**, which asks for your password.

### Removing a person

Choose **Remove** and confirm. The dialog always warns that removing a person also permanently destroys their private safes; nobody can recover them afterwards. Any open reset code for them ends too. Removal is blocked in three cases:

- The person still has records. Delete or reassign those records first.
- The person is the last Admin.
- The person is you.

Changing someone's role or group after creation is not available from the screen yet. For now, remove the person and add them again with the new role (possible only if they have no records), or ask a developer to expose the existing `updateUser` service.

## Private safes and Admins

Private safes are described for users in the [user guide](user-guide.md#private-safes). As Admin you have your own safes like everyone else. For other people's safes:

| You can | You cannot |
| --- | --- |
| Issue a reset code or set a temporary password (their safes stay locked until they open them with their previous password or recovery code) | Open, list, or read anyone else's safes, including names, item types, and dates |
| Remove a person, which destroys their safes | Recover a person's safes for them |
| Back up and import the vault; safes travel inside it, still encrypted | Export safes in plain form; the unencrypted exports and the recovery tool leave them out |

Things to know:

- **Backups carry safes.** Importing an older backup also brings back the safes as they were then. People sign in with the passwords that were valid when the backup was made, and their safes open the way they did at that time (with the password they had then, or their recovery code from then).
- **Deleting is not complete until old copies are gone.** When a person deletes items or a safe, or you remove the person, the data is removed from the vault, but older backups and the earlier copies in this browser (up to three) still hold it in encrypted form.
- **Encourage recovery codes.** Recovery codes are optional. Anyone who skipped theirs loses their safes if you reset their password and they have forgotten their previous one.
- **What remains visible.** With the decrypted database you can still see how many safes and items each person has, roughly how large each item is, when items were deleted, and when rows changed. You cannot see what they are.
- **Limits of the protection.** Safes do not protect against a compromised device or browser, or against someone who changes the app's code. An Admin who resets a person's password and also tampers with the database could trick that person into storing new secrets under a key the Admin controls; secrets stored before the reset stay protected. Deleting rows or restoring an older backup is not detected. The full list is in [data-format.md](data-format.md#what-the-safe-layer-does-not-protect).

## Settings

Open **Settings**. Only Admins see this page.

### General

- **Vault name**: shown in the top bar for everyone. Up to 80 characters. Renaming the vault does not rename the first group.
- **Vault currency**: the currency used for totals and charts. Changing it does not convert existing records. Records in the old currency stay in the ledger, marked "Other currency", and stop counting towards totals. Change the currency before people start recording, or be ready to re-enter records.

Choose **Save settings**. The top bar updates immediately, and the change is encrypted and saved like any other edit.

### About this version

At the bottom of **Settings**, **About this version** shows the app version, the build, the data schema, vault, and backup format versions, and when the vault was created. Include these details when you report a problem. The app version is also shown at the bottom of the sidebar and on the sign-in screen.

### Categories

Categories are listed in one table with a **Type** column; filter it to see only income or only expense categories.

- **Add a category**: choose Income or Expense, type the English name, and optionally the Oʻzbekcha (Latin and Cyrillic) and Russian names. A blank translation shows the English name. Names can be up to 60 characters.
- **Edit**: fixes a name or adds missing translations, either in the form under **Edit** or one name at a time with the pencil next to it (Enter saves, Esc cancels). A category cannot switch between income and expense. Records keep pointing to the same category, so they show the new name everywhere.
- **Remove**: only possible when no records use the category, and at least one other category of the same type remains. Otherwise, edit it instead.

## Audit log

**Audit log** shows the latest 10,000 actions (100 per page; choose more under **Rows**) with time, who did it, and what happened. Filter by date range, person, or action, or search, to find one entry among thousands; **Columns** adds the entity, its id, and the stored details. It records: vault created, settings changed, categories added, edited, or removed, users added, updated, removed, or password reset, people changing their own password, groups added or removed, records added, updated, or deleted, backups downloaded, data exported (older entries say "Unencrypted export"), data format upgrades, and password protection upgrades. Record changes keep the values before and after the change.

From 1.3.0 it also shows:

| Entry | When |
| --- | --- |
| Invite code created | You created an invite. Shows the email, role, group, and expiry, never the code |
| Invite code revoked | An invite was revoked, or ended because you added the same person with a temporary password |
| Invite accepted | Someone joined with an invite code |
| Reset code issued | You issued a reset code, and whether the old password was stopped |
| Reset code revoked | A reset code was revoked, replaced by a newer one, or ended by a temporary password |
| Password reset with code | Someone set a new password with a reset code |
| Code expired | An invite or reset code passed its time unused. Written at the next sign-in, with no person attached |
| Vault replaced by a backup | An Admin replaced the vault. Written into the old vault, which is kept as **Before import** |
| Failed sign-in attempts seen | Someone completed a sign-in after failed attempts for their email in this browser, with the count. From 1.4.2 it also counts sign-ins where the password was right but the sign-in check was not passed (wrong code, cancelled, or timed out); the person sees both counts in a banner |
| Clock check reset | An Admin reset the clock check for codes to the current time |
| Audit log accepted after a warning | An Admin accepted the audit log after Jaybi warned that it was shorter or different than this browser last saw it, with the warning's details |
| Sign-in check turned on / Sign-in check turned off | A person turned their own sign-in check on or off |
| Sign-in check removed | An Admin turned off someone's sign-in check, or a password reset turned it off |
| Sign-in recovery code used | Someone signed in with a sign-in recovery code |

No code, password, or authenticator secret is ever written to the log. The log lives inside the encrypted vault, so it is included in backups. Nothing about private safes is written to it: each person's safe activity is kept in their own encrypted activity list, which only they can read.

Entries cannot be edited or deleted from the app. Each entry also contains a fingerprint of the one before it, so **Integrity** at the top of the page shows **Broken** if an entry in the middle was changed or removed outside the app, for example by damage to the file or by someone editing a decrypted copy. If it ever shows **Broken**, restore from a backup you trust and find out who had access to the passwords.

The fingerprints are not a signature. Anyone who knows a vault password can decrypt the database, so they could also cut entries off the end or rewrite entries and all fingerprints after them. From 1.4.2 Jaybi remembers, in each browser, the last entry it saw, and the vault file records its last entry too. If the log is shorter or different at the next sign-in, Admins see a warning at the top of the page. Find out what happened before choosing **Accept the log as it is**, which records "Audit log accepted after a warning". This does not help on a browser that never opened the vault, or if someone also clears this browser's data.

## Backups

A backup is a single `.moliya` file. It stays encrypted. Any current password of the vault opens it. Every backup records which version of Jaybi made it, and every future version will keep opening it (see [data-format.md](data-format.md)).

### Backup reminder and storage protection

- The **Backup** page shows when you last downloaded a backup.
- Admins see a reminder at the top of every page when no backup was ever downloaded, or the last one is more than 7 days old. **Dismiss** hides it until the next sign-in.
- **Storage in this browser** tells you whether the browser has agreed to keep the vault ("Protected") or may clear it when space runs low or after a long time without visits ("Not protected"). Safari clears website data after 7 days without a visit unless the app is added to the Home Screen. Either way, backups are the real protection.

### Export

Open **Backup** and choose **Download backup**. Jaybi saves pending changes first, then downloads `moliya-backup-YYYY-MM-DD.moliya`. Backups keep the `.moliya` name and extension from before the app was renamed, so every version recognises them. Store it somewhere safe that is not the same device, such as an encrypted USB stick or a private cloud folder. Keep older backups too; a backup never expires.

Export on a schedule that matches how much you would hate to retype: weekly for a household, daily for a busy shop.

### Import

Importing **replaces** the vault in the current browser. It does not merge. There are two ways, and neither is one click.

- **On a new browser or device** (no vault yet): open the app, and on the **Create your vault** screen, under **Import a backup instead**, choose the file, then **Replace vault**. Sign in with any account from the backup. This works only while the browser has no vault; otherwise Jaybi says "A vault already exists in this browser. Sign in and replace it from the Backup page."
- **Replacing an existing vault**: sign in as Admin and open **Backup**. Under **Replace this vault with a backup**, choose the file and check the version and export date it shows. Enter **Your password**, and type the vault name under **Type the vault name to confirm** (capital letters and spaces at the ends do not matter). Choose **Replace vault**. Jaybi saves pending changes, writes "Vault replaced by a backup" into the current vault's audit log, keeps the current vault as **Before import**, and signs you out. Sign in with any account that exists in the backup.

Only Admins can replace a vault. Backups from any earlier version can be imported. A backup made by a newer version is refused until the page is reloaded with the newer version. The largest file accepted is 72 MB, and Jaybi refuses files that are malformed or larger than a vault can be.

Only import backups you made yourself or got from someone you trust. A backup is a whole vault: whoever made it chose its people and passwords. Jaybi checks the file's structure and the database inside it when you sign in, and refuses anything it did not create.

### Size limits

A vault can hold about 48 MB of data. Nearly all of it is receipts; records alone take very little.

- Each receipt can be up to 1.5 MB and must be a PNG, JPEG, WebP, or GIF image. Other types, including SVG, are refused. Receipts added before 1.3.0 are kept as they are.
- When the vault passes about 36 MB, everyone sees "The vault is close to its size limit. Remove large receipts to make room." At 48 MB, new receipts are refused with "The vault is full." Records without receipts can still be added.
- Names are limited to 80 characters, emails to 254, and notes to 2,000.
- A vault holds at most 256 people.

### Earlier copies in this browser

Jaybi keeps up to three earlier copies of the vault in the browser:

- **Before upgrade**: when a new version changes the data format, the vault exactly as the previous version stored it.
- **Before import**: the vault that an import replaced, including the "Vault replaced by a backup" audit entry.

Each copy shows when it was taken and which version saved it. **Download** turns it into a normal backup file you can import (in this or an older version) or keep.

### Export data

**Export data** on the Backup page gives your records to other apps: an accountant's spreadsheet, a PDF for a meeting, or a database for analysis. Only Admins can export. Exports are one-way; to move or restore the vault, use the encrypted backup instead.

1. **Formats**: tick any of CSV, JSON, JSON Lines, Excel workbook, PDF report, and SQLite database. If your Excel is set to Russian or Uzbek, choose the Excel workbook rather than CSV so numbers come out right.
2. **Period**: all data, or a selected period (the picker works like the dashboard's, without changing the dashboard).
3. **Group**: all groups or one group.
4. **Include audit log**: only with all groups, because the log mentions records from every group.
5. **Include receipt images**: off by default, because files get large.
6. **Protection**:
   - **Encrypted ZIP (AES-256)**, the default. Open it with [7-Zip](https://www.7-zip.org/) (Windows), [Keka](https://www.keka.io/) (macOS), WinZip, or WinRAR. The built-in Windows and macOS archive tools **cannot** open it and will say the archive is damaged or ask for a password they cannot use. File names inside the archive are visible without the password; the contents are not.
   - **Encrypted SQLite database (SQLCipher 4)**. Stronger password protection, database only. Open it in [DB Browser for SQLite](https://sqlitebrowser.org/): choose **Open Database**, enter the password, and pick **SQLCipher 4 defaults**. With the command-line tool: `sqlcipher file.sqlite`, then `PRAGMA key = 'your export password';`.
   - **No encryption**. You must tick "I understand this file is not encrypted". Anyone who gets the file can read every record.
7. **Export password**: at least 14 characters using Latin letters, digits, and symbols, and not your sign-in password. Common passwords (also with letters swapped for look-alike symbols, like `P@ssw0rd`) and passwords built from the vault name or a member's email are refused. For the **AES-256 ZIP**, the **Strength** meter must show **Strong**: ZIP encryption derives its key quickly, so a weaker password can be guessed offline. For **SQLCipher**, **Fair** is enough. The form starts with a generated password for ZIP; keep it, or press **Generate** for a new one, and **Copy** puts it on the clipboard. The app does not keep the password. If you lose it, nobody can open the file.

Press **Export**. Progress is shown below the form, and **Cancel** stops it. The file name contains the vault name and the date, even for encrypted files. Each export is written to the audit log as **Data exported**, with the formats and scope but never the content or password.

The PDF lists at most 10,000 records; use CSV or Excel for more. Private safes, passwords, and sign-in secrets are never included in any export. Details of every format are in the [data format specification](data-format.md#exports).

### Exporting a table

Transactions, People, Open codes, Groups, Audit log, Categories, and the earlier copies on the Backup page each have an **Export** button above the table. It downloads exactly what the table shows: the visible columns in their order, and the rows left after search and filters, in the current sort (all pages, not just the one on screen).

1. Choose **Export**, then CSV, Excel, PDF, or JSON.
2. Tick "I understand this file is not encrypted". Table exports are never encrypted; use **Export data** above for an encrypted file.
3. Choose **Download**.

Only Admins see the button, and only on pages they can open. Each download is written to the audit log as **Data exported**, with the table, the column ids, whether the rows were filtered, the row counts, and for Transactions the period. It never contains the rows themselves. CSV and Excel files protect text that looks like a formula, and amounts come out exact, with the currency in its own column. The PDF lists at most 10,000 rows. Private safe tables have no export.

People, Open codes, Groups, and Categories keep their buttons (**Issue reset code**, **Revoke**, **Remove**, **Edit**) at the end of each row. Search, filters, and column choices only change what you see; they never change who can see what.

### Moving to another device

1. Export a backup on the old device.
2. Import it on the new device from the setup screen.
3. Sign in and check the dashboard figures.
4. Decide which device is now the "real" one. Two copies of a vault do not sync. Changes made on one never appear on the other, and importing overwrites.

The same applies when someone should use the vault on their own device: an invite code only works in a browser that holds the vault. Create the invite, then make the backup (it now contains the code), import it on their device, and let them join there. Remember that the vault on your device and theirs are then separate.

### Moving to jaybi.uz

Before 1.3.0 the app was called Moliya and lived at `https://kool277.github.io/iqtisod/`. Since 1.3.0 it is called Jaybi and lives at `https://jaybi.uz`. The move is complete: the old address now forwards to `jaybi.uz`. A browser keeps each website's data separately, so **a vault does not move by itself**. If you open `jaybi.uz` and see **Create your vault** instead of your vault, it is still stored under the old address in that browser. It is not lost, but it can no longer be opened by visiting the old address.

- **If you already have a backup** (any `.moliya` file, from any version), import it at `jaybi.uz` (step 3 below). Changes made after that backup are only in the old copy.
- **If you have no recent backup**, ask whoever runs the site to reopen the old address for a short while (see [Recovering a vault left at the old address](devops-guide.md#recovering-a-vault-left-at-the-old-address) in the DevOps guide). Then:

1. At the old address, a bar says "Jaybi is moving to jaybi.uz. Download an encrypted backup now, then open jaybi.uz and import it." Sign in as an Admin and choose **Download backup now** in that bar (or **Backup → Download backup**). Do this on every browser or device that holds a vault. People with other roles see that only an Admin can download it.
2. Once `jaybi.uz` works again, open it in the same browser. It shows **Create your vault** with the hint "Coming from kool277.github.io/iqtisod? Import your backup here."
3. Under **Import a backup instead**, choose the file and **Replace vault**, then sign in with your usual email and password. Check the records, then tell everyone to use `jaybi.uz`.
4. Everyone else signs in at `jaybi.uz` with their usual password. Private safes, recovery codes, and the sign-in check move with the backup and keep working. Authenticator apps keep showing the entry under the old name "Moliya"; its codes still work. New set-ups appear as "Jaybi".

Nothing about the data changes: backups are still `.moliya` files, old backups open in Jaybi, and the recovery tool is still `npm run decrypt`.

### Opening a backup without the website

If the website is ever unavailable, a developer (or anyone with Node.js 22.12 or newer) can open a backup with the recovery tool included in the project:

```bash
npm run decrypt -- moliya-backup-2026-09-29.moliya --list
MOLIYA_PASSWORD='…' npm run decrypt -- moliya-backup-2026-09-29.moliya --email you@example.com --out ledger.sqlite
```

It asks for the password if `MOLIYA_PASSWORD` is not set, and writes a normal SQLite file (`--out`, or the backup's name with `.sqlite`). It refuses to overwrite an existing file unless you add `--force`; `--help` shows every option. It works for backups from every version. On Node.js 22.13 or newer it removes password information, private safe rows, sign-in check data, and code checks from the output; `--keep-keys` keeps them, with the safes still encrypted for their owners. The tool cannot open private safes. It does not ask for the sign-in check: a password is enough, which is why the sign-in check adds no protection to backups. `--list` also lists the codes that were open when the backup was made (kind and email only); the tool never opens a vault with a code.

Use the tool from 1.3.0 or newer for vaults saved by 1.3.0. Older copies of the tool open them but leave the sign-in check data and code checks in the output.

## Updates

When a new version is published, a bar appears at the top: **A new version of Jaybi is available.** Choose **Reload**. Jaybi saves and locks the vault first, so nothing is lost. The first unlock after an update may upgrade the data format; this is automatic, recorded in the audit log, and the previous copy is kept under **Earlier copies in this browser**.

The first sign-in of each person after upgrading to 1.1.0 also strengthens their password protection (600,000 PBKDF2 rounds instead of 200,000). It takes a moment longer once and is recorded as "Password protection strengthened".

### Upgrading to 1.2.0

Versions 1.0.0 and 1.1.0 stored, for every person, a value in the database that works as their key to the vault (`users.password_hash`). Anyone who could read the decrypted database, for example with the unencrypted SQLite export, could copy it. 1.2.0 removes these values when it upgrades the vault. At each person's next sign-in it stores a password check that cannot be used as a key, and it re-protects their copy of the vault key with fresh random data, so a value copied earlier no longer opens the vault stored in this browser. There is no audit entry for this.

- Backups made by 1.0.0 or 1.1.0, and the **Before upgrade** copy in this browser, still contain the old values, and a copied value still opens those old copies. Treat them as sensitive: once everyone has signed in with 1.2.0, download a new backup, and replace or securely delete the old ones.
- Until a person signs in with 1.2.0 once, a copied value still opens their copy of the vault key. Ask everyone to sign in soon after the upgrade.
- Moliya 1.1.0 cannot open a vault or backup saved by 1.2.0; it refuses it as made by a newer version. Keep the **Before upgrade** copy if you might need to go back.

### Upgrading to 1.3.0

1.3.0 adds invite and reset codes, the sign-in check, and stricter checks. The first unlock upgrades the database to schema 4, which adds the tables for codes and the sign-in check. This is automatic, recorded as a data format upgrade, and the previous vault is kept as **Before upgrade**.

- **No going back without a copy.** Moliya 1.2.0 and older refuse a vault or backup saved by 1.3.0 as made by a newer version. Download a backup before upgrading, and keep the **Before upgrade** copy until you are sure.
- **Existing passwords keep working.** New passwords need at least 12 characters and must not be common. People whose password does not meet the new rules see "Your password is shorter or more common than Jaybi now allows. Please choose a new one." after signing in. Ask them to change it, starting with Admins: the password is the only protection a backup has.
- **Adding people.** **Users** now leads with **Invite someone**. The temporary-password way is under **Advanced: set a temporary password instead**, and **Reset password** became **Issue reset code**, with **Set a temporary password instead** inside it.
- **Replacing the vault** now needs your password and the vault name, and importing from the setup screen works only in a browser with no vault.
- **Automatic lock** is still 15 minutes by default; each browser can choose 5, 15, 30, or 60 minutes under **Account → Lock automatically**.
- **Large receipts.** New receipts must be images of up to 1.5 MB, and the vault is capped at about 48 MB. Existing receipts are kept.
- **Recovery tool.** Use the 1.3.0 recovery tool for vaults and backups saved by 1.3.0. Older copies of the tool still open them, but leave sign-in check data and code checks in their output.
- **Hosting.** With 1.3.0 the app moved from `kool277.github.io/iqtisod` to its own address, `jaybi.uz`, and the old address now forwards there. A vault stored at the old address has to be brought over with a backup; see [Moving to jaybi.uz](#moving-to-jaybiuz). The new address serves nothing but Jaybi, so no other website can read the stored vault (see the [DevOps guide](devops-guide.md#origin-and-storage-isolation)).

### Upgrading to 1.3.1

1.3.1 changes when private safes lock. It does not change any data format, and 1.3.0 still opens everything 1.3.1 saves.

- Safes now stay open until the person chooses **Lock safes** or the vault locks: **Lock**, refreshing or closing the tab, signing out, or the vault's own **Account → Lock automatically** time (15 minutes unless changed). Switching to another tab no longer locks them.
- The separate safes timer (5 minutes by default) and its choice under **Account → Private safes** are gone. On shared devices, choose a short **Lock automatically** time instead, because it now protects the safes too.

### Upgrading to 1.4.0

1.4.0 turns every list into a table and adds group summaries. It does not change any data format, and 1.3.0 and 1.3.1 still open everything 1.4.0 saves.

- **Groups for everyone who can see the dashboard.** Managers and Viewers now find **Groups** in the sidebar, showing their own group's income, expenses, and net, read-only. Adding and removing groups stays with Admins.
- **Audit log.** It now lists the latest 10,000 entries instead of 200.
- **Table exports.** Admins can export what a table shows. These files are never encrypted and each one is recorded as **Data exported**; see [Exporting a table](#exporting-a-table).
- **Per-browser choices.** Column layouts, the dashboard group, and rows per page are remembered in each browser's local storage (`moliya.table.<id>`, `moliya.dashboard.group`). They hold no records, names, or amounts.

## Recovery scenarios

| Situation | What to do |
| --- | --- |
| A Manager or Viewer forgot their password | **Issue reset code** from **Users** and give them the code. They choose a new password with it, then open their private safes with their previous password or recovery code |
| Someone else may know a person's password | **Issue reset code** with **Stop their current password from working now** ticked. Their old password stops working at once. Old backups still open with it |
| A reset or invite code was sent to the wrong person, or lost | **Revoke** it under **Open codes**, then create a new one. If backups were made while it was open, treat those backups as opened by that code until it expires |
| The code "has expired" or the person waited too long | Create a new code. Expired codes are removed at the next sign-in |
| "This device’s clock is behind" when creating or using a code | Correct the device's date and time, then try again |
| The person joined on the wrong device, or sees "There is no vault in this browser yet" | Codes work only where the vault is stored. Have them join on this device and browser, or move a backup to their device first |
| Someone lost their authenticator app and their sign-in recovery codes | Confirm who they are, then **Turn off sign-in check** on their row. They can set it up again |
| "Too many attempts. Try again in" with a countdown | Wait. The wait doubles with each wrong try, up to 15 minutes. If you did not cause it, someone is guessing at this device: check the "Failed sign-in attempts seen" entries in the audit log |
| Someone cannot open their private safes after a reset, and has neither their previous password nor their recovery code | Nobody can open those safes. They can use **Account → Reset private safes** to destroy them and start again |
| You forgot your admin password, and another Admin exists | Ask them to reset yours |
| You want to change your own admin password | **Account → Change password**. **Users** does not allow resetting your own |
| You forgot the only admin password | The vault cannot be opened as Admin. A Manager or Viewer can still sign in and read their group. Keep a second Admin account to avoid this |
| Browser data was cleared, or the device was lost | Import your latest backup on a new browser |
| All passwords are lost | The data cannot be recovered, even from a backup |
| `jaybi.uz` shows **Create your vault**, but you used the app at `kool277.github.io/iqtisod` | The vault is still stored under the old address. Import a backup, or follow [Moving to jaybi.uz](#moving-to-jaybiuz) |
| "This vault was saved by a newer version of Jaybi" (1.2.0 and older say "Moliya") | Reload the page. If it persists, the site was rolled back: import a backup or an earlier copy made by this version, or wait for the newer version to return |
| "The vault stored in this browser is damaged" (on opening the app, or when signing in) | Nothing else was changed, but nobody can sign in to replace it, and the setup screen only appears when the browser has no vault. Make sure you have a good backup. Then clear this site's data in the browser settings (this also deletes the earlier copies), reload, and import the backup from the setup screen. The same applies if a vault you just imported shows this message |
| "Not saved: changed elsewhere" | The vault was changed in another tab, window, or by an import. Lock and unlock to load the latest data, then redo the last change |
| "Already unlocked in another tab or window" | Lock it in the other tab, or close that tab |
| An update went wrong | Download an earlier copy from **Backup**, or import a backup made before the update |
| You replaced the vault with the wrong backup | Sign in as an Admin of the imported backup, download the **Before import** copy from **Backup**, and replace the vault with it |
| "Jaybi does not run inside another page" | Someone embedded the app in another website. Open it in its own tab from the address you trust |

## Security limits to know

Jaybi protects data at rest well. It is important to understand what it does **not** do:

1. **Roles are enforced by the app, not by encryption.** There is one vault key for everything. Anyone who has a valid password and a copy of the encrypted data could decrypt the entire database with technical tools, including other groups' records. Only give accounts to people you would trust with the whole ledger. Private safes are the exception: they are encrypted again with keys only their owner holds.
2. **Removing someone or resetting a password does not change the vault key.** A removed person who kept an old backup file, or an old copy of the browser storage, could still open that copy with their old password. If they also get a newer copy, they could decrypt it too. After removing someone you do not trust, the only full protection today is to start a new vault. Rotating the vault key (which needs a key pair per person, so an Admin can re-wrap the new key for everyone who stays) is planned but not in 1.4.2; the **Change encryption key** option in private safes only re-encrypts one safe.
3. **Old backups keep old passwords.** A backup opens with the passwords that were valid when it was exported.
4. **Emails are visible.** Email addresses are stored unencrypted next to the encrypted data, in the browser and in backup files, so that Jaybi knows whose key to try. Amounts, notes, and everything else are encrypted.
5. **Backup files can be guessed offline.** Someone who steals a backup, or copies the browser's storage, can try passwords on their own computer. PBKDF2 (600,000 rounds) slows each guess, but it runs fast on graphics cards, and a short or common password will still fall. A memory-hard method (Argon2id) is planned but not in 1.4.2. Use long, unique passwords, especially for Admin accounts. Older backups keep the protection they were made with (200,000 rounds before 1.1.0).
6. **Exports leave the vault's protection.** An unencrypted export is readable by anyone who has the file. An encrypted ZIP is only as strong as its password, because the ZIP format guesses passwords quickly; use a generated one. Once someone opens an export, the data is theirs.
7. **The browser is the security boundary.** Malware on the device, a malicious browser extension, or another website served from the same address could read the vault while it is unlocked, or delete the stored copy, and could capture passwords typed to open private safes. See the [DevOps guide](devops-guide.md#origin-and-storage-isolation) about hosting on a dedicated address.
8. **Backups from before 1.2.0 hold key material.** They contain a value per person that opens that person's key to the vault (see [Upgrading to 1.2.0](#upgrading-to-120)). Replace them after upgrading.
9. **Private safes hide contents, not their existence.** Anyone with the decrypted database can count each person's safes and items, see when they changed, and since 1.4.2 tell only an item's size class (1, 2, 4… 32 KiB), not its kind. Deletions are not detected, and someone with the vault key can put back an older copy of an item, which its owner then sees as current; a new item format that detects this is planned but not in 1.4.2.
10. **The attempt limit only slows guessing in the app.** After five wrong passwords or codes for an email, Jaybi makes the next try wait, doubling up to 15 minutes. It protects against someone trying passwords at this device. It does not protect a copied vault or backup, and someone with the browser's developer tools can clear it (from 1.4.2 it is kept in two places, local storage and IndexedDB, so clearing one is not enough). Only a strong password stops offline guessing.
11. **The sign-in check is not encryption.** Jaybi says so next to it: "This adds a second step to signing in to the app. It does not add encryption: anyone with a copy of the vault and your password can still open it with the recovery tool." It helps when a password leaks and someone tries it in the app. It does nothing for backups.
12. **Code expiry is enforced by the app, not by encryption.** A backup made while a code was open, together with that code, opens the vault on a device with its clock set back, even after the code expired or was revoked in your vault. Keep validity short, revoke codes that went astray, and avoid handing out backups while codes are open.
13. **Codes and temporary passwords do not change the vault key.** Like point 2: whoever held a code or a temporary password can open copies made while it was valid.
14. **The audit log is not signed.** Its entries are chained by fingerprints, which catch damage and edits by people without a password. Anyone with a password can decrypt the database and rewrite the log with other tools. From 1.4.2 Jaybi warns an Admin when the log is shorter or different than the last time this browser saw it, but a browser that never opened the vault, or whose data was cleared, cannot tell. Entries signed by each person are planned but not in 1.4.2.
15. **The unencrypted parts of the vault file are checked piece by piece, not sealed as a whole.** Emails, dates, the app and schema versions, the password-stretching settings, code expiry times, and the audit head sit next to the encrypted data. Jaybi binds each password copy to its person and each code to its email and expiry, and refuses files that break its rules, but someone could still change, for example, the creation date shown in the app.

## Checklist for a new vault

- [ ] Create the vault with a long master password.
- [ ] Add a second Admin account and keep its password somewhere safe, such as a password manager.
- [ ] Check the vault currency and adjust categories under **Settings**.
- [ ] Create groups, then invite Managers and Viewers with one-time codes on the device that holds the vault. Use short validity, and revoke codes that are not used.
- [ ] Tell people who use private safes to create a recovery code.
- [ ] Suggest the sign-in check to Admins, and remind them it does not protect backups.
- [ ] Choose **Account → Lock automatically** on shared devices (5 minutes is a good choice).
- [ ] Export a first backup and store it off the device.
- [ ] Schedule regular backups, and act on the backup reminder.
- [ ] Check **Storage in this browser** on the Backup page. On iPhone or iPad, add the app to the Home Screen.
- [ ] Look at **Open codes** and the audit log now and then for codes you did not expect and for "Failed sign-in attempts seen".
