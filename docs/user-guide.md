# User guide

This guide is for people who use a Moliya vault day to day: **Managers**, who record income and expenses, and **Viewers**, who review them. Admins can do everything here too. Their extra tasks are in the [admin guide](admin-guide.md).

## Before you start

Your admin gives you three things: the address of the app, your email, and a starting password. Moliya has no "forgot password" link. If you forget your password, ask your admin to reset it.

The vault lives inside one browser on one device. If your admin set it up on a shared computer, use that computer and that browser. Opening the app on your own phone will show an empty setup screen, because that browser has no vault yet. Your admin can move a copy there with a backup file.

## Signing in

1. Open the app. You will see **Unlock vault**.
2. Enter your email and password, then choose **Unlock**.

Unlocking takes a moment, because your password is deliberately stretched to make guessing slow. If you see "Email or password is incorrect", check both. The message is the same for either mistake on purpose.

## Finding your way around

The menu on the left (along the top on a phone) shows only what your role allows:

| Role | Dashboard | Transactions | Add, edit, delete records |
| --- | --- | --- | --- |
| Manager | Yes | Yes | Yes, for your group |
| Viewer | Yes | Yes | No |

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

Each vault has one main currency, chosen when it was created and changeable by an Admin. Totals and charts only count records in that currency. A record in another currency is still saved and listed, marked "Other currency — not included in totals". The dashboard lists those records separately under **Other currencies (not in totals)**, with income and expenses per currency, so nothing is hidden. Moliya does not convert records between currencies; the exchange-rate panel on the dashboard is for information and never changes your totals.

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

## Exchange rates

The **Exchange rates** panel on the dashboard shows official reference rates for the Uzbek soʻm (UZS), the South Korean won (KRW), and the Israeli new shekel (ILS) against the US dollar (USD), in both directions. Each card shows:

- **1 USD = …** and **1 UZS = …** (or KRW, ILS). Rates published by a central bank are shown exactly as published. Rates Moliya derives, such as the reverse direction, are shown to six significant digits.
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
- **Not saved: changed elsewhere**: the vault was changed in another tab or window. Moliya stops saving here rather than overwrite that change. Lock, unlock again, and redo your last change.

The vault can be unlocked in only one tab at a time. If you see "already unlocked in another tab or window", switch to that tab or lock it there first.

Choose **Lock** when you step away. Locking, refreshing, or closing the tab removes the decrypted data from memory, and the next person must sign in.

## Updates and version

When a new version of Moliya is published, a bar appears at the top: **A new version of Moliya is available.** Choose **Reload** when convenient. Your work is saved and the vault is locked first, so sign in again afterwards. The first sign-in after an update may take a few seconds longer while Moliya upgrades the data or strengthens your password protection. This happens once.

The version you are using is shown at the bottom of the menu and on the sign-in screen. Mention it when you report a problem.

## Language and theme

Pick a language from the language menu: Oʻzbekcha, Ўзбекча, Русский, or English. Pick **Day**, **Night**, or **System** to follow your device. Both choices are remembered in this browser.

## Good habits

- Lock the vault before leaving a shared device.
- Do not clear this site's browsing data. Doing so deletes the vault from this browser. Only a backup can bring it back.
- Use a password that is long and not used anywhere else.
