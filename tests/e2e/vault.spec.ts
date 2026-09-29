import { expect, test, type Page } from '@playwright/test'

async function createVault(page: Page) {
  await page.goto('/')
  await page.getByTestId('setup-name').fill('Home')
  await page.getByTestId('setup-email').fill('admin@example.com')
  await page.getByTestId('setup-password').fill('correct-horse')
  await page.getByTestId('setup-confirm').fill('correct-horse')
  await page.getByTestId('setup-submit').click()
  await expect(page.getByTestId('kpi-net')).toBeVisible({ timeout: 30_000 })
}

async function addRecord(page: Page, type: 'INCOME' | 'EXPENSE', amount: string) {
  await page.getByTestId('nav-transactions').click()
  await page.getByTestId('add-transaction').click()
  await page.getByTestId('tx-type').selectOption(type)
  await page.getByTestId('tx-amount').fill(amount)
  await page.getByTestId('tx-save').click()
  await expect(page.locator(`[data-testid="tx-row"][data-amount="${amount}"]`)).toBeVisible()
}

test('sets up a vault, records money, and switches theme', async ({ page }) => {
  await createVault(page)
  await addRecord(page, 'INCOME', '1000')
  await addRecord(page, 'EXPENSE', '200')
  await page.getByTestId('nav-dashboard').click()
  await expect(page.getByTestId('kpi-income')).toHaveAttribute('data-amount', '1000')
  await expect(page.getByTestId('kpi-expense')).toHaveAttribute('data-amount', '200')
  await expect(page.getByTestId('kpi-net')).toHaveAttribute('data-amount', '800')
  await expect(page.getByTestId('kpi-savings')).toHaveAttribute('data-amount', '80')
  await expect(page.getByTestId('chart-monthly').locator('canvas')).toBeVisible()
  await expect(page.getByTestId('chart-category').locator('canvas')).toBeVisible()
  await expect(page.getByTestId('chart-trend').locator('canvas')).toBeVisible()
  await expect(page.getByTestId('chart-breakdown').locator('canvas')).toBeVisible()

  await page.getByTestId('language-select').selectOption('ru')
  await expect(page.getByRole('heading', { name: 'Обзор' })).toBeVisible()
  await page.getByTestId('language-select').selectOption('en')

  await page.getByTestId('theme-dark').click()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.getByTestId('theme-light').click()
  await expect(page.locator('html')).not.toHaveClass(/dark/)
})

test('admin creates a manager and a viewer, and the viewer stays read-only', async ({ page }) => {
  await createVault(page)
  await addRecord(page, 'EXPENSE', '40')
  await page.getByTestId('nav-users').click()

  await page.getByTestId('user-email').fill('manager@example.com')
  await page.getByTestId('user-password').fill('manager-password')
  await page.getByTestId('user-role').selectOption('Manager')
  await page.getByTestId('user-save').click()
  await expect(page.getByText('manager@example.com')).toBeVisible({ timeout: 30_000 })

  await page.getByTestId('user-email').fill('viewer@example.com')
  await page.getByTestId('user-password').fill('viewer-password')
  await page.getByTestId('user-role').selectOption('Viewer')
  await page.getByTestId('user-save').click()
  await expect(page.getByText('viewer@example.com')).toBeVisible({ timeout: 30_000 })

  await page.getByTestId('lock-vault').click()
  await page.getByTestId('login-email').fill('viewer@example.com')
  await page.getByTestId('login-password').fill('viewer-password')
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('kpi-expense')).toHaveAttribute('data-amount', '40', { timeout: 30_000 })
  await expect(page.getByTestId('nav-users')).toHaveCount(0)
  await page.getByTestId('nav-transactions').click()
  await expect(page.getByTestId('add-transaction')).toHaveCount(0)
  await expect(page.getByTestId('tx-row')).toContainText('40')
})

test('exports an encrypted backup and imports it into a fresh browser', async ({ page, browser }) => {
  await createVault(page)
  await addRecord(page, 'INCOME', '1000')
  await addRecord(page, 'EXPENSE', '200')
  await page.getByTestId('nav-backup').click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('export-backup').click()
  const download = await downloadPromise
  const file = await download.path()
  expect(file).toBeTruthy()

  const context = await browser.newContext()
  const fresh = await context.newPage()
  await fresh.goto('/')
  await fresh.getByTestId('import-file').setInputFiles(file!)
  await fresh.getByTestId('confirm-import').click()
  await fresh.getByTestId('login-email').fill('admin@example.com')
  await fresh.getByTestId('login-password').fill('correct-horse')
  await fresh.getByTestId('login-submit').click()
  await expect(fresh.getByTestId('kpi-net')).toHaveAttribute('data-amount', '800', { timeout: 30_000 })
  await context.close()
})
