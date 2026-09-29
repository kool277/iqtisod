# User guide

This guide is for people who use a Moliya vault day to day: **Managers**, who record income and expenses, and **Viewers**, who review them. Everyone, whatever their role, can keep their own [private safes](#private-safes). Admins can do everything here too. Their extra tasks are in the [admin guide](admin-guide.md).

## Before you start

Your admin gives you three things: the address of the app, your email, and a starting password. The first time you sign in, Moliya asks you to replace the starting password with one that only you know (see [Your account](#your-account)). Moliya has no "forgot password" link. If you forget your password, ask your admin to reset it, but read [After an admin resets your password](#after-an-admin-resets-your-password) first if you use private safes.

The vault lives inside one browser on one device. If your admin set it up on a shared computer, use that computer and that browser. Opening the app on your own phone will show an empty setup screen, because that browser has no vault yet. Your admin can move a copy there with a backup file.

## Signing in

1. Open the app. You will see **Unlock vault**.
2. Enter your email and password, then choose **Unlock**.

Unlocking takes a moment, because your password is deliberately stretched to make guessing slow. If you see "Email or password is incorrect", check both. The message is the same for either mistake on purpose.

## Finding your way around

The menu on the left (along the top on a phone) shows only what your role allows:

| Role | Dashboard | Transactions | Add, edit, delete records | Private safes and Account |
| --- | --- | --- | --- | --- |
| Manager | Yes | Yes | Yes, for your group | Yes, your own |
| Viewer | Yes | Yes | No | Yes, your own |

You only see records that belong to your group. The top bar shows the vault name, the save status, the language and theme switches, and the **Lock** button.

The button at the far left of the top bar collapses the menu. On a computer the menu shrinks to icons, and pointing at an icon shows its name. On a phone the menu row is hidden. Choose the button again to bring the menu back. Moliya remembers your choice in this browser.

## Choosing a period

Both the dashboard and the ledger use the same period buttons, and your choice carries over between them:

- **Today**
- **This week** (Monday to Sunday)
- **This month** (the default)
- **Last month**
- **Year to date** (1 January to today)
- **Custom**, which opens From and To date fields. If you enter them backwards, Moliya swaps them.

## Recording money (Managers)

1. Open **Transactions** and choose **Add record**.
2. Fill in the form:
   - **Type**: Income or Expense. The category list changes to match.
   - **Amount**: a number above zero, with up to two decimals (for example `1250`, `1250.5`, or `1 250,50`). A dot or a comma both work as the decimal mark, and spaces between thousands are ignored. Moliya stores the exact amount and never rounds it; if you type more decimals than the currency has, it asks you to fix the amount instead of guessing.
   - **Category**: for example Salary, Food, or Transport.
   - **Date**: defaults to today.
   - **Currency**: defaults to the vault currency. See the note on currencies below.
   - **Group**: only shown if you can see more than one group.
   - **Notes**: optional, up to 2,000 characters.
   - **Receipt**: optional photo, up to 1.5 MB. Use **View receipt** to check it, or **Remove receipt** to drop it.
3. Choose **Save**.

To change a record, choose **Edit** on it, adjust the fields, and choose **Update record**. To delete, choose **Delete**, then confirm. Deleting cannot be undone, but it is recorded in the admin's audit log.

To narrow the list, use the **All / Income / Expense** filter next to **Add record**.

### A note on currencies

Each vault has one main currency, chosen when it was created and changeable by an Admin. Totals and charts only count records in that currency. A record in another currency is still saved and listed, marked "Other currency — not included in totals". The dashboard lists those records separately under **Other currencies (not in totals)**, with income and expenses per currency, so nothing is hidden. Moliya does not convert between currencies.

## Reading the dashboard

The four figures at the top cover the selected period:

- **Net balance**: income minus expenses.
- **Total income** and **Total expenses**.
- **Savings rate**: the share of income left after expenses, rounded to one decimal. It shows 0% when there is no income in the period, and it can be negative if you spent more than you earned.

All totals are calculated exactly, to the cent (or tiyin), in the vault currency.

The charts below them:

- **Income and expenses** compares each month in the period.
- **Expenses by category** shows where the money went.
- **Spending over time** shows daily expense totals.
- **Who spent** shows expenses per person in your group. Admins see **Spending by group** instead.

A chart shows "No figures in this range" when the period has no matching records.

## Saving and locking

You never need to press a save button for the vault itself. The status next to the language switch tells you what is happening:

- **Saved**: everything is encrypted and stored.
- **Unsaved** or **Encrypting…**: a change is being stored. This normally takes about a second.
- **Could not save**: the browser refused to store data, for example because the disk is full or storage is blocked. Keep the tab open and tell your admin.
- **Not saved: changed elsewhere**: the vault was changed in another tab or window. Moliya stops saving here rather than overwrite that change. Lock, unlock again, and redo your last change.

The vault can be unlocked in only one tab at a time. If you see "already unlocked in another tab or window", switch to that tab or lock it there first.

Choose **Lock** when you step away. Locking, refreshing, or closing the tab removes the decrypted data from memory, and the next person must sign in. Moliya also locks the vault by itself after 15 minutes without activity.

## Your account

Open **Account** in the menu. Everyone has this page, whatever their role.

### Changing your password

Enter your **current password**, then the **new password** twice (at least 8 characters, and different from the current one), and choose **Change password**. If you have set up private safes, they move to the new password at the same time.

If your admin created your account or reset your password, the password was chosen by them. Moliya then asks you to choose a new one before you can use anything else: every page leads back to **Account** until you do.

### Other settings on this page

- **Private safes**: how long before your safes lock, how long shown values stay visible, and how long copied values stay in the clipboard. Open your safes first to change these.
- **Recovery code**: create one, or replace the one you have.
- **Start over**: **Reset private safes**, described below.

## Private safes

A private safe is a place for things you want to keep to yourself: payment cards, subscriptions, and notes. It is not a money account, and nothing in it appears on the dashboard or in the ledger.

Only you can open your safes. Your admin cannot see them, cannot see their names or what kind of items they hold, and cannot open or recover them for you, even with the whole database or a backup. Other people in the vault each have their own safes, which you cannot see either.

### Setting up

1. Open **Private safes** in the menu and choose **Create my safes**.
2. Enter your password.
3. Choose whether to create a **recovery code** (see below).
4. Choose **Create my safes**. You get one empty safe called **Personal**.

### The recovery code

A recovery code is a backup key for your safes, 25 characters in five groups, like `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`. It matters in one situation: your admin resets your password and you no longer remember the password you had before. Without the code, your safes are then lost for good.

- **Create a recovery code (recommended)**: the code is shown once. Write it down or print it and keep it away from this device. Type its last 4 characters to confirm you saved it.
- **Skip for now**: you must tick "I understand my safes can be lost forever if an admin resets my password and I forget my old one". You can create a code later under **Account → Recovery code**.

Anyone who has your recovery code and your current password can open your safes, so keep the code as private as the password. Creating a new code in **Account** makes the old one stop working. When typing a code, capital or small letters, spaces, and dashes do not matter, the letter O counts as zero, and I and L count as one.

### Opening and locking

Signing in to the vault does not open your safes. Choose **Open safes** and enter your password again. After opening, Moliya shows when your safes were **previously opened**; if you do not recognise that time, someone else may have used your password.

Your safes lock again:

- when you choose **Lock safes**;
- after 5 minutes without activity (you can choose 1, 5, 15, or 30 minutes in **Account**);
- when the tab is hidden for more than a minute;
- when the vault locks.

### Safes

Choose **New safe** to add one. Each safe has a name (up to 60 characters), an optional description, one of eight icons, and one of four colours. In **Safe settings** you can also:

- **Ask for my password every time this safe is opened**: the safe stays closed, even when your other safes are open, until you enter your password for it. While closed it is left out of search, totals, and upcoming payments.
- **Make default**: the safe new items go to first.
- **Archive**: the safe becomes read-only and is left out of search, totals, upcoming payments, and expiring cards. **Show archived** lists it again, and **Unarchive** undoes it.
- **Change encryption key**: encrypts everything in the safe again with a new key. Use it if you think the old key might have been exposed.
- **Delete safe**: moves it to the trash. If it still has items, move them to another safe first or choose to delete them with it. You always keep at least one safe.

You can have up to 50 safes and 5,000 items (1,000 per safe), counting what is in the trash.

### Cards

Choose **Add card** and fill in the cardholder name, the card number, the brand, the expiry month and year, the bank, and notes. Moliya detects the brand from the number; you can change it.

- The number is checked with the usual check digit. For Visa, Mastercard, American Express, and Mir a failed check is an error. For UzCard, Humo, UnionPay, and Other it is only a warning, because some local cards do not follow the rule.
- The **security code (CVV)** is optional and hidden behind **Add security code**. Banks advise against keeping it; leave it empty unless you really need it.
- There is no place for a PIN. Never store your card PIN, here or anywhere else.

Cards are listed with only the last four digits and the expiry date. Expired cards are marked, and cards that expire within 60 days are marked **Expires soon** and listed on the safes page.

### Subscriptions

Choose **Add subscription** and enter the service name, the price and currency, the billing cycle (weekly, monthly, every 3 months, yearly, or every N days), one past or upcoming payment date, and the status (active, paused, or cancelled). You can also add a trial end date, how many days before a payment to remind you, the card it is paid with, the website, the account or login, and notes.

The safes page shows what your active subscriptions cost **per month** and **per year**, for each currency separately. Currencies are not converted, so a USD total and a UZS total are listed side by side. **Upcoming payments** lists what is due in the next 30 days and highlights those within your reminder time or near the end of a trial.

### Notes

Choose **Add note** for anything else, up to 10,000 characters. Notes are plain text.

### Showing and copying card numbers

Card numbers and security codes are hidden. **Show** and **Copy** ask for your password unless you entered it in the last 2 minutes.

- A shown value hides again after 15 seconds (15, 30, or 60 in **Account**), or when you switch away.
- A copied value is cleared from the clipboard after 30 seconds (10, 30, or 60 in **Account**), when your safes lock, and when you leave the page. Browsers do not always allow this, so paste it promptly and do not rely on it.

Permanent deletes, changing a safe's encryption key, resetting your safes, and creating a recovery code also need your password within the last 2 minutes.

### Moving, copying, and favourites

Select items to **Move to…** or **Copy to…** another safe. They are encrypted again with the other safe's key. Mark items you use often as favourites; **Favourites** filters them. **Search open safes** searches every open, non-archived safe.

### Trash

Deleted safes and items go to **Trash** and stay there for 30 days. You can **Restore** them, or **Delete permanently** (for a safe, type its name to confirm). After 30 days they are removed for good the next time you open your safes.

Deleted data is also overwritten in the database, but copies stay in older backups and in the earlier copies the browser keeps. It is gone completely only when those are gone too.

### Activity

**Activity** lists what happened in your safes: when they were opened, and when safes and items were added, changed, moved, deleted, or restored. Only you can read it; it is encrypted like your safes and never appears in the admin's audit log. It shows the kind of action and the time, not names or values.

### After an admin resets your password

If your admin resets your password:

1. Sign in with the temporary password they give you. Moliya asks you to choose a new password in **Account**.
2. Open **Private safes**. Moliya says your password changed since you last opened your safes.
3. Enter the **previous password**: the one you chose yourself before the reset, not the temporary one from the admin. Or choose **Use recovery code instead** and enter your code. Also enter your current password.
4. Your safes open, and from now on your current password opens them. If you used the recovery code, create a new one.

Never type the temporary password from your admin as your previous password. Your safes are never unlocked with a password that someone else chose; that is what keeps them private from the admin.

If you remember neither your previous password nor your recovery code, nobody can open your safes. Under **Account → Start over**, **Reset private safes** destroys them and everything in them and gives you a new, empty safe. Type `RESET` and your password to confirm.

## Updates and version

When a new version of Moliya is published, a bar appears at the top: **A new version of Moliya is available.** Choose **Reload** when convenient. Your work is saved and the vault is locked first, so sign in again afterwards. The first sign-in after an update may take a few seconds longer while Moliya upgrades the data or strengthens your password protection. This happens once.

The version you are using is shown at the bottom of the menu and on the sign-in screen. Mention it when you report a problem.

## Language and theme

Pick a language from the language menu: Oʻzbekcha, Ўзбекча, Русский, or English. Pick **Day**, **Night**, or **System** to follow your device. Both choices are remembered in this browser.

## Good habits

- Lock the vault before leaving a shared device.
- Do not clear this site's browsing data. Doing so deletes the vault from this browser. Only a backup can bring it back.
- Use a password that is long and not used anywhere else.
- If you use private safes, create a recovery code and keep it offline.
- Lock your safes when you are done with them, even if you keep the vault open.
