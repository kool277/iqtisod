import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { watchViolations } from '../support/csp'

const ADMIN = { email: 'admin@example.com', password: 'Correct horse lantern 7' }

async function createVault(page: Page) {
  await page.goto('/')
  await page.getByTestId('setup-name').fill('Home')
  await page.getByTestId('setup-email').fill(ADMIN.email)
  await page.getByTestId('setup-password').fill(ADMIN.password)
  await page.getByTestId('setup-confirm').fill(ADMIN.password)
  await page.getByTestId('setup-submit').click()
  await expect(page.getByTestId('kpi-net')).toBeVisible({ timeout: 30_000 })
}

async function signIn(page: Page, email: string, password: string) {
  await page.getByTestId('login-email').fill(email)
  await page.getByTestId('login-password').fill(password)
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 })
}

async function lock(page: Page) {
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 30_000 })
  await page.getByTestId('lock-vault').click()
  await expect(page.getByTestId('login-email')).toBeVisible({ timeout: 30_000 })
}

async function addRecord(page: Page, type: 'INCOME' | 'EXPENSE', amount: string, notes: string) {
  await page.getByTestId('add-transaction').click()
  await page.getByTestId('tx-type').selectOption(type)
  await page.getByTestId('tx-amount').fill(amount)
  await page.getByTestId('tx-notes').fill(notes)
  await page.getByTestId('tx-save').click()
  await expect(page.locator(`[data-testid="tx-row"][data-amount="${amount}"]`)).toBeVisible()
}

const amounts = (page: Page) => page.getByTestId('tx-row').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-amount')))

test('the ledger table sorts, searches, remembers hidden columns, edits inline and exports the current view', async ({ page }) => {
  const violations = await watchViolations(page)
  await createVault(page)
  await page.getByTestId('nav-transactions').click()
  await addRecord(page, 'EXPENSE', '200', 'Groceries')
  await addRecord(page, 'INCOME', '1000', 'Salary')
  await addRecord(page, 'EXPENSE', '50.5', 'Такси')
  await expect.poll(() => amounts(page)).toEqual(['50.5', '1000', '200'])

  const amountHeader = page.getByTestId('table-transactions').locator('th', { has: page.getByTestId('sort-transactions-amount') })
  await page.getByTestId('sort-transactions-amount').click()
  await expect(amountHeader).toHaveAttribute('aria-sort', 'ascending')
  await expect.poll(() => amounts(page)).toEqual(['50.5', '200', '1000'])
  await page.getByTestId('sort-transactions-amount').click()
  await expect(amountHeader).toHaveAttribute('aria-sort', 'descending')
  await expect.poll(() => amounts(page)).toEqual(['1000', '200', '50.5'])

  const search = page.getByTestId('transactions-search')
  await search.fill('taksi')
  await expect.poll(() => amounts(page)).toEqual(['50.5'])
  await expect(page.getByTestId('transactions-summary')).toContainText('filtered from 3')
  await search.press('Escape')
  await expect(page.getByTestId('tx-row')).toHaveCount(3)

  await page.getByTestId('transactions-filters-toggle').click()
  await page.getByTestId('transactions-filter-amount-min').fill('100')
  await expect.poll(() => amounts(page)).toEqual(['1000', '200'])
  await page.getByTestId('transactions-clear-filters').click()
  await expect(page.getByTestId('tx-row')).toHaveCount(3)
  await page.getByTestId('transactions-filters-toggle').click()

  const notesCells = page.locator('[data-testid="tx-row"] td[data-column="notes"]')
  await expect(notesCells).toHaveCount(3)
  await page.getByTestId('transactions-columns').click()
  await page.getByTestId('column-toggle-notes').uncheck()
  await page.keyboard.press('Escape')
  await expect(notesCells).toHaveCount(0)

  await lock(page)
  await page.reload()
  await signIn(page, ADMIN.email, ADMIN.password)
  await page.getByTestId('nav-transactions').click()
  await expect(page.getByTestId('tx-row')).toHaveCount(3)
  await expect(notesCells).toHaveCount(0)
  await expect(page.getByTestId('sort-transactions-amount').locator('xpath=ancestor::th')).toHaveAttribute('aria-sort', 'descending')

  const groceries = page.locator('[data-testid="tx-row"][data-amount="200"]')
  await groceries.locator('[data-testid^="edit-amount-"]').click()
  const editor = groceries.locator('[data-testid^="editor-amount-"]')
  await editor.fill('abc')
  await editor.press('Enter')
  await expect(groceries.locator('[data-testid^="error-amount-"]')).toBeVisible()
  await editor.press('Escape')
  await expect(editor).toHaveCount(0)
  await groceries.locator('[data-testid^="edit-amount-"]').click()
  await groceries.locator('[data-testid^="editor-amount-"]').fill('250')
  await groceries.locator('[data-testid^="editor-amount-"]').press('Enter')
  await expect(page.locator('[data-testid="tx-row"][data-amount="250"]')).toBeVisible()

  await page.getByTestId('nav-dashboard').click()
  await expect(page.getByTestId('kpi-expense')).toHaveAttribute('data-amount', '300.5')
  await expect(page.getByTestId('kpi-net')).toHaveAttribute('data-amount', '699.5')

  await page.getByTestId('nav-transactions').click()
  await page.getByTestId('transactions-search').fill('250')
  await expect(page.getByTestId('tx-row')).toHaveCount(1)
  await page.getByTestId('transactions-export').click()
  await page.getByTestId('transactions-export-csv').check()
  await expect(page.getByTestId('transactions-export-start')).toBeDisabled()
  await page.getByTestId('transactions-export-confirm').check()
  const pending = page.waitForEvent('download')
  await page.getByTestId('transactions-export-start').click()
  const download = await pending
  expect(download.suggestedFilename()).toMatch(/\.csv$/)
  const text = readFileSync((await download.path())!, 'utf8').replace(/^\uFEFF/, '')
  const lines = text.trim().split(/\r?\n/)
  expect(lines).toHaveLength(2)
  expect(lines[0]).not.toContain('Notes')
  expect(lines[1]).toContain('250')
  expect(text).not.toContain('Groceries')

  await page.getByTestId('nav-audit').click()
  await expect(page.getByRole('cell', { name: 'Data exported', exact: true })).toHaveCount(1)
  expect(await violations()).toEqual([])
})

