# Admin guide

This guide is for the person who owns a Moliya vault. Admins can do everything in the [user guide](user-guide.md) and can also manage people, groups, vault settings and categories, the audit log, and backups.

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
   - **Master password** (twice): at least 8 characters. Use a long passphrase. This is your admin password.
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
| Export and import backups | Yes | No | No |
| Own private safes, change own password (Account) | Yes | Yes | Yes |
| See or open anyone else's private safes | No | No | No |

Managers and Viewers must belong to exactly one group. An Admin can optionally be placed in a group, but still sees everything.

## Groups

Open **Groups**.

- **Add a group**: type a name and choose **Add group**. Use groups to separate budgets, for example "Home" and "Shop", or one group per family branch.
- **Remove a group**: only possible when no people and no records belong to it. Move or delete those first.

Groups cannot be renamed from the app yet.

## People

Open **Users**.

### Adding a person

1. Enter their **email** and a starting **password** (at least 8 characters).
2. Choose a **role** and a **group**.
3. Choose **Add user**.

Give the person the app address, their email, and the password through a private channel. At their first sign-in Moliya makes them choose a new password that only they know, and every page leads to **Account** until they do. After that they change it themselves under **Account → Change password**.

### Resetting a password

Choose **Reset password** on the person's row, enter a temporary password, and choose **Save**. The old password stops working for this browser's vault as soon as the change is saved. At their next sign-in the person must replace the temporary password with their own.

The dialog always warns about private safes, whether or not the person has any, so the warning does not tell you whether they use them. What it means:

- Their safes stay locked. They open only with the password the person chose before the reset, or their recovery code, together with their new password. Moliya never opens safes with a password an Admin set.
- You cannot open or recover their safes.
- If they have no recovery code and have forgotten their previous password, their safes are lost for good. They can then reset their safes and start again with empty ones.

Give the temporary password privately, and tell the person not to type it as their "previous password".

You cannot reset your own password from **Users**. Use **Account → Change password**, which needs your current password and also moves your own safes to the new one. If you have forgotten your password, another Admin must reset it.

### Removing a person

Choose **Remove** and confirm. The dialog always warns that removing a person also permanently destroys their private safes; nobody can recover them afterwards. Removal is blocked in three cases:

- The person still has records. Delete or reassign those records first.
- The person is the last Admin.
- The person is you.

Changing someone's role or group after creation is not available from the screen yet. For now, remove the person and add them again with the new role (possible only if they have no records), or ask a developer to expose the existing `updateUser` service.

## Private safes and Admins

