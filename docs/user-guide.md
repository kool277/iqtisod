# User guide

This guide is for people who use a Jaybi vault day to day: **Managers**, who record income and expenses, and **Viewers**, who review them. Everyone, whatever their role, can keep their own [private safes](#private-safes). Admins can do everything here too. Their extra tasks are in the [admin guide](admin-guide.md).

## Before you start

Your admin gives you the address of the app, your email, and usually a **one-time code**. You use the code once to [join the vault](#joining-with-a-code) and choose your own password, so nobody else ever knows it. Some admins give a starting password instead; then Jaybi asks you to replace it the first time you sign in (see [Your account](#your-account)).

Jaybi has no "forgot password" link. If you forget your password, ask your admin for a reset code, but read [After an admin resets your password](#after-an-admin-resets-your-password) first if you use private safes.

Jaybi was called Moliya before version 1.3.0, and it moves from `kool277.github.io/iqtisod` to `https://jaybi.uz`. If your admin has moved the vault, use the new address with your usual email and password.

The vault lives inside one browser on one device. If your admin set it up on a shared computer, use that computer and that browser. Opening the app on your own phone will show an empty setup screen, because that browser has no vault yet. Your admin can move a copy there with a backup file.

## Joining with a code

A code has seven groups of four letters and digits, like `XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`. It works once, for your email only, and only until the time your admin chose (24 hours unless they picked another time).

1. Open the app in the browser where the vault is stored. On **Unlock vault**, choose **Have a one-time code? Join the vault**. If your admin sent you a link, opening it fills in your email and the code for you.
2. Check **Your email**, and type or paste the **One-time code**. Capital or small letters, spaces, and dashes do not matter; the letter O counts as zero, and I and L count as one.
3. Enter a password under **Choose a password** and again under **Confirm password**. See [Choosing a password](#choosing-a-password).
4. Choose **Join vault**. You are signed in.

A code works only in the browser where the vault is stored, because that is where the vault is. If Jaybi says "There is no vault in this browser yet", you are on the wrong device or browser. Open the app where your admin set it up, or first choose **Import a backup** if your admin gave you a backup file.

If Jaybi says the code has expired or does not match, ask your admin for a new one. Keep the code private until you have used it: anyone with the code and your email can join as you while it is open.

## Signing in

1. Open the app. You will see **Unlock vault**.
2. Enter your email and password, then choose **Unlock**.

Unlocking takes a moment, because your password is deliberately stretched to make guessing slow. If you see "Email or password is incorrect", check both. The message is the same for either mistake on purpose.

After five wrong tries for the same email, Jaybi shows **Too many attempts. Try again in** with a countdown, and the wait doubles with each further mistake, up to 15 minutes. Codes and the sign-in check are limited the same way. Wait for the countdown to finish; refreshing the page does not shorten it. After you sign in, Jaybi tells you how many failed attempts there were for your account in this browser since your last sign-in. If you did not make them, change your password.

This limit slows down someone guessing at this screen. It does not protect a copy of the vault or a backup: someone with a copy can guess without any limit, and only a long, uncommon password stops them.

### The second step

If you turned on the [sign-in check](#sign-in-check), Jaybi asks for a second step after your password: "Enter the 6-digit code from your authenticator app, or one of your recovery codes." Type the code into **Code** and choose **Continue**. Each code works once. If you wait more than 5 minutes, or choose **Cancel**, you go back to **Unlock vault**.

If you sign in with a recovery code, a bar shows **You used a recovery code. Codes left:** with the number. When few are left, turn the sign-in check off and on again in **Account** to get new ones.

### If Jaybi shows "For your safety, Jaybi does not run inside another page."

Jaybi refuses to run inside another website's page, because that page could trick you into clicking or typing. Choose **Open Jaybi in its own tab**, and check that the address is the one your admin gave you.

### Resetting your password with a code

If your admin gives you a reset code:

1. On **Unlock vault**, choose **Have a reset code?** (or open the link your admin sent).
2. Enter **Your email**, the **One-time code**, and your new password twice.
3. Choose **Set new password**. You are signed in with the new password.

Like an invite code, a reset code works once, only until it expires, and only in the browser where the vault is stored. Your old password stops working when you use the code, and sooner if your admin chose to stop it at once. Setting a new password this way also turns off your [sign-in check](#sign-in-check); turn it on again in **Account** if you use it. If you use private safes, read [After an admin resets your password](#after-an-admin-resets-your-password).

## Finding your way around

The menu on the left (along the top on a phone) shows only what your role allows:

| Role | Dashboard | Transactions | Add, edit, delete records | Private safes and Account |
| --- | --- | --- | --- | --- |
| Manager | Yes | Yes | Yes, for your group | Yes, your own |
| Viewer | Yes | Yes | No | Yes, your own |

You only see records that belong to your group. The top bar shows the vault name, the save status, the language and theme switches, and the **Lock** button.

The button at the far left of the top bar collapses the menu. On a computer the menu shrinks to icons, and pointing at an icon shows its name. On a phone the menu row is hidden. Choose the button again to bring the menu back. Jaybi remembers your choice in this browser.

## Choosing a period

Both the dashboard and the ledger use the same period buttons, and your choice carries over between them:

- **Today**
- **This week** (Monday to Sunday)
- **This month** (the default)
- **Last month**
- **Year to date** (1 January to today)
- **Custom**, which opens From and To date fields. If you enter them backwards, Jaybi swaps them.

## Working with tables

Transactions, the private-safe lists, and the admin pages show their rows in tables that work the same way:

- **Sort**: choose a column heading. Choose it again for the other direction, and a third time to go back to the original order. Hold Shift while choosing to sort by up to three columns; small numbers next to the headings show the order. Amounts sort exactly within each currency, and names sort in the order of your language. On a phone, use **Sort by** above the cards.
- **Search this table**: type any part of what you see in the visible columns. Case, accents, apostrophes, and the alphabet do not matter, so `taksi` finds "Такси" and `ozbek` finds "Oʻzbek". Esc clears the search.
- **Filters**: opens a box with one filter per column: text, a list to tick one or more values, a From–To date range, or a Min–Max amount. The button shows how many filters are on, and **Clear filters** turns them all off. Amount filters compare the exact amount; they do not convert currencies.
- **Columns**: tick the columns to show, move them up or down, choose **Compact rows**, or **Reset layout**. Columns that identify a row, such as the date or amount, always stay.
- **Rows** at the bottom: 10, 25, 50, 100, or all. The line next to it says which rows you see, for example "Showing 1–25 of 140 (filtered from 900)".

Jaybi remembers the columns, their order, the sort, the row count, and compact rows for each table in this browser. It never stores what you searched for or filtered, and nothing from your private safes.

Where you are allowed to change a record, a small pencil appears next to the value. Choose it, type the new value, and press Enter to save or Esc to cancel. If the value is not accepted, the reason shows under the field and nothing changes.

## Recording money (Managers)

1. Open **Transactions** and choose **Add record**.
2. Fill in the form:
   - **Type**: Income or Expense. The category list changes to match.
   - **Amount**: a number above zero, with up to two decimals (for example `1250`, `1250.5`, or `1 250,50`). A dot or a comma both work as the decimal mark, and spaces between thousands are ignored. Jaybi stores the exact amount and never rounds it; if you type more decimals than the currency has, it asks you to fix the amount instead of guessing.
   - **Category**: for example Salary, Food, or Transport.
   - **Date**: defaults to today.
   - **Currency**: defaults to the vault currency. See the note on currencies below.
   - **Group**: only shown if you can see more than one group.
   - **Notes**: optional, up to 2,000 characters.
   - **Receipt**: optional PNG, JPEG, WebP, or GIF image, up to 1.5 MB. Other file types, including SVG, are refused. Use **View receipt** to check it, or **Remove receipt** to drop it.
3. Choose **Save**.

To change a record, choose **Edit** on it, adjust the fields, and choose **Update record**. For a quick fix, choose the pencil next to the date, category, group, amount, or notes and change just that value (see [Working with tables](#working-with-tables)). To delete, choose **Delete**, then confirm. To delete several records, tick them and choose **Delete selected**, then confirm. Deleting cannot be undone, but each deletion is recorded in the admin's audit log.

To narrow the list, use the period buttons and the **All / Income / Expense** filter above the table, or the table's search and filters. Hidden columns such as **Currency**, **Recorded by**, **Receipt**, **Created**, and **Updated** can be turned on under **Columns**.

### A note on currencies

Each vault has one main currency, chosen when it was created and changeable by an Admin. Totals and charts only count records in that currency. A record in another currency is still saved and listed, marked "Other currency — not included in totals". The dashboard lists those records separately under **Other currencies (not in totals)**, with income and expenses per currency, so nothing is hidden. Jaybi does not convert records between currencies; the exchange-rate panel on the dashboard is for information and never changes your totals.

## Reading the dashboard

The list next to the period buttons picks the group: **All groups** or one group. It changes the four figures, the charts, and the list of other currencies, but not the exchange rates. You only see groups you belong to, so for most people the list has **All groups** and their own group, which show the same figures. Jaybi remembers the choice in this browser.

The four figures at the top cover the selected period and group:

- **Net balance**: income minus expenses.
- **Total income** and **Total expenses**.
- **Savings rate**: the share of income left after expenses, rounded to one decimal. It shows 0% when there is no income in the period, and it can be negative if you spent more than you earned.

All totals are calculated exactly, to the cent (or tiyin), in the vault currency.

The charts below them:

- **Income and expenses** compares each month in the period.
- **Expenses by category** shows where the money went.
- **Spending over time** shows daily expense totals.
- **Who spent** shows expenses per person in your group. Admins see **Spending by group** instead, unless they picked one group.

A chart shows "No figures in this range" when the period has no matching records.

## Exchange rates

The **Exchange rates** panel on the dashboard shows official reference rates for the Uzbek soʻm (UZS), the South Korean won (KRW), and the Israeli new shekel (ILS) against the US dollar (USD), in both directions. Each card shows:

- **1 USD = …** and **1 UZS = …** (or KRW, ILS). Rates published by a central bank are shown exactly as published. Rates Jaybi derives, such as the reverse direction, are shown to six significant digits.
- For very small numbers, a readable amount as well, for example **100,000 UZS = 8.47 USD**.
- The change since the previous official rate, for example **−0.16% vs Sep 26, 2026**.
- **Rate date**: the day the rate is valid for. The Central Bank of Uzbekistan sets the soʻm rate the evening before, so it can show tomorrow's date.
- The **source**, which opens the central bank's own rate page. "Cross rate via EUR" means the rate was calculated from two official rates of the same bank; for the won, the European Central Bank's euro rates are used (1 USD = KRW per euro ÷ USD per euro), because the Bank of Korea does not offer rates that can be read without a private key.
- A **Stale** badge when the rate is more than 2 business days old, for example after a holiday or when the rates could not be updated.

The **Converter** turns an amount into the other currency. Enter the amount (spaces and a comma or dot are fine) and choose the direction, or use the ⇄ button to reverse it. The result is rounded to the currency's smallest unit: cents for USD, tiyin for UZS, agorot for ILS, and whole won for KRW (the won has no smaller unit, so KRW amounts cannot have decimals). **Exact** shows the unrounded value to 20 significant digits.

These are official central-bank reference rates for information only; bank buy/sell rates differ. Use your bank's rate for real transactions.

The panel never holds up the rest of the dashboard. Rates are saved in this browser, so the last rates are still shown when you are offline, with a note and a **Try again** button. If rates have never loaded in this browser, the panel says they are unavailable. Rates are public data: they are not stored in your encrypted vault and loading them does not reveal anything about your ledger.

## Saving and locking

You never need to press a save button for the vault itself. The status next to the language switch tells you what is happening:

- **Saved**: everything is encrypted and stored.
- **Unsaved** or **Encrypting…**: a change is being stored. This normally takes about a second.
- **Could not save**: the browser refused to store data, for example because the disk is full or storage is blocked. Keep the tab open and tell your admin.
- **Not saved: changed elsewhere**: the vault was changed in another tab or window. Jaybi stops saving here rather than overwrite that change. Lock, unlock again, and redo your last change.

The vault can be unlocked in only one tab at a time. If you see "already unlocked in another tab or window", switch to that tab or lock it there first.

Choose **Lock** when you step away. Locking, refreshing, or closing the tab removes the decrypted data from memory, and the next person must sign in. Jaybi also locks the vault by itself after 15 minutes without activity; you can change this under **Account → Lock automatically**. When that happens, the sign-in screen says "The vault was locked after a period of inactivity." Your private safes lock with the vault.

If a bar says **The vault is close to its size limit. Remove large receipts to make room.**, tell your admin. Receipts take most of the space, and once the vault is full no new receipts can be added.

## Your account

Open **Account** in the menu. Everyone has this page, whatever their role.

### Changing your password

Enter your **current password**, then the **new password** twice (different from the current one; see [Choosing a password](#choosing-a-password)), and choose **Change password**. If you have set up private safes, and if you use the sign-in check, they move to the new password at the same time.

If your admin gave you a starting or temporary password, the password was chosen by them. Jaybi then asks you to choose a new one before you can use anything else: every page leads back to **Account** until you do.

If a bar says **Your password is shorter or more common than Jaybi now allows. Please choose a new one.**, your password still works, but it would not be accepted today. Choose **Change password** and pick a better one.

### Choosing a password

Jaybi shows the hint "At least 12 characters. A few unrelated words work well." A new password must:

- be 12 to 256 characters long;
- not be a commonly used password, even with digits or symbols added before or after it (Jaybi checks a built-in list, without sending anything anywhere);
- not be mostly your email or the vault name;
- not use three or fewer different characters, repeat a short pattern, or follow a run of keys such as `qwertyuiop` or `1234567890`.

Four or five unrelated words, with spaces if you like, are easy to remember and hard to guess. Do not reuse a password from another site. Your password is what protects copies of the vault and backups; nothing else does.

### Sign-in check

The sign-in check asks for a 6-digit code from an authenticator app (such as Google Authenticator, Microsoft Authenticator, Aegis, or 1Password) after your password. It is optional. Jaybi shows this note next to it:

> This adds a second step to signing in to the app. It does not add encryption: anyone with a copy of the vault and your password can still open it with the recovery tool.

So it helps if someone learns your password and tries it in this browser. It does not replace a strong password.

To turn it on:

1. Choose **Set up sign-in check**.
2. Scan the QR code with your authenticator app, or type the **Setup key** into it (**Copy key** copies it; the clipboard is cleared after 60 seconds).
3. Enter the current **Code from the app** and **Your password**, then choose **Confirm and turn on**.
4. Jaybi shows 10 **Recovery codes**. Each works once in place of an app code if you lose your phone. Choose **Download codes** or write them down, keep them away from this device, and choose **I have saved these codes**. They are not shown again.

If you set it up before 1.3.0, your authenticator app lists the entry as "Moliya". It keeps working; there is no need to set it up again.

To turn it off, choose **Turn off sign-in check** and enter your password. To get new recovery codes, turn it off and on again; the old codes then stop working, and you must add the new setup key to your app.

If you lose both your authenticator and your recovery codes, ask your admin to turn off the sign-in check for you. Resetting your password with a reset code also turns it off.

### Lock automatically

Choose how long the vault stays open without activity: **5 minutes**, **15 minutes** (the default), **30 minutes**, or **1 hour**. The setting belongs to this browser, not to your account. Clicking, typing, scrolling, or touching the screen anywhere in Jaybi counts as activity, including inside your safes. If the tab was in the background longer than the chosen time, the vault locks as soon as you return to it. Your private safes have no timer of their own: they lock when the vault does.

### Other settings on this page

The sign-in check and **Lock automatically** are hidden until you have replaced a starting or temporary password.

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

Signing in to the vault does not open your safes. Choose **Open safes** and enter your password again. After opening, Jaybi shows when your safes were **previously opened**; if you do not recognise that time, someone else may have used your password.

Once open, your safes stay open while you work, including while you switch to another tab or window. They lock again:

- when you choose **Lock safes**;
- when the vault locks: when you choose **Lock**, refresh or close the tab, or after the time under **Account → Lock automatically** without activity (15 minutes unless you changed it).

Before 1.3.1 safes also locked after 5 minutes of their own and when the tab was hidden for a minute. They no longer do.

### Safes

Choose **New safe** to add one. Each safe has a name (up to 60 characters), an optional description, one of eight icons, and one of four colours. In **Safe settings** you can also:

- **Ask for my password every time this safe is opened**: the safe stays closed, even when your other safes are open, until you enter your password for it. While closed it is left out of search, totals, and upcoming payments.
- **Make default**: the safe new items go to first.
- **Archive**: the safe becomes read-only and is left out of search, totals, upcoming payments, and expiring cards. **Show archived** lists it again, and **Unarchive** undoes it.
- **Change encryption key**: encrypts everything in the safe again with a new key. Use it if you think the old key might have been exposed.
- **Delete safe**: moves it to the trash. If it still has items, move them to another safe first or choose to delete them with it. You always keep at least one safe.

You can have up to 50 safes and 5,000 items (1,000 per safe), counting what is in the trash.

### Cards

Choose **Add card** and fill in the cardholder name, the card number, the brand, the expiry month and year, the bank, and notes. Jaybi detects the brand from the number; you can change it.

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

Inside a safe, items are listed in a table (see [Working with tables](#working-with-tables)) with the title, kind, details, status, and subscription amount; **Favourite**, **Updated**, and **Created** can be turned on under **Columns**. Search matches the title and the details shown in the list, such as the card brand, the last four digits, the price, or the next payment date, but never the full card number, the CVV, or the text of a note. Trash and Activity use the same tables. Safe tables have no export and no editing in place, and Jaybi never stores what you searched or filtered in them.

### Trash

Deleted safes and items go to **Trash** and stay there for 30 days. You can **Restore** them, or **Delete permanently** (for a safe, type its name to confirm). After 30 days they are removed for good the next time you open your safes.

Deleted data is also overwritten in the database, but copies stay in older backups and in the earlier copies the browser keeps. It is gone completely only when those are gone too.

### Activity

**Activity** lists what happened in your safes: when they were opened, and when safes and items were added, changed, moved, deleted, or restored. Only you can read it; it is encrypted like your safes and never appears in the admin's audit log. It shows the kind of action and the time, not names or values.

### After an admin resets your password

If your admin resets your password:

1. Use the reset code they give you to [set a new password](#resetting-your-password-with-a-code). If they gave you a temporary password instead, sign in with it; Jaybi asks you to choose a new password in **Account**.
2. Open **Private safes**. Jaybi says your password changed since you last opened your safes.
3. Enter the **previous password**: the one you chose yourself before the reset, not a temporary one from the admin. Or choose **Use recovery code instead** and enter your code. Also enter your current password.
4. Your safes open, and from now on your current password opens them. If you used the recovery code, create a new one.

Never type the temporary password from your admin as your previous password. Your safes are never unlocked with a password that someone else chose; that is what keeps them private from the admin.

If you remember neither your previous password nor your recovery code, nobody can open your safes. Under **Account → Start over**, **Reset private safes** destroys them and everything in them and gives you a new, empty safe. Type `RESET` and your password to confirm.

## Updates and version

When a new version of Jaybi is published, a bar appears at the top: **A new version of Jaybi is available.** Choose **Reload** when convenient. Your work is saved and the vault is locked first, so sign in again afterwards. The first sign-in after an update may take a few seconds longer while Jaybi upgrades the data or strengthens your password protection. This happens once.

The version you are using is shown at the bottom of the menu and on the sign-in screen. Mention it when you report a problem.

## Language and theme

Pick a language from the language menu: Oʻzbekcha, Ўзбекча, Русский, or English. Pick **Day**, **Night**, or **System** to follow your device. Both choices are remembered in this browser.

## Getting your data out

Need your records in a spreadsheet or a PDF report? Only Admins can export data, so ask your admin. They can export one group or one period, as CSV, Excel, PDF, and other formats.

## Good habits

- Lock the vault before leaving a shared device.
- Do not clear this site's browsing data. Doing so deletes the vault from this browser. Only a backup can bring it back.
- Use a password that is long and not used anywhere else.
- Use a one-time code soon after you get it, and tell your admin if someone else may have seen it before you used it.
- If you use private safes, create a recovery code and keep it offline.
- Lock your safes when you are done with them, even if you keep the vault open.
