import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { watchViolations } from '../support/csp'

const TARGET = process.env.E2E_TARGET === 'preview' ? 'preview' : 'dev'
const SCREENS = resolve(process.env.GROUP_SUMMARY_SCREENS ?? `/tmp/moliya-group-summary-screens/${TARGET}`)

async function createVault(page: Page) {
  await page.goto('/')
  await page.getByTestId('setup-name').fill('Home')
  await page.getByTestId('setup-email').fill('admin@example.com')
  await page.getByTestId('setup-password').fill('Correct horse lantern 7')
  await page.getByTestId('setup-confirm').fill('Correct horse lantern 7')
  await page.getByTestId('setup-submit').click()
  await expect(page.getByTestId('kpi-net')).toBeVisible({ timeout: 30_000 })
}

async function addRecord(page: Page, group: string, type: 'INCOME' | 'EXPENSE', amount: string, currency = 'USD') {
  await page.getByTestId('nav-transactions').click()
  await page.getByTestId('add-transaction').click()
  await page.getByTestId('tx-type').selectOption(type)
  await page.getByTestId('tx-amount').fill(amount)
  await page.getByTestId('tx-currency').selectOption(currency)
  await page.getByTestId('tx-group').selectOption({ label: group })
  await page.getByTestId('tx-save').click()
  await expect(page.locator(`[data-testid="tx-row"][data-amount="${amount}"]`)).toBeVisible()
}

async function expectLine(scope: Locator, currency: string, income: string, expense: string, net: string) {
  // Table cells carry the currency on each figure; the totals strip groups the figures of one currency.
  const figure = (kind: string) =>
    scope.locator(`[data-testid="summary-${kind}"][data-currency="${currency}"], [data-currency="${currency}"] [data-testid="summary-${kind}"]`)
  await expect(figure('income')).toHaveAttribute('data-amount', income)
  await expect(figure('expense')).toHaveAttribute('data-amount', expense)
  await expect(figure('net')).toHaveAttribute('data-amount', net)
}

const ledgerAmounts = (page: Page) =>
  page.getByTestId('tx-row').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-amount')).sort())

async function lockVault(page: Page) {
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 30_000 })
  await page.getByTestId('lock-vault').click()
  await expect(page.getByTestId('login-email')).toBeVisible({ timeout: 30_000 })
}

