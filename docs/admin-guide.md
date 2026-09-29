# Admin guide

This guide is for the person who owns a Moliya vault. Admins can do everything in the [user guide](user-guide.md) and can also manage people, groups, the audit log, and backups.

## Key ideas

- **A vault is one encrypted database in one browser.** It lives in that browser's storage for that website address. A different browser, device, browser profile, or website address starts with no vault.
- **Every person has their own password.** Each password unlocks the same vault. Removing a person removes their key from the vault.
- **Nobody can recover a lost password**, including the developers. Keep at least two Admin accounts, and keep a recent backup.

## First run: creating the vault

1. Open the app. With no vault in this browser you will see **Create your vault**.
2. Fill in:
   - **Vault name**: shown in the top bar. It also becomes the name of the first group.
   - **Admin email**: your sign-in name. It is stored in lowercase.
   - **Master password** (twice): at least 8 characters. Use a long passphrase. This is your admin password.
   - **Currency**: USD, UZS, EUR, or RUB. Totals are calculated in this currency only, and it cannot be changed later from the app.
3. Choose **Create encrypted vault**. You are signed in and taken to the dashboard.

Your admin account does not belong to any group, so you see every group's records.

## Roles

| Permission | Admin | Manager | Viewer |
| --- | --- | --- | --- |
| View dashboard and ledger | All groups | Own group | Own group |
| Add, edit, delete records | All groups | Own group | No |
| Manage people and groups | Yes | No | No |
| Audit log | Yes | No | No |
| Export and import backups | Yes | No | No |

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

Give the person the app address, their email, and the password through a private channel. Ask them to tell you if they want the password changed. People cannot change their own password yet, so you reset it for them.

### Resetting a password

Choose **Reset password** on the person's row, enter the new password, and choose **Save**. The old password stops working for this browser's vault as soon as the change is saved. You can reset your own password the same way.

### Removing a person

Choose **Remove** and confirm. Removal is blocked in three cases:

- The person still has records. Delete or reassign those records first.
- The person is the last Admin.
- The person is you.

Changing someone's role or group after creation is not available from the screen yet. For now, remove the person and add them again with the new role (possible only if they have no records), or ask a developer to expose the existing `updateUser` service.

## Audit log

**Audit log** shows the latest 200 actions with time, who did it, and what happened: vault created, users added, updated, removed, or password reset, groups added or removed, records added, updated, or deleted, and backups exported. The log lives inside the encrypted vault, so it is included in backups.

## Backups

A backup is a single `.moliya` file. It stays encrypted. Any current password of the vault opens it.

### Export

Open **Backup** and choose **Download backup**. Moliya saves pending changes first, then downloads `moliya-vault.moliya`. Store it somewhere safe that is not the same device, such as an encrypted USB stick or a private cloud folder.

Export on a schedule that matches how much you would hate to retype: weekly for a household, daily for a busy shop.

### Import

Importing **replaces** the vault in the current browser. It does not merge.

- **On a new browser or device**: open the app, and on the **Create your vault** screen use **Import a backup instead**. Choose the file, choose **Replace vault**, then sign in with any account from the backup.
- **Replacing an existing vault**: sign in as Admin, open **Backup**, choose the file under **Import backup**, and confirm **Replace vault**. You are signed out and can sign in with any account that exists in the backup.

Only files up to 20 MB are accepted.

### Moving to another device

1. Export a backup on the old device.
2. Import it on the new device from the setup screen.
3. Sign in and check the dashboard figures.
4. Decide which device is now the "real" one. Two copies of a vault do not sync. Changes made on one never appear on the other, and importing overwrites.

## Recovery scenarios

| Situation | What to do |
| --- | --- |
| A Manager or Viewer forgot their password | Reset it from **Users** |
| You forgot your admin password, and another Admin exists | Ask them to reset yours |
| You forgot the only admin password | The vault cannot be opened as Admin. A Manager or Viewer can still sign in and read their group. Keep a second Admin account to avoid this |
| Browser data was cleared, or the device was lost | Import your latest backup on a new browser |
| All passwords are lost | The data cannot be recovered, even from a backup |
| The site moved to a new address (new domain) | The old address's vault is not visible at the new one. Export at the old address, then import at the new one |

## Security limits to know

Moliya protects data at rest well. It is important to understand what it does **not** do:

1. **Roles are enforced by the app, not by encryption.** There is one vault key for everything. Anyone who has a valid password and a copy of the encrypted data could decrypt the entire database with technical tools, including other groups' records. Only give accounts to people you would trust with the whole ledger.
2. **Removing someone or resetting a password does not change the vault key.** A removed person who kept an old backup file, or an old copy of the browser storage, could still open that copy with their old password. If they also get a newer copy, they could decrypt it too. After removing someone you do not trust, the only full protection today is to start a new vault. A key-rotation feature is on the developers' list.
3. **Old backups keep old passwords.** A backup opens with the passwords that were valid when it was exported.
4. **Emails are visible.** Email addresses are stored unencrypted next to the encrypted data, in the browser and in backup files, so that Moliya knows whose key to try. Amounts, notes, and everything else are encrypted.
5. **Backup files can be guessed offline.** Someone who steals a backup can try passwords on their own computer. PBKDF2 slows each guess, but a short or common password will still fall. Use long, unique passwords, especially for Admin accounts.
6. **The browser is the security boundary.** Malware on the device, a malicious browser extension, or another website served from the same address could read the vault while it is unlocked, or delete the stored copy. See the [DevOps guide](devops-guide.md#origin-and-storage-isolation) about hosting on a dedicated address.

## Checklist for a new vault

- [ ] Create the vault with a long master password.
- [ ] Add a second Admin account and keep its password somewhere safe, such as a password manager.
- [ ] Create groups, then add Managers and Viewers.
- [ ] Export a first backup and store it off the device.
- [ ] Schedule regular backups.