Private safes are described for users in the [user guide](user-guide.md#private-safes). As Admin you have your own safes like everyone else. For other people's safes:

| You can | You cannot |
| --- | --- |
| Reset a person's password (their safes stay locked until they open them with their previous password or recovery code) | Open, list, or read anyone else's safes, including names, item types, and dates |
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

Categories are listed separately for income and expenses.

- **Add a category**: choose Income or Expense, type the English name, and optionally the Oʻzbekcha (Latin and Cyrillic) and Russian names. A blank translation shows the English name. Names can be up to 60 characters.
- **Edit**: fixes a name or adds missing translations. A category cannot switch between income and expense. Records keep pointing to the same category, so they show the new name everywhere.
- **Remove**: only possible when no records use the category, and at least one other category of the same type remains. Otherwise, edit it instead.

## Audit log

**Audit log** shows the latest 200 actions with time, who did it, and what happened: vault created, settings changed, categories added, edited, or removed, users added, updated, removed, or password reset, people changing their own password, groups added or removed, records added, updated, or deleted, backups and unencrypted exports downloaded, data format upgrades, and password protection upgrades. Record changes keep the values before and after the change. The log lives inside the encrypted vault, so it is included in backups. Nothing about private safes is written to it: each person's safe activity is kept in their own encrypted activity list, which only they can read.

Entries cannot be edited or deleted from the app. Each entry also contains a fingerprint of the one before it, so **Integrity** at the top of the page shows **Intact** only if no entry was changed or removed, even by someone editing a decrypted copy of the database with other tools. If it ever shows **Broken**, restore from a backup you trust and find out who had access to the passwords.

## Backups

A backup is a single `.moliya` file. It stays encrypted. Any current password of the vault opens it. Every backup records which version of Moliya made it, and every future version will keep opening it (see [data-format.md](data-format.md)).

### Backup reminder and storage protection

- The **Backup** page shows when you last downloaded a backup.
- Admins see a reminder at the top of every page when no backup was ever downloaded, or the last one is more than 7 days old. **Dismiss** hides it until the next sign-in.
- **Storage in this browser** tells you whether the browser has agreed to keep the vault ("Protected") or may clear it when space runs low or after a long time without visits ("Not protected"). Safari clears website data after 7 days without a visit unless the app is added to the Home Screen. Either way, backups are the real protection.

### Export

Open **Backup** and choose **Download backup**. Moliya saves pending changes first, then downloads `moliya-backup-YYYY-MM-DD.moliya`. Store it somewhere safe that is not the same device, such as an encrypted USB stick or a private cloud folder. Keep older backups too; a backup never expires.

Export on a schedule that matches how much you would hate to retype: weekly for a household, daily for a busy shop.

### Import

Importing **replaces** the vault in the current browser. It does not merge.

- **On a new browser or device**: open the app, and on the **Create your vault** screen use **Import a backup instead**. Choose the file, check the version and date it shows, choose **Replace vault**, then sign in with any account from the backup.
- **Replacing an existing vault**: sign in as Admin, open **Backup**, choose the file under **Import backup**, check the version and export date it shows, and confirm **Replace vault**. You are signed out and can sign in with any account that exists in the backup.

Backups from any earlier version can be imported. A backup made by a newer version is refused until the page is reloaded with the newer version. Only files up to 20 MB are accepted.

### Earlier copies in this browser

Moliya keeps up to three earlier copies of the vault in the browser:

- **Before upgrade**: when a new version changes the data format, the vault exactly as the previous version stored it.
- **Before import**: the vault that an import replaced.

Each copy shows when it was taken and which version saved it. **Download** turns it into a normal backup file you can import (in this or an older version) or keep.

### Unencrypted export

Under **Unencrypted export**, Admins can download:

- **Download records (CSV)**: every record, one row each, for Excel, LibreOffice, or an accountant. Amounts are exact decimals with their currency.
- **Download database (SQLite)**: the whole ledger as a standard SQLite file that any SQLite tool can open. Password information and all private safe data are removed from it.

These files are **not encrypted**. Anyone who gets them can read every record. Each download is written to the audit log. Use them for archiving (both formats are recommended for long-term preservation) and for moving data to other tools, and keep them on an encrypted drive.

### Moving to another device

1. Export a backup on the old device.
2. Import it on the new device from the setup screen.
3. Sign in and check the dashboard figures.
4. Decide which device is now the "real" one. Two copies of a vault do not sync. Changes made on one never appear on the other, and importing overwrites.

### Opening a backup without the website

If the website is ever unavailable, a developer (or anyone with Node.js 22.12 or newer) can open a backup with the recovery tool included in the project:

```bash
npm run decrypt -- moliya-backup-2026-09-29.moliya --list
MOLIYA_PASSWORD='…' npm run decrypt -- moliya-backup-2026-09-29.moliya --email you@example.com --out ledger.sqlite
```

It asks for the password if `MOLIYA_PASSWORD` is not set, and writes a normal SQLite file. It works for backups from every version. On Node.js 22.13 or newer it removes password information and private safe rows from the output; `--keep-keys` keeps them, with the safes still encrypted for their owners. The tool cannot open private safes.

## Updates

When a new version is published, a bar appears at the top: **A new version of Moliya is available.** Choose **Reload**. Moliya saves and locks the vault first, so nothing is lost. The first unlock after an update may upgrade the data format; this is automatic, recorded in the audit log, and the previous copy is kept under **Earlier copies in this browser**.

The first sign-in of each person after upgrading to 1.1.0 also strengthens their password protection (600,000 PBKDF2 rounds instead of 200,000). It takes a moment longer once and is recorded as "Password protection strengthened".

### Upgrading to 1.2.0

Versions 1.0.0 and 1.1.0 stored, for every person, a value in the database that works as their key to the vault (`users.password_hash`). Anyone who could read the decrypted database, for example with the unencrypted SQLite export, could copy it. 1.2.0 removes these values when it upgrades the vault. At each person's next sign-in it stores a password check that cannot be used as a key, and it re-protects their copy of the vault key with fresh random data, so a value copied earlier no longer opens the vault stored in this browser. There is no audit entry for this.

- Backups made by 1.0.0 or 1.1.0, and the **Before upgrade** copy in this browser, still contain the old values, and a copied value still opens those old copies. Treat them as sensitive: once everyone has signed in with 1.2.0, download a new backup, and replace or securely delete the old ones.
- Until a person signs in with 1.2.0 once, a copied value still opens their copy of the vault key. Ask everyone to sign in soon after the upgrade.
- Moliya 1.1.0 cannot open a vault or backup saved by 1.2.0; it refuses it as made by a newer version. Keep the **Before upgrade** copy if you might need to go back.

## Recovery scenarios

| Situation | What to do |
| --- | --- |
| A Manager or Viewer forgot their password | Reset it from **Users**. They choose a new password at next sign-in, then open their private safes with their previous password or recovery code |
| Someone cannot open their private safes after a reset, and has neither their previous password nor their recovery code | Nobody can open those safes. They can use **Account → Reset private safes** to destroy them and start again |
| You forgot your admin password, and another Admin exists | Ask them to reset yours |
| You want to change your own admin password | **Account → Change password**. **Users** does not allow resetting your own |
| You forgot the only admin password | The vault cannot be opened as Admin. A Manager or Viewer can still sign in and read their group. Keep a second Admin account to avoid this |
| Browser data was cleared, or the device was lost | Import your latest backup on a new browser |
| All passwords are lost | The data cannot be recovered, even from a backup |
| The site moved to a new address (new domain) | The old address's vault is not visible at the new one. Export at the old address, then import at the new one |
| "This vault was saved by a newer version of Moliya" | Reload the page. If it persists, the site was rolled back: import a backup or an earlier copy made by this version, or wait for the newer version to return |
| "The vault stored in this browser is damaged" | Import your latest backup. Nothing else was changed |
| "Not saved: changed elsewhere" | The vault was changed in another tab, window, or by an import. Lock and unlock to load the latest data, then redo the last change |
| "Already unlocked in another tab or window" | Lock it in the other tab, or close that tab |
| An update went wrong | Download an earlier copy from **Backup**, or import a backup made before the update |

## Security limits to know

Moliya protects data at rest well. It is important to understand what it does **not** do:

1. **Roles are enforced by the app, not by encryption.** There is one vault key for everything. Anyone who has a valid password and a copy of the encrypted data could decrypt the entire database with technical tools, including other groups' records. Only give accounts to people you would trust with the whole ledger. Private safes are the exception: they are encrypted again with keys only their owner holds.
2. **Removing someone or resetting a password does not change the vault key.** A removed person who kept an old backup file, or an old copy of the browser storage, could still open that copy with their old password. If they also get a newer copy, they could decrypt it too. After removing someone you do not trust, the only full protection today is to start a new vault. Rotating the vault key is on the developers' list; the **Change encryption key** option in private safes only re-encrypts one safe.
3. **Old backups keep old passwords.** A backup opens with the passwords that were valid when it was exported.
4. **Emails are visible.** Email addresses are stored unencrypted next to the encrypted data, in the browser and in backup files, so that Moliya knows whose key to try. Amounts, notes, and everything else are encrypted.
5. **Backup files can be guessed offline.** Someone who steals a backup can try passwords on their own computer. PBKDF2 (600,000 rounds) slows each guess, but a short or common password will still fall. Use long, unique passwords, especially for Admin accounts. Older backups keep the protection they were made with (200,000 rounds before 1.1.0).
6. **Unencrypted exports are plain data.** CSV and SQLite exports are readable by anyone who has the file.
7. **The browser is the security boundary.** Malware on the device, a malicious browser extension, or another website served from the same address could read the vault while it is unlocked, or delete the stored copy, and could capture passwords typed to open private safes. See the [DevOps guide](devops-guide.md#origin-and-storage-isolation) about hosting on a dedicated address.
8. **Backups from before 1.2.0 hold key material.** They contain a value per person that opens that person's key to the vault (see [Upgrading to 1.2.0](#upgrading-to-120)). Replace them after upgrading.
9. **Private safes hide contents, not their existence.** Anyone with the decrypted database can count each person's safes and items and see when they changed. Deletions and rollbacks of safe rows are not detected.

## Checklist for a new vault

- [ ] Create the vault with a long master password.
- [ ] Add a second Admin account and keep its password somewhere safe, such as a password manager.
- [ ] Check the vault currency and adjust categories under **Settings**.
- [ ] Create groups, then add Managers and Viewers. Each of them chooses their own password at first sign-in.
- [ ] Tell people who use private safes to create a recovery code.
- [ ] Export a first backup and store it off the device.
- [ ] Schedule regular backups, and act on the backup reminder.
- [ ] Check **Storage in this browser** on the Backup page. On iPhone or iPad, add the app to the Home Screen.