test('groups page shows income, expenses and net per group and currency, scoped for managers', async ({ page }) => {
  const violations = await watchViolations(page)
  await createVault(page)

  await page.getByTestId('nav-groups').click()
  await page.getByTestId('group-name').fill('Field team')
  await page.getByTestId('group-save').click()
  await expect(page.getByTestId('group-row')).toHaveCount(2)
  await expect(page.getByTestId('group-summary-total')).toHaveAttribute('data-count', '0')

  await addRecord(page, 'Home', 'INCOME', '1000')
  await addRecord(page, 'Home', 'EXPENSE', '200')
  await addRecord(page, 'Home', 'EXPENSE', '50', 'EUR')
  await addRecord(page, 'Field team', 'INCOME', '300')
  await addRecord(page, 'Field team', 'EXPENSE', '450')

  await page.getByTestId('nav-groups').click()
  await page.getByTestId('period-month').click()
  const home = page.locator('[data-testid="group-row"][data-group="Home"]')
  const field = page.locator('[data-testid="group-row"][data-group="Field team"]')
  const total = page.getByTestId('group-summary-total')
  await expect(home).toHaveAttribute('data-count', '3')
  await expect(home.getByTestId('summary-count')).toHaveText('3')
  await expectLine(home, 'USD', '1000', '200', '800')
  await expectLine(home, 'EUR', '0', '50', '-50')
  await expect(field).toHaveAttribute('data-count', '2')
  await expectLine(field, 'USD', '300', '450', '-150')
  await expect(field.locator('[data-currency="EUR"]')).toHaveCount(0)
  await expect(field.getByTestId('summary-net')).toHaveClass(/text-clay-ink/)
  await expect(home.locator('[data-testid="summary-net"][data-currency="USD"]')).toHaveClass(/text-pine-ink/)

  const rowNames = () => page.getByTestId('group-row').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-group')))
  await page.getByTestId('sort-groups-net').click()
  await expect.poll(rowNames).toEqual(['Field team', 'Home'])
  await page.getByTestId('sort-groups-net').click()
  await expect.poll(rowNames).toEqual(['Home', 'Field team'])
  await page.getByTestId('sort-groups-net').click()
  await expect(total).toHaveAttribute('data-count', '5')
  await expectLine(total, 'USD', '1300', '650', '650')
  await expectLine(total, 'EUR', '0', '50', '-50')

  mkdirSync(SCREENS, { recursive: true })
  await page.getByTestId('theme-light').click()
  await page.screenshot({ path: `${SCREENS}/groups-light.png`, fullPage: true })
  await page.getByTestId('theme-dark').click()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.screenshot({ path: `${SCREENS}/groups-dark.png`, fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: `${SCREENS}/groups-dark-mobile.png`, fullPage: true })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  await page.getByTestId('theme-light').click()
  await page.screenshot({ path: `${SCREENS}/groups-light-mobile.png`, fullPage: true })
  await page.setViewportSize({ width: 1280, height: 720 })

  await page.getByTestId('period-lastMonth').click()
  await expect(total).toHaveAttribute('data-count', '0')
  await expect(home).toHaveAttribute('data-count', '0')
  await page.getByTestId('period-month').click()
  await expect(total).toHaveAttribute('data-count', '5')

  const homeLink = home.getByTestId('group-ledger-link')
  const homeHref = await homeLink.getAttribute('href')
  expect(homeHref).toMatch(/^#\/app\/transactions\?group=\d+$/)
  await homeLink.click()
  await expect(page).toHaveURL(/#\/app\/transactions\?group=\d+$/)
  await expect.poll(() => ledgerAmounts(page)).toEqual(['1000', '200', '50'])
  await expect(page.getByTestId('transactions-filters-toggle')).toContainText('1')
  await expect(page.getByTestId('transactions-summary')).toContainText('filtered from 5')
  await page.getByTestId('nav-groups').click()
  await field.getByTestId('group-ledger-link').click()
  await expect.poll(() => ledgerAmounts(page)).toEqual(['300', '450'])
  await page.evaluate(() => {
    window.location.hash = '#/app/transactions?group=999'
  })
  await expect.poll(() => ledgerAmounts(page)).toHaveLength(5)

  await page.getByTestId('nav-users').click()
  await page.getByTestId('user-add').click()
  await page.getByTestId('advanced-temp-toggle').click()
  await page.getByTestId('user-email').fill('manager@example.com')
  await page.getByTestId('user-password').fill('Temp maple kettle 101')
  await page.getByTestId('user-role').selectOption('Manager')
  await page.getByTestId('user-group').selectOption({ label: 'Field team' })
  await page.getByTestId('user-save').click()
  await expect(page.getByText('manager@example.com')).toBeVisible({ timeout: 30_000 })
  await lockVault(page)

  await page.getByTestId('login-email').fill('manager@example.com')
  await page.getByTestId('login-password').fill('Temp maple kettle 101')
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('must-change-banner')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('account-current').fill('Temp maple kettle 101')
  await page.getByTestId('account-new').fill('Own orchard lantern 11')
  await page.getByTestId('account-confirm').fill('Own orchard lantern 11')
  await page.getByTestId('account-save').click()
  await expect(page.getByTestId('must-change-banner')).toHaveCount(0, { timeout: 30_000 })

  await page.getByTestId('nav-groups').click()
  await page.getByTestId('period-month').click()
  await expect(page.getByTestId('group-row')).toHaveCount(1)
  await expect(page.getByTestId('group-row')).toHaveAttribute('data-group', 'Field team')
  await expect(page.getByTestId('group-name')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(0)
  await expect(total).toHaveCount(0)
  await expect(field).toHaveAttribute('data-count', '2')
  await expectLine(field, 'USD', '300', '450', '-150')
  await expect(field.locator('[data-currency="EUR"]')).toHaveCount(0)
  await page.screenshot({ path: `${SCREENS}/groups-manager-light.png`, fullPage: true })

  await field.getByTestId('group-ledger-link').click()
  await expect.poll(() => ledgerAmounts(page)).toEqual(['300', '450'])
  // A link to a group the manager cannot see changes nothing: no filter, and still only their own records.
  await page.evaluate((href) => {
    window.location.hash = href
  }, homeHref!)
  await expect(page).toHaveURL(new RegExp(`${homeHref!.replace(/[?]/g, '\\?')}$`))
  await expect.poll(() => ledgerAmounts(page)).toEqual(['300', '450'])
  await expect(page.getByTestId('transactions-filters-toggle')).not.toContainText(/\d/)

  expect(await violations()).toEqual([])
})
