import { expect, test, type Page } from '@playwright/test'
import { watchViolations } from '../support/csp'

const ADMIN = { email: 'admin@example.com', password: 'Correct horse lantern 7', vault: 'Lantern household' }
const VIEWER = { email: 'viewer@example.com', temporary: 'Temp birch window 101', password: 'Own willow harbor 11' }

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

async function healthDone(page: Page) {
  await expect(page.getByTestId('health-overall')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('health-page')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 })
}

const check = (page: Page, id: string) => page.locator(`[data-testid="health-check"][data-id="${id}"]`)

test('the health check runs before sign-in, for an admin and for a viewer, and its report holds no personal data', async ({ page, context }) => {
  const violations = await watchViolations(page)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])

  await page.goto('/')
  await page.getByTestId('health-entry').click()
  await expect(page).toHaveURL(/#\/health$/)
  await healthDone(page)
  await expect(page.getByTestId('health-page')).toHaveAttribute('data-mode', 'standalone')
  await expect(page.getByTestId('health-group')).toHaveCount(5)
  await expect(page.locator('[data-testid="health-group"][data-group="vault"]')).toHaveCount(0)
  await expect(check(page, 'crypto')).toHaveAttribute('data-status', 'pass')
  await expect(check(page, 'storedVault')).toHaveAttribute('data-detail', 'none')
  await expect(page.getByTestId('health-admin-badge')).toHaveCount(0)
  await expect(page.getByTestId('health-action').and(page.locator('a'))).toHaveCount(0)
  await page.getByRole('link', { name: 'Back to sign-in' }).click()

  await page.getByTestId('setup-name').fill(ADMIN.vault)
  await page.getByTestId('setup-email').fill(ADMIN.email)
  await page.getByTestId('setup-password').fill(ADMIN.password)
  await page.getByTestId('setup-confirm').fill(ADMIN.password)
  await page.getByTestId('setup-submit').click()
  await expect(page.getByTestId('kpi-net')).toBeVisible({ timeout: 30_000 })

  await page.getByTestId('nav-health').click()
  await healthDone(page)
  await expect(page.getByTestId('health-page')).toHaveAttribute('data-mode', 'app')
  await expect(page.getByTestId('health-group')).toHaveCount(6)
  await expect(check(page, 'storedVault')).toHaveAttribute('data-detail', 'present')
  await expect(check(page, 'auditChain')).toHaveAttribute('data-status', 'pass')
  await expect(check(page, 'auditChain')).toHaveAttribute('data-admin', 'true')
  await expect(check(page, 'members')).toHaveAttribute('data-admin', 'true')
  await expect(check(page, 'totp')).toHaveAttribute('data-status', 'warn')
  await expect(check(page, 'password')).toHaveAttribute('data-status', 'pass')
  await expect(page.getByTestId('health-admin-badge').first()).toBeVisible()
  const firstRun = await page.getByTestId('health-checked-at').textContent()

  await page.getByTestId('health-copy').click()
  await expect(page.getByTestId('health-copy-status')).toHaveAttribute('data-state', 'copied')
  const report = await page.evaluate(() => navigator.clipboard.readText())
  expect(report).toContain('[PASS] crypto.ok')
  expect(report).toContain('auditChain.ok')
  for (const secret of [ADMIN.email, ADMIN.password, ADMIN.vault, 'admin@']) expect(report).not.toContain(secret)
  await expect(page.getByTestId('health-report')).toHaveText(report)

  await page.getByTestId('health-run').click()
  await healthDone(page)
  await expect.poll(() => page.getByTestId('health-checked-at').textContent()).toBeTruthy()
  expect(firstRun).toBeTruthy()

  await check(page, 'totp').getByTestId('health-action').click()
  await expect(page).toHaveURL(/#\/app\/account$/)

  await page.getByTestId('nav-users').click()
  await page.getByTestId('advanced-temp-toggle').click()
  await page.getByTestId('user-email').fill(VIEWER.email)
  await page.getByTestId('user-password').fill(VIEWER.temporary)
  await page.getByTestId('user-role').selectOption('Viewer')
  await page.getByTestId('user-save').click()
  await expect(page.getByText(VIEWER.email)).toBeVisible({ timeout: 30_000 })
  await lock(page)

  await signIn(page, VIEWER.email, VIEWER.temporary)
  await expect(page.getByTestId('must-change-banner')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('nav-health')).toHaveCount(0)
  await expect(page.getByTestId('header-help')).toHaveCount(0)
  await page.getByTestId('account-current').fill(VIEWER.temporary)
  await page.getByTestId('account-new').fill(VIEWER.password)
  await page.getByTestId('account-confirm').fill(VIEWER.password)
  await page.getByTestId('account-save').click()
  await expect(page.getByTestId('must-change-banner')).toHaveCount(0, { timeout: 30_000 })

  await page.getByTestId('nav-health').click()
  await healthDone(page)
  await expect(page.getByTestId('health-admin-badge')).toHaveCount(0)
  await expect(page.locator('[data-testid="health-check"][data-admin="true"]')).toHaveCount(0)
  for (const id of ['auditChain', 'auditHead', 'archives', 'members']) await expect(check(page, id), id).toHaveCount(0)
  await expect(check(page, 'backup')).toHaveAttribute('data-detail', 'admin')
  await expect(page.getByTestId('health-action').filter({ has: page.locator('[href*="/app/backup"]') })).toHaveCount(0)
  await page.getByTestId('health-copy').click()
  const viewerReport = await page.evaluate(() => navigator.clipboard.readText())
  for (const secret of [VIEWER.email, ADMIN.email, ADMIN.vault]) expect(viewerReport).not.toContain(secret)
  expect(viewerReport).not.toContain('auditChain')

  expect(await violations()).toEqual([])
})