test('admin tables keep their actions and a member only sees their own group in the dashboard filter', async ({ page }) => {
  const violations = await watchViolations(page)
  const member = { email: 'member@example.com', temporary: 'Temporary lamp words 22', next: 'Member picks own words 4' }
  await createVault(page)

  await page.getByTestId('nav-groups').click()
  for (const name of ['Business', 'Travel']) {
    await page.getByTestId('group-name').fill(name)
    await page.getByTestId('group-save').click()
    await expect(page.getByTestId('group-row').filter({ hasText: name })).toBeVisible()
  }
  await page.getByTestId('groups-search').fill('busi')
  await expect(page.getByTestId('group-row')).toHaveCount(1)

  await page.getByTestId('nav-dashboard').click()
  const filter = page.getByTestId('dashboard-group')
  await expect(filter.locator('option')).toHaveText(['All groups', 'Business', 'Home', 'Travel'])
  await filter.selectOption({ label: 'Travel' })
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 30_000 })
  await page.reload()
  await signIn(page, ADMIN.email, ADMIN.password)
  await expect(page.getByTestId('dashboard-group').locator('option:checked')).toHaveText('Travel')

  await page.getByTestId('nav-users').click()
  await page.getByTestId('user-add').click()
  await page.getByTestId('advanced-temp-toggle').click()
  await page.getByTestId('user-email').fill(member.email)
  await page.getByTestId('user-password').fill(member.temporary)
  await page.getByTestId('user-role').selectOption('Manager')
  await page.getByTestId('user-group').selectOption({ label: 'Business' })
  await page.getByTestId('user-save').click()
  const row = page.getByTestId('person-row').filter({ hasText: member.email })
  await expect(row).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('users-filters-toggle').click()
  await page.getByTestId('users-filter-role').click()
  await page.getByTestId('users-filter-role-option').and(page.locator('[data-value="Manager"]')).check()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('person-row')).toHaveCount(1)
  await row.getByTestId('user-issue-reset').click()
  await expect(row.getByTestId('reset-stop-old')).toBeChecked()
  await row.getByTestId('user-issue-reset').click()
  await expect(row.getByTestId('reset-stop-old')).toHaveCount(0)
  await lock(page)

  await signIn(page, member.email, member.temporary)
  await expect(page.getByTestId('must-change-banner')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('account-current').fill(member.temporary)
  await page.getByTestId('account-new').fill(member.next)
  await page.getByTestId('account-confirm').fill(member.next)
  await page.getByTestId('account-save').click()
  await expect(page.getByTestId('must-change-banner')).toHaveCount(0, { timeout: 30_000 })
  await page.getByTestId('nav-dashboard').click()
  await expect(page.getByTestId('dashboard-group').locator('option')).toHaveText(['All groups', 'Business'])
  await expect(page.getByTestId('dashboard-group').locator('option:checked')).toHaveText('All groups')
  expect(await violations()).toEqual([])
})
