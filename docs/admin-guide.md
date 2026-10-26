# Admin guide

This guide is for the person who owns a Jaybi vault. Admins can do everything in the [user guide](user-guide.md) and can also manage people, groups, vault settings and categories, the audit log, and backups.

## Key ideas

- **A vault is one encrypted database in one browser.** It lives in that browser's storage for that website address. A different browser, device, browser profile, or website address starts with no vault.
- **Every person has their own password and, since 2.0, their own keys.** In a vault with per-person keys (every vault created with 2.0, and an older one once an Admin [upgrades](#upgrading-to-200) it) each password seals that person's keys, which open the vault's **household key**. Removing someone who held the household key makes a new one for everyone who stays. A vault created before 2.0 keeps one key that every password unlocks until it is upgraded.
- **The founder key anchors trust.** The Admin who creates the vault, or upgrades it, is its founder. Every browser compares the founder key at its first sign-in and refuses a vault with another one. An Admin signs the list of people, and every audit entry is signed by the person who made it.
- **Nobody can recover a lost password**, including the developers, and nobody can give a person keys except through an invite code they redeem themselves. Keep at least two Admin accounts, and keep a recent backup.
- **Private safes are not yours to see.** Every person, Admins included, can keep private safes for cards, subscriptions, and notes. They are encrypted with keys only their owner holds. As Admin you cannot see them, list them, open them, or recover them, even with the decrypted database, a backup, or the recovery tool. See [Private safes and Admins](#private-safes-and-admins).

## First run: creating the vault

1. Open the app. With no vault in this browser you will see **Create your vault**.
2. Fill in:
   - **Vault name**: shown in the top bar. It also becomes the name of the first group.
   - **Admin email**: your sign-in name. It is stored in lowercase.
   - **Master password** (twice): at least 12 characters, not a common password, and not built from your email or the vault name. Use a long passphrase of a few unrelated words. This is your admin password: it seals your keys, and like every member's password it opens backups, so it is what protects them against guessing.
   - **Currency**: USD, UZS, EUR, or RUB. Totals are calculated in this currency only. You can change it later under **Settings**.
3. Choose **Create encrypted vault**. Jaybi creates your keys and shows your **founder key** once: write it down or choose **Copy**, keep it where you can read it out to people who ask, and choose **Done**. **Account → Vault keys** shows it again. You are signed in and taken to the dashboard.

The browser needs X25519 and Ed25519 in Web Crypto (Chrome and Edge 137 or later, Firefox 130 or later, Safari 17 or later). An older browser is refused before anything is created, with no weaker fallback; it can still open a vault created before 2.0.

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

Open **Users** (the page is titled **People**). Managers see the page too, read-only and only for the people in their own group: no overview, no actions, no audit activity, sign-in times or sign-in-check status. Viewers do not see it.

### Overview

**Overview** at the top counts people (former members apart), the places used out of 256 (everyone who can sign in, plus places held for open codes), the share of active people with a sign-in check, and **Needs attention**: people who must change their password, cannot sign in (no keys or password copy and no open code), Managers or Viewers without a group, suspended people, and, in a vault created before 2.0, **older password copies** (a copy made before 1.4.2 or with an older key stretch; it is rewritten the next time that person changes their password). It also shows the five most recent sign-ins, how many people signed in within 30 days, the open codes with their expiry, and charts by role and by group. It shows counts and emails only, never codes, passwords or keys.

Sign-ins are recorded from 1.6.0 on, at most once every 10 minutes per person, inside the encrypted vault.

The **Access** column says how each person gets in: **Has keys**, **Invited** (a code is waiting for them), or **Needs a new invite**. In a vault created before 2.0 it says **Password**, **Waiting for a code**, or **No way to sign in**.

### Inviting a person

An invite is a one-time code. The person enters it with their email and chooses their own password, so you never know it. In a vault with per-person keys it is the only way to add someone: the code carries the household key sealed for it, the person's own keys are created when they join, and your next save signs them into the list of people. An open invite is part of the signed list too, so a backup made before you created it counts as an older copy when you restore it.

1. Choose **Add user**; **Send an invite code** is selected. Enter **Their email**.
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

Only in a vault created before 2.0 that has not been upgraded: a temporary password would let you know the keys of someone in a vault with per-person keys. In **Add user**, choose **Set a temporary password**: enter their **Email**, optionally a **Name**, a **Password**, a role and a group, and choose **Add user**. The password must follow the same rules as any other (at least 12 characters, not common). Give it privately. At their first sign-in Jaybi makes them choose a new password that only they know, and every page leads to **Account** until they do.

Prefer an invite. With a temporary password you know their password until they change it, and a backup made in between opens with it. Adding someone this way ends any open invite for the same email.

After joining, people change their password themselves under **Account → Change password**.

### Giving someone a new code

With per-person keys, a forgotten password is replaced by new keys. Choose **Give a new invite code** on the person's row or on their page, choose how long the code works, and choose **Give a new invite code** again. The code is shown once, as for invites. Their keys stop working at once; with the code they choose a new password on **Have a reset code?** and get new keys. Using the code turns off their sign-in check. Private safes they opened since the vault got per-person keys then open only with their recovery code; safes they have not opened since the upgrade also open with their previous password.

A new code does not make a new household key, because the person stays a member. If someone else may know their password, suspend and reactivate them instead: the suspension makes a new household key, and the reactivation gives them a new code.

### Resetting a password before the upgrade

In a vault created before 2.0, choose **Issue reset code** on the person's row or on their page. The same form shows a warning about private safes, a **Code works for** choice (24 hours by default), and a box, ticked by default:

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

### A person's page

Choose the email in the list, or **Open**, to reach `#/app/users/<id>`. It shows the profile (name, email, role, group, added, updated, last sign-in, sign-in check, pending password change, how they sign in, any open code), their records per currency within what you can see (amounts in different currencies are never added together), and for Admins their last 50 audit entries. Admins get these actions there; Managers only read.

- **Edit**: name, email, role and group. The email stays unique. After a change the person signs in with the new email and their current password; the password copy is relabelled, not rewritten, and with per-person keys your next save signs the change into the list of people. A change is refused while a code is open for the person or for the new email, because codes are bound to the email they were made for. Demoting the last active Admin is refused. Recorded as "User updated" with the old and new email.
- **Require a new password**: at the next sign-in they must choose a new password, and every page leads to **Account** until they do. Recorded as "New password required".
- **Suspend**: removes their key or password copy from the vault and revokes their open codes, so they cannot sign in; records, private safes and history stay. Recorded as "User suspended". With per-person keys, suspending someone who held the household key makes a new one ([below](#a-new-household-key)). **A copy of the vault file saved before the suspension still opens with their old password**, in a vault created before 2.0 even a later one: treat any copy they could have as theirs. You cannot suspend yourself or the last active Admin.
- **Reactivate**: issues a new code (a reset code before 2.0; the old password or keys stay off) and shows it once. Recorded as "User reactivated" and "Reset code issued".
- **Delete**: type their email to confirm. If they entered records, choose:
  - **Move them to another person**: their records are reassigned to someone you pick, recorded as "Records moved to another person", then the person is removed.
  - **Keep them under this person as a former member**: the person stays in the list as **Former member**, with no password, codes, sign-in check or private safes, so their records still name them. A former member can later be deleted with reassignment.

  Without records the person is simply removed. Deleting always destroys their private safes for good and, as with a suspension, makes a new household key if they held it. The audit log keeps their entries; for a removed person the log shows the email recorded when they were deleted. You cannot delete yourself or the last active Admin.

### Changing several people at once

Tick people in the list; a bar appears with **Role** and **Group**. Choose one or both, **Apply to selected**, and confirm. The change is all or nothing: if one person cannot be changed (for example it would leave no active Admin) nothing changes. Each changed person gets their own "User updated" entry. Former members are skipped.

All actions on this page are checked again by the services, not only hidden on screen: only Admins can change people, and a forced password change blocks everything else. They respect the 256-person limit, including places held for open codes. With per-person keys the last-Admin rule counts only Admins who hold keys, so the last one who can sign the list of people cannot step down while others still wait for an invite.

### A new household key

With per-person keys, suspending or deleting someone who held the household key (they were active with keys, had redeemed a code, or held a copy of the key) makes a new one. The confirmation says so. Someone who never used their invite, or still needs a new invite after the upgrade, leaves without a new key. Several removals before the next save make one new key.

- The session switches to the new key at once. The next save gives a copy to everyone who stays, signs the version of the list of people that names it, and encrypts the whole vault again. That save is recorded as "New household key after someone left".
- **Open invite codes are revoked**, because each carries the old key. The confirmation says how many; give new codes afterwards.
- The save keeps the vault as it was just before as an earlier copy, **Before a new household key**, without the keys of the people who left, and deletes every older earlier copy in this browser.
- **Old copies stay readable to whoever had them.** A backup, an exported file or a copy of the browser storage made before the change still opens for the person who left. Download a new backup, and delete older ones they could reach. The Health check row **Backup after a new household key** warns until the last backup is from the current key.

## Private safes and Admins

Private safes are described for users in the [user guide](user-guide.md#private-safes). As Admin you have your own safes like everyone else. For other people's safes:

| You can | You cannot |
| --- | --- |
| Give someone a new code (their safes then open with their recovery code; before 2.0, or for safes not opened since the upgrade, also with their previous password) | Open, list, or read anyone else's safes, including names, item types, and dates |
| Remove a person, which destroys their safes | Recover a person's safes for them |
| Back up and import the vault; safes travel inside it, still encrypted | Export safes in plain form; the unencrypted exports and the recovery tool leave them out |

Things to know:

- **Backups carry safes.** Importing an older backup also brings back the safes as they were then. People sign in with the passwords that were valid when the backup was made, and their safes open the way they did at that time (with the password they had then, or their recovery code from then).
- **Deleting is not complete until old copies are gone.** When a person deletes items or a safe, or you remove the person, the data is removed from the vault, but older backups and the earlier copies in this browser (up to three) still hold it in encrypted form.
- **Encourage recovery codes.** Recovery codes are optional. With per-person keys, anyone who skipped theirs loses their safes when they come back with a new code, even if they remember their previous password; before 2.0, when you reset their password and they have forgotten their previous one.
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
| Vault upgraded to per-person keys | An Admin upgraded the vault and became its founder (2.0) |
| New household key after someone left | A removal made a new household key, with the number of codes it revoked (2.0) |
| Older copy of the vault opened anyway | An Admin opened a copy older than the one this browser had seen (2.0) |
| Audit log accepted after a warning | An Admin accepted the audit log after Jaybi warned that it was shorter or different than this browser last saw it, with the warning's details |
| Sign-in check turned on / Sign-in check turned off | A person turned their own sign-in check on or off |
| Sign-in check removed | An Admin turned off someone's sign-in check, or a password reset turned it off |
| Sign-in recovery code used | Someone signed in with a sign-in recovery code |

No code, password, or authenticator secret is ever written to the log. The log lives inside the encrypted vault, so it is included in backups. Nothing about private safes is written to it: each person's safe activity is kept in their own encrypted activity list, which only they can read.

Entries cannot be edited or deleted from the app. Each entry also contains a fingerprint of the one before it, so **Integrity** at the top of the page shows **Broken** if an entry in the middle was changed or removed outside the app, for example by damage to the file or by someone editing a decrypted copy. If it ever shows **Broken**, restore from a backup you trust and find out who had access to the passwords.

In a vault created before 2.0 the fingerprints are not a signature. Anyone who knows a vault password can decrypt the database, so they could also cut entries off the end or rewrite entries and all fingerprints after them. From 1.4.2 Jaybi remembers, in each browser, the last entry it saw, and the vault file records its last entry too. If the log is shorter or different at the next sign-in, Admins see a warning at the top of the page. Find out what happened before choosing **Accept the log as it is**, which records "Audit log accepted after a warning". This does not help on a browser that never opened the vault, or if someone also clears this browser's data.

### Signed entries

With per-person keys every entry is signed by the person who made it, when their session saves, together with the version of the list of people it was written under. Jaybi checks that each signature matches, that the signer was a member then, that the entry names its signer, and that the signer's role allowed the action. The signed list of people records where the signed log starts and where each Admin save left it, so deleting signatures, or cutting or rewriting the log up to an Admin's save, is caught on any browser.

- The **Signature** column shows **Signed**, **Before signatures** (written by 1.x, or before the upgrade), **Signed when saved** (your own newest entries), or the problem, such as **Not signed**, **Signature does not match**, **Signed by someone else** or **Not allowed for their role**. **Show problems only** lists just those, and the line above the table counts both.
- A sign-in checks the entries that are new since this browser last checked; the Audit page checks every entry, and the Health check row **Audit log signatures** offers **Check every entry**.
- Problems warn everyone who can read the audit log and block nothing. Find out what happened, for example with a backup from before the first problem, then choose **Accept the log as it is**, which stops this browser's warning and records "Audit log accepted after a warning". The problems stay in the log.
- Signatures detect; they do not prevent. Someone who holds the household key can still remove the entries written since an Admin last saved a change to the list of people, which only a browser that saw them notices, as before 2.0.

## Backups

A backup is a single `.moliya` file. It stays encrypted. With per-person keys it opens with the password of anyone who was a member when it was made; before 2.0, with any password the vault had then. Every backup records which version of Jaybi made it, and every future version will keep opening it (see [data-format.md](data-format.md)).

### Backup reminder and storage protection

- The **Backup** page shows when you last downloaded a backup.
- Admins see a reminder at the top of every page when no backup was ever downloaded, or the last one is more than 7 days old. **Dismiss** hides it until the next sign-in.
- **Storage in this browser** tells you whether the browser has agreed to keep the vault ("Protected") or may clear it when space runs low or after a long time without visits ("Not protected"). Safari clears website data after 7 days without a visit unless the app is added to the Home Screen. Either way, backups are the real protection.

### Export

Open **Backup** and choose **Download backup**. Jaybi saves pending changes first, then downloads `moliya-backup-YYYY-MM-DD.moliya`. Backups keep the `.moliya` name and extension from before the app was renamed, so every version recognises them. Store it somewhere safe that is not the same device, such as an encrypted USB stick or a private cloud folder. Keep older backups too; a backup never expires.

Export on a schedule that matches how much you would hate to retype: weekly for a household, daily for a busy shop.

### Import

Importing **replaces** the vault in the current browser. It does not merge. There are two ways, and neither is one click.

- **On a new browser or device** (no vault yet): open the app, and on the **Create your vault** screen, under **Import a backup instead**, choose the file, then **Replace vault**. Sign in with any account from the backup; a vault with per-person keys first asks you to compare its founder key. This works only while the browser has no vault; otherwise Jaybi says "A vault already exists in this browser. Sign in and replace it from the Backup page."
- **Replacing an existing vault**: sign in as Admin and open **Backup**. Under **Replace this vault with a backup**, choose the file and check the version and export date it shows. Enter **Your password**, and type the vault name under **Type the vault name to confirm** (capital letters and spaces at the ends do not matter). Choose **Replace vault**. Jaybi saves pending changes, writes "Vault replaced by a backup" into the current vault's audit log, keeps the current vault as **Before import**, and signs you out. Sign in with any account that exists in the backup.

A backup with per-person keys replaces the vault only once you can sign in to it, with the same checks as a sign-in. If your password was different when it was made, enter it under **Your password in this backup**. A backup whose founder key differs from the one this browser knows is refused, with no override; a genuine copy opens in a browser that never saw the other key. A backup that is behind the vault this browser has seen (an older version of the signed list of people, for example from before an invite or a removal) shows the people removed or given new keys since, who are suspended again in the restored copy (making a new household key), and the invite codes revoked since, which are revoked again; choose **Restore this older copy**. Without the history this browser keeps, Jaybi says it cannot tell who was removed: suspend or delete them again afterwards. A 1.x backup over a vault with per-person keys asks for a second confirmation, because every password it holds works again, including those of people removed since; this is also the way back from the upgrade.

Only Admins can replace a vault. Backups from any earlier version can be imported. A backup made by a newer version is refused until the page is reloaded with the newer version. Under the file picker, Jaybi shows the largest backup this device can restore and what limits it: free storage in this browser, the device's memory, or what this browser can save (Chrome, Edge and other Chromium browsers save vaults of up to 126 MB, a backup of about 168 MB; Firefox and Safari save larger ones). Every device accepts at least 72 MB, the fixed limit before 1.7.0. A larger file is refused before it is read, with its size, the limit, and what to try: free up disk space or allow Jaybi to keep its data (on the **Health check** page), restore it in Firefox or Safari, or use a computer with more memory. Jaybi also refuses files that are malformed.

Only import backups you made yourself or got from someone you trust. A backup is a whole vault: whoever made it chose its people and passwords. Jaybi checks the file's structure and the database inside it when you sign in, and refuses anything it did not create.

### Size limits

How large a vault can grow depends on the device: at least 48 MB everywhere, and up to the largest vault this device can restore (the **Health check** page shows it under **Largest vault on this device**). Nearly all of it is receipts; records alone take very little. A vault that grew large on a computer may be too large to restore on a phone, so keep receipts small if people use the vault on several devices.

- Each receipt can be up to 1.5 MB and must be a PNG, JPEG, WebP, or GIF image. Other types, including SVG, are refused. Receipts added before 1.3.0 are kept as they are.
- When the vault passes three quarters of that limit (about 36 MB of 48 MB), everyone sees "The vault is close to its size limit. Remove large receipts to make room." At the limit, new receipts are refused with "The vault is full." Records without receipts can still be added.
- Names are limited to 80 characters, emails to 254, and notes to 2,000.
- A vault holds at most 256 people.

### Earlier copies in this browser

Jaybi keeps up to three earlier copies of the vault in the browser:

- **Before upgrade**: when a new version changes the data format, the vault exactly as the previous version stored it.
- **Before import**: the vault that an import replaced, including the "Vault replaced by a backup" audit entry.
- **Before a new household key**: the vault just before a removal made a new household key, without the keys of the people who left. Saving that change deletes every older copy.

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

A backup with per-person keys (format 3, Jaybi 2.0) needs Node.js 24.7 or newer, for Argon2id; on older Node.js the tool says so, and older backups keep working. `--verify` then checks the backup's signature and the signed list of people, and exits with status 3 if they do not hold; it also checks the audit signatures, still writes the database when some entries do not check out, says which, and exits with status 4. The file that **Download this vault as a file** saves from a blocked sign-in opens the same way.

It asks for the password if `MOLIYA_PASSWORD` is not set, and writes a normal SQLite file (`--out`, or the backup's name with `.sqlite`). It refuses to overwrite an existing file unless you add `--force`; `--help` shows every option. It works for backups from every version. On Node.js 22.13 or newer it removes password information, private safe rows, sign-in check data, and code checks from the output; `--keep-keys` keeps them, with the safes still encrypted for their owners. The tool cannot open private safes. It does not ask for the sign-in check: a password is enough, which is why the sign-in check adds no protection to backups. `--list` also lists the codes that were open when the backup was made (kind and email only); the tool never opens a vault with a code.

Use the tool from 1.3.0 or newer for vaults saved by 1.3.0. Older copies of the tool open them but leave the sign-in check data and code checks in the output.

## Updates

When a new version is published, a bar appears at the top: **A new version of Jaybi is available.** Choose **Reload**. Jaybi saves and locks the vault first, so nothing is lost. The first unlock after an update may upgrade the data format; this is automatic, recorded in the audit log, and the previous copy is kept under **Earlier copies in this browser**.

The first sign-in of each person after upgrading to 1.1.0 also strengthens their password protection (600,000 PBKDF2 rounds instead of 200,000). It takes a moment longer once and is recorded as "Password protection strengthened".

### Upgrading to 2.0.0

2.0 gives everyone their own keys. New vaults use them from the start. A vault created before 2.0 keeps working as it did, with the same passwords, until an Admin upgrades it; 1.x vaults and backups of every version keep opening.

1. When an Admin signs in to a 1.x vault, Jaybi offers **Upgrade to per-person keys**, with the number of people who will need a new invite code. **Not now** keeps the vault as it is and asks again at the next Admin sign-in.
2. **Upgrade now** (with your password) makes you the founder. Jaybi gives the vault a fresh key, ends every open code, removes every 1.x password copy, signs the first list of people with you alone, records "Vault upgraded to per-person keys", and keeps the vault as it was as **Before upgrade**. Write down your founder key.
3. Everyone else shows **Needs a new invite** on **People**. Give each of them a new code with **Give a new invite code**. They keep their records and history; their sign-in check is turned off, and their private safes open with their previous password or their recovery code.

Things to know:

- **Jaybi 1.7 and older refuse an upgraded vault**, and any backup of it, as made by a newer version. To go back, download the **Before upgrade** copy and restore it: every old password works again, including those of people removed since, and everything done after the upgrade is lost.
- **Other devices** that still hold the 1.x vault keep opening their own copy with the old passwords. Move everyone to the upgraded vault with a new backup, and treat the old copies as readable by everyone who had a password then.
- **Browsers.** A vault with per-person keys needs Chrome or Edge 137, Firefox 130, or Safari 17 or later.
- **Recovery tool.** Use the 2.0 tool, on Node.js 24.7 or newer, for backups with per-person keys.

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
| A Manager or Viewer forgot their password | **Give a new invite code** from **Users** and give them the code. They choose a new password and get new keys, then open their private safes with their recovery code. Before 2.0: **Issue reset code**, and they open their safes with their previous password or recovery code |
| Someone else may know a person's password | With per-person keys, suspend and reactivate them: the suspension makes a new household key and the reactivation gives them a new code. Before 2.0: **Issue reset code** with **Stop their current password from working now** ticked. Old backups still open with the old password either way |
| **Compare the founder key** at a first sign-in | The browser has not opened this vault before. Compare the key with the one the founder wrote down before continuing |
| "This vault’s founder key is not the one this browser saw before" | Do not sign in. Compare the key with the one the founder wrote down. The sign-in screen offers **Download this vault as a file** for whoever looks into it; restore a backup you trust |
| "The signed list of people in this vault does not check out", or its signed details do not | Someone changed the vault outside Jaybi, or the file is damaged. Download it as a file, restore a backup from before the change, and find out who had a password |
| "This copy of the vault is older than the one this browser has seen" | The stored vault was put back to an older copy. An Admin can choose **Open this older copy anyway**, which is recorded; people removed since may be back in it, so check **People** |
| "You are no longer a member of this vault" | They were suspended or removed. Give them a new code if they should be back |
| "Some audit log entries do not check out" | See [Signed entries](#signed-entries) |
| "This browser cannot use the keys this vault needs" | Update the browser to Chrome or Edge 137, Firefox 130, or Safari 17 or later |
| "There was not enough memory to check the password" | Argon2id needs 64 MiB. Close other tabs and try again |
| A reset or invite code was sent to the wrong person, or lost | **Revoke** it under **Open codes**, then create a new one. If backups were made while it was open, treat those backups as opened by that code until it expires |
| The code "has expired" or the person waited too long | Create a new code. Expired codes are removed at the next sign-in |
| "This device’s clock is behind" when creating or using a code | Correct the device's date and time, then try again |
| The person joined on the wrong device, or sees "There is no vault in this browser yet" | Codes work only where the vault is stored. Have them join on this device and browser, or move a backup to their device first |
| Someone lost their authenticator app and their sign-in recovery codes | Confirm who they are, then **Turn off sign-in check** on their row. They can set it up again |
| "Too many attempts. Try again in" with a countdown | Wait. The wait doubles with each wrong try, up to 15 minutes. If you did not cause it, someone is guessing at this device: check the "Failed sign-in attempts seen" entries in the audit log |
| Someone cannot open their private safes after a reset, and has neither their previous password nor their recovery code | Nobody can open those safes. They can use **Account → Reset private safes** to destroy them and start again |
| You forgot your admin password, and another Admin exists | Ask them to reset yours |
| You want to change your own admin password | **Account → Change password**. **Users** does not allow resetting your own |
| You forgot the only admin password | The vault cannot be opened as Admin. A Manager or Viewer can still sign in and read their group, but with per-person keys nobody can add or remove people any more. Keep a second Admin account to avoid this |
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

1. **Roles limit what people change, not what they can read.** There is one household key for the whole ledger. Anyone who has a member's password and a copy of the encrypted data could decrypt the entire database with technical tools, including other groups' records. With per-person keys every change is signed and checked against the signer's role, which makes it attributable, but reading is not limited. Only give accounts to people you would trust with the whole ledger. Private safes are the exception: they are encrypted again with keys only their owner holds.
2. **A new household key protects only what comes after it.** With per-person keys, removing someone who held the key makes a new one, so nothing saved afterwards opens for them. A removed person who kept an old backup file, an export, or an old copy of the browser storage can still open that copy. A new code for someone who stays makes no new key. In a vault created before 2.0 the key never changes, so a newer copy opens for them too: upgrade the vault. The **Change encryption key** option in private safes only re-encrypts one safe.
3. **Old backups keep old passwords.** A backup opens with the passwords that were valid when it was exported.
4. **Emails are visible.** Email addresses are stored unencrypted next to the encrypted data, in the browser and in backup files, so that Jaybi knows whose key to try. Amounts, notes, and everything else are encrypted.
5. **Backup files can be guessed offline.** Someone who steals a backup, or copies the browser's storage, can try passwords on their own computer, and any member's password opens it, so the weakest one counts. With per-person keys each password goes through Argon2id (64 MiB of memory, 3 passes), which makes a guess roughly a hundred to a thousand times more expensive on graphics cards than PBKDF2; a short or common password still falls. Vaults created before 2.0, their backups and the **Before upgrade** copy keep PBKDF2 (600,000 rounds, 200,000 before 1.1.0). Use long, unique passwords, especially for Admin accounts.
6. **Exports leave the vault's protection.** An unencrypted export is readable by anyone who has the file. An encrypted ZIP is only as strong as its password, because the ZIP format guesses passwords quickly; use a generated one. Once someone opens an export, the data is theirs.
7. **The browser is the security boundary.** Malware on the device, a malicious browser extension, or another website served from the same address could read the vault while it is unlocked, or delete the stored copy, and could capture passwords typed to open private safes. See the [DevOps guide](devops-guide.md#origin-and-storage-isolation) about hosting on a dedicated address.
8. **Backups from before 1.2.0 hold key material.** They contain a value per person that opens that person's key to the vault (see [Upgrading to 1.2.0](#upgrading-to-120)). Replace them after upgrading.
9. **Private safes hide contents, not their existence.** Anyone with the decrypted database can count each person's safes and items, see when they changed, and since 1.4.2 tell only an item's size class (1, 2, 4… 32 KiB), not its kind. Deletions are not detected, and someone with the vault key can put back an older copy of an item, which its owner then sees as current; a new item format that detects this is planned but not in 1.4.2.
10. **The attempt limit only slows guessing in the app.** After five wrong passwords or codes for an email, Jaybi makes the next try wait, doubling up to 15 minutes. It protects against someone trying passwords at this device. It does not protect a copied vault or backup, and someone with the browser's developer tools can clear it (from 1.4.2 it is kept in two places, local storage and IndexedDB, so clearing one is not enough). Only a strong password stops offline guessing.
11. **The sign-in check is not encryption.** Jaybi says so next to it: "This adds a second step to signing in to the app. It does not add encryption: anyone with a copy of the vault and your password can still open it with the recovery tool." It helps when a password leaks and someone tries it in the app. It does nothing for backups.
12. **Code expiry is enforced by the app, not by encryption.** A backup made while a code was open, together with that code, opens the vault on a device with its clock set back, even after the code expired or was revoked in your vault. Keep validity short, revoke codes that went astray, and avoid handing out backups while codes are open.
13. **Codes and temporary passwords do not change the household key.** Like point 2: whoever held a code or a temporary password can open copies made while it was valid.
14. **Signatures detect, they do not prevent.** With per-person keys every audit entry is signed by the person who made it, and the list of people by an Admin. Someone who holds the household key can still write into the vault: Jaybi reports it at the next check but cannot undo it, and entries written since an Admin last saved a change to the list of people can be removed unnoticed except by a browser that saw them. In a vault created before 2.0 the log is only chained by fingerprints, which anyone with a password can rewrite with other tools; Jaybi warns an Admin when the log is shorter or different than the last time this browser saw it. Backups remain the way back.
15. **The unencrypted parts of a vault file are protected differently by version.** With per-person keys the header (versions, the list of people's version, the household key's number, who can open it) is signed and checked at every sign-in. In a vault created before 2.0 it is checked piece by piece, not sealed as a whole: Jaybi binds each password copy to its person and each code to its email and expiry, but someone could still change, for example, the creation date shown in the app.
16. **The first sign-in in a browser trusts the founder key it sees.** A substituted vault on a brand-new browser is accepted unless the key is compared with the founder in person or by phone. A browser that has seen the vault refuses another founder key and an older list of people.
17. **Losing the founder's password with no other Admin freezes the list of people.** Members can still sign in, read and record, but nobody can add, remove or change people. Keep a second Admin.

## Checklist for a new vault

- [ ] Create the vault with a long master password, and write down the founder key.
- [ ] Invite a second Admin: without one, losing your password freezes the list of people.
- [ ] Check the vault currency and adjust categories under **Settings**.
- [ ] Create groups, then invite Managers and Viewers with one-time codes on the device that holds the vault. Use short validity, and revoke codes that are not used.
- [ ] Tell people who use private safes to create a recovery code.
- [ ] Suggest the sign-in check to Admins, and remind them it does not protect backups.
- [ ] Choose **Account → Lock automatically** on shared devices (5 minutes is a good choice).
- [ ] Export a first backup and store it off the device.
- [ ] Schedule regular backups, and act on the backup reminder.
- [ ] Check **Storage in this browser** on the Backup page. On iPhone or iPad, add the app to the Home Screen.
- [ ] Look at **Open codes** and the audit log now and then for codes you did not expect and for "Failed sign-in attempts seen".