test('help searches the guide, opens screens and the section for the current page', async ({ page }) => {
  const violations = await watchViolations(page)

  await page.goto('/')
  await page.getByTestId('help-entry').click()
  await expect(page).toHaveURL(/#\/help$/)
  await expect(page.getByTestId('help-page')).toHaveAttribute('data-locale', 'en', { timeout: 30_000 })
  const sections = await page.getByTestId('help-section').count()
  expect(sections).toBeGreaterThan(15)
  await expect(page.getByTestId('help-toc-link')).toHaveCount(sections)

  await page.getByTestId('help-search').fill('recovery code')
  await expect(page.getByTestId('help-results')).not.toBeEmpty()
  const found = Number(await page.getByTestId('help-results').getAttribute('data-count'))
  expect(found).toBeGreaterThan(0)
  expect(found).toBeLessThan(sections)
  await expect(page.getByTestId('help-section')).toHaveCount(found)
  await page.getByTestId('help-search').fill('zzqqxx-nothing')
  await expect(page.getByTestId('help-section')).toHaveCount(0)
  await page.getByTestId('help-search').press('Escape')
  await expect(page.getByTestId('help-section')).toHaveCount(sections)

  const picture = page.getByTestId('help-image').first()
  await picture.scrollIntoViewIfNeeded()
  await expect.poll(() => picture.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth)).toBeGreaterThan(100)
  expect(await picture.getAttribute('src')).toMatch(/^help\/en\/[a-z0-9-]+\.webp$/)

  await page.goto('/')
  await page.getByTestId('setup-name').fill(ADMIN.vault)
  await page.getByTestId('setup-email').fill(ADMIN.email)
  await page.getByTestId('setup-password').fill(ADMIN.password)
  await page.getByTestId('setup-confirm').fill(ADMIN.password)
  await page.getByTestId('setup-submit').click()
  await expect(page.getByTestId('kpi-net')).toBeVisible({ timeout: 30_000 })

  await page.getByTestId('nav-safes').click()
  await expect(page.getByTestId('header-help')).toHaveAttribute('data-section', 'safes')
  await page.getByTestId('header-help').click()
  await expect(page).toHaveURL(/#\/app\/help\?section=safes$/)
  await expect(page.locator('#help-safes')).toBeFocused({ timeout: 30_000 })
  await expect(page.locator('#help-safes')).toBeInViewport()

  await page.getByTestId('nav-backup').click()
  await page.locator('main').getByTestId('help-link').click()
  await expect(page.locator('#help-backup')).toBeFocused({ timeout: 30_000 })
  await page.locator('[data-testid="help-section"][data-section="backup"]').getByTestId('help-open').first().click()
  await expect(page).toHaveURL(/#\/app\/backup$/)

  // Signed in, the pages for signed-out people lead into the app instead.
  await page.evaluate(() => { window.location.hash = '#/help' })
  await expect(page).toHaveURL(/#\/app\/help$/, { timeout: 30_000 })
  await expect(page.getByTestId('help-page')).toBeVisible()
  await page.evaluate(() => { window.location.hash = '#/health' })
  await expect(page).toHaveURL(/#\/app\/health$/, { timeout: 30_000 })

  expect(await violations()).toEqual([])
})

test('help follows the chosen language, pictures included', async ({ page }) => {
  const violations = await watchViolations(page)
  await page.goto('/#/help')
  await expect(page.getByTestId('help-page')).toHaveAttribute('data-locale', 'en', { timeout: 30_000 })
  for (const [locale, letters] of [['ru', /[А-Яа-яЁё]/], ['uz-Cyrl', /[А-Яа-яЎўҚқҒғҲҳ]/], ['uz-Latn', /[ʻ]/]] as const) {
    await page.getByTestId('language-select').selectOption(locale)
    await expect(page.getByTestId('help-page')).toHaveAttribute('data-locale', locale, { timeout: 30_000 })
    await expect(page.locator('[data-testid="help-section"]').first()).toContainText(letters)
    const picture = page.getByTestId('help-image').first()
    expect(await picture.getAttribute('src')).toMatch(new RegExp(`^help/${locale}/[a-z0-9-]+\\.webp$`))
    await picture.scrollIntoViewIfNeeded()
    await expect.poll(() => picture.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth)).toBeGreaterThan(100)
  }
  expect(await violations()).toEqual([])
})
