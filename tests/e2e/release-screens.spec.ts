import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { addDays, sealSnapshot, type FxSnapshot } from '../../src/domain/fx'
import { watchViolations } from '../support/csp'

// Release screenshots only: set RELEASE_SCREENS to the output directory to run this file.
const DIR = process.env.RELEASE_SCREENS
const RECORDED = JSON.parse(readFileSync(new URL('../fixtures/fx/snapshot.json', import.meta.url), 'utf8')) as FxSnapshot

function localToday(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function freshSnapshot(): string {
  const { digest: _digest, ...body } = structuredClone(RECORDED)
  const date = localToday()
  body.generatedAt = new Date().toISOString()
  body.quotes = body.quotes.map((quote) => ({ ...quote, date, previous: quote.previous ? { ...quote.previous, date: addDays(date, -3) } : null }))
  return JSON.stringify(sealSnapshot(body))
}

async function addRecord(page: Page, group: string, type: 'INCOME' | 'EXPENSE', amount: string, notes: string, currency = 'USD') {
  await page.getByTestId('add-transaction').click()
  await page.getByTestId('tx-type').selectOption(type)
  await page.getByTestId('tx-amount').fill(amount)
  await page.getByTestId('tx-currency').selectOption(currency)
  await page.getByTestId('tx-group').selectOption({ label: group })
  await page.getByTestId('tx-notes').fill(notes)
  await page.getByTestId('tx-save').click()
  await expect(page.locator(`[data-testid="tx-row"][data-amount="${amount}"]`)).toBeVisible()
}

async function shoot(page: Page, name: string) {
  const reminder = page.getByTestId('backup-reminder')
  if (await reminder.count()) await reminder.getByRole('button').click()
  for (const theme of ['light', 'dark'] as const) {
    await page.getByTestId(`theme-${theme}`).click()
    if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/)
    else await expect(page.locator('html')).not.toHaveClass(/dark/)
    await page.screenshot({ path: resolve(DIR!, `${name}-${theme}.png`), animations: 'disabled' })
  }
}

test('release screenshots: groups with summaries, ledger from a group link, dashboard, mobile ledger', async ({ page }) => {
  test.skip(!DIR, 'set RELEASE_SCREENS to take release screenshots')
  mkdirSync(DIR!, { recursive: true })
  const violations = await watchViolations(page)
  await page.context().route('**/rates/latest.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: freshSnapshot() }))
  await page.setViewportSize({ width: 1440, height: 1000 })

  await page.goto('/')
  await page.getByTestId('setup-name').fill('Home')
  await page.getByTestId('setup-email').fill('admin@example.com')
  await page.getByTestId('setup-password').fill('Correct horse lantern 7')
  await page.getByTestId('setup-confirm').fill('Correct horse lantern 7')
  await page.getByTestId('setup-submit').click()
  await expect(page.getByTestId('kpi-net')).toBeVisible({ timeout: 30_000 })

  await page.getByTestId('nav-groups').click()
  for (const name of ['Field team', 'Shop']) {
    await page.getByTestId('group-name').fill(name)
    await page.getByTestId('group-save').click()
    await expect(page.locator(`[data-testid="group-row"][data-group="${name}"]`)).toBeVisible()
  }

  await page.getByTestId('nav-transactions').click()
  await addRecord(page, 'Home', 'INCOME', '2400', 'Salary')
  await addRecord(page, 'Home', 'EXPENSE', '184.5', 'Groceries')
  await addRecord(page, 'Home', 'EXPENSE', '62', 'Taxi')
  await addRecord(page, 'Home', 'EXPENSE', '45', 'Museum tickets', 'EUR')
  await addRecord(page, 'Field team', 'INCOME', '950', 'Client payment')
  await addRecord(page, 'Field team', 'EXPENSE', '1210', 'Equipment')
  await addRecord(page, 'Shop', 'INCOME', '3150', 'Sales')
  await addRecord(page, 'Shop', 'EXPENSE', '870.25', 'Stock')

  await page.getByTestId('nav-groups').click()
  await page.getByTestId('period-month').click()
  await expect(page.getByTestId('group-summary-total')).toHaveAttribute('data-count', '8')
  await page.getByTestId('sort-groups-net').click()
  await page.getByTestId('sort-groups-net').click()
  await shoot(page, 'groups-table-summaries')

  await page.locator('[data-testid="group-row"][data-group="Home"]').getByTestId('group-ledger-link').click()
  await expect(page.getByTestId('tx-row')).toHaveCount(4)
  await expect(page.getByTestId('transactions-filters-toggle')).toContainText('1')
  await shoot(page, 'ledger-group-deep-link')

  await page.getByTestId('nav-dashboard').click()
  await page.getByTestId('dashboard-group').selectOption({ label: 'Home' })
  await expect(page.getByTestId('fx-pair')).toHaveCount(3)
  await expect(page.getByTestId('kpi-income')).toHaveAttribute('data-amount', '2400')
  await shoot(page, 'dashboard-group-filter-rates')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByTestId('nav-transactions').click()
  await expect(page.getByTestId('tx-row')).toHaveCount(8)
  await shoot(page, 'ledger-mobile')
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)

  expect(await violations()).toEqual([])
})
