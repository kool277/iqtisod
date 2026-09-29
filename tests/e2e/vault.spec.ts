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

async function expectHeaderHeight(page: Page) {
  const header = page.getByTestId('app-shell').locator('header')
  await expect(header).toBeVisible()
  const box = await header.boundingBox()
  expect(box?.height).toBe(40)
  const overflow = await header.evaluate((node) => node.scrollWidth - node.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  const edges = await header.evaluate((node) => ({
    right: node.getBoundingClientRect().right,
    viewport: document.documentElement.clientWidth,
    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }))
  expect(edges.right, 'header spans to the right edge of the viewport').toBe(edges.viewport)
  expect(edges.pageOverflow).toBeLessThanOrEqual(0)
}

async function expectCollapsedSidebarCentered(page: Page) {
  const sidebar = page.locator('#app-sidebar')
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(65)
  const geometry = await sidebar.evaluate((nav) => {
    const rect = nav.getBoundingClientRect()
    const left = rect.left + nav.clientLeft
    const center = left + nav.clientWidth / 2
    const items = [...nav.querySelectorAll<HTMLElement>('[data-testid="brand-home"], [data-testid^="nav-"]')].map((item) => {
      const box = item.getBoundingClientRect()
      const icon = item.querySelector('svg')?.getBoundingClientRect() ?? box
      return {
        id: item.dataset.testid,
        offset: (icon.left + icon.right) / 2 - center,
        gapDelta: box.left - left - (left + nav.clientWidth - box.right),
      }
    })
    return { navLeft: rect.left, items }
  })
  expect(geometry.navLeft).toBe(0)
  expect(geometry.items.length).toBeGreaterThan(1)
  for (const item of geometry.items) {
    expect(Math.abs(item.offset), `${item.id} icon is centered`).toBeLessThanOrEqual(1)
    expect(Math.abs(item.gapDelta), `${item.id} has equal side gaps`).toBeLessThanOrEqual(1)
  }
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

test('admin changes vault settings, adds a category, and collapses the sidebar', async ({ page }) => {
  await createVault(page)
  await page.getByTestId('nav-settings').click()
  await page.getByTestId('settings-name').fill('Family budget')
  await page.getByTestId('settings-currency').selectOption('UZS')
  await page.getByTestId('settings-save').click()
  await expect(page.getByTestId('app-shell').locator('header')).toContainText('Family budget')
  await expectHeaderHeight(page)

  await page.getByTestId('category-type').selectOption('EXPENSE')
  await page.getByTestId('category-en').fill('Pets')
  await page.getByTestId('category-save').click()
  await expect(page.getByTestId('category-row').filter({ hasText: 'Pets' })).toBeVisible()

  await page.getByTestId('nav-transactions').click()
  await page.getByTestId('add-transaction').click()
  await page.getByTestId('tx-type').selectOption('EXPENSE')
  await expect(page.getByTestId('tx-category').locator('option', { hasText: 'Pets' })).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expectHeaderHeight(page)

  const shell = page.getByTestId('app-shell')
  await page.getByTestId('sidebar-toggle').click()
  await expect(shell).toHaveAttribute('data-sidebar', 'collapsed')
  await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-expanded', 'false')
  await expectHeaderHeight(page)
  await expectCollapsedSidebarCentered(page)
  await page.setViewportSize({ width: 1600, height: 900 })
  await expectCollapsedSidebarCentered(page)
  await page.setViewportSize({ width: 1920, height: 1080 })
  await expectHeaderHeight(page)
  await expect.poll(async () => (await shell.locator('header').boundingBox())?.x).toBe(65)
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 30_000 })
  await page.reload()
  await expect(page.getByTestId('login-email')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('login-email').fill('admin@example.com')
  await page.getByTestId('login-password').fill('correct-horse')
  await page.getByTestId('login-submit').click()
  await expect(shell).toHaveAttribute('data-sidebar', 'collapsed', { timeout: 30_000 })
  await expect(shell.locator('header')).toContainText('Family budget')
  await page.getByTestId('sidebar-toggle').click()
  await expect(shell).toHaveAttribute('data-sidebar', 'expanded')
  await expect.poll(async () => (await shell.locator('header').boundingBox())?.x).toBe(240)
  await expectHeaderHeight(page)

  await page.setViewportSize({ width: 390, height: 844 })
  await expectHeaderHeight(page)
  await page.getByTestId('nav-audit').click()
  await expectHeaderHeight(page)
  await page.getByTestId('language-select').selectOption('uz-Cyrl')
  await expectHeaderHeight(page)
  await page.getByTestId('sidebar-toggle').click()
  await expect(shell).toHaveAttribute('data-sidebar', 'collapsed')
  await expectHeaderHeight(page)
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
