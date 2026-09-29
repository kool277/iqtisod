import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const TARGET = process.env.E2E_TARGET === 'preview' ? 'preview' : 'dev'
const SCREENS = resolve(process.env.SCREENSHOT_DIR ?? `/tmp/jaybi-brand-screens/${TARGET}`)
const ADMIN = { email: 'admin@example.com', password: 'Correct horse lantern 7' }

async function simulateHost(page: Page, hostname: string) {
  await page.addInitScript((host) => {
    ;(window as unknown as { __jaybiHostname: string }).__jaybiHostname = host
  }, hostname)
}

async function watchViolations(page: Page): Promise<() => Promise<string[]>> {
  const lines: string[] = []
  page.on('console', (message) => lines.push(message.text()))
  page.on('pageerror', (error) => lines.push(error.message))
  await page.addInitScript(() => {
    const seen: string[] = []
    ;(window as unknown as { __violations: string[] }).__violations = seen
    document.addEventListener('securitypolicyviolation', (event) => seen.push(`${event.effectiveDirective} ${event.blockedURI}`))
  })
  return async () => [
    ...lines.filter((line) => /Content Security Policy|Trusted Type|Refused to/i.test(line)),
    ...(await page.evaluate(() => (window as unknown as { __violations?: string[] }).__violations ?? [])),
  ]
}

async function shot(page: Page, name: string) {
  mkdirSync(SCREENS, { recursive: true })
  await page.mouse.move(0, 0)
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    if (scheme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/)
    else await expect(page.locator('html')).not.toHaveClass(/dark/)
    await page.screenshot({ path: resolve(SCREENS, `${name}-${scheme}.png`), animations: 'disabled' })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

async function createVault(page: Page) {
  await page.getByTestId('setup-name').fill('Home')
  await page.getByTestId('setup-email').fill(ADMIN.email)
  await page.getByTestId('setup-password').fill(ADMIN.password)
  await page.getByTestId('setup-confirm').fill(ADMIN.password)
  await page.getByTestId('setup-submit').click()
  await expect(page.getByTestId('kpi-net')).toBeVisible({ timeout: 30_000 })
}

test('the old address asks people to back up and move to jaybi.uz', async ({ page }) => {
  const violations = await watchViolations(page)
  await simulateHost(page, 'kool277.github.io')
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')

  const notice = page.getByTestId('move-notice')
  await expect(notice).toHaveAttribute('data-kind', 'setup')
  await expect(notice).toContainText('Jaybi is moving to jaybi.uz.')
  await expect(page.getByTestId('move-import-hint')).toHaveCount(0)
  await shot(page, 'move-setup')

  await createVault(page)
  await expect(notice).toHaveAttribute('data-kind', 'backup')
  await expect(notice).toContainText('Download an encrypted backup now, then open jaybi.uz and import it.')
  await shot(page, 'move-app')

  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('move-download').click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^moliya-backup-\d{4}-\d{2}-\d{2}\.moliya$/)
  const file = JSON.parse(readFileSync(await download.path(), 'utf8')) as { format?: string }
  expect(file.format).toBe('moliya-vault')
  await expect(page.getByTestId('move-done')).toContainText('Backup downloaded.')
  await page.getByTestId('nav-backup').click()
  await expect(page.getByTestId('last-backup')).not.toHaveText('Never')

  await page.getByTestId('nav-dashboard').click()
  await page.getByTestId('move-backup-link').click()
  await expect(page).toHaveURL(/#\/app\/backup$/)
  await expect(page.getByTestId('export-backup')).toBeVisible()

  await page.getByTestId('move-dismiss').click()
  await expect(notice).toHaveCount(0)
  await page.getByTestId('nav-dashboard').click()
  await expect(page.getByTestId('kpi-net')).toBeVisible()
  await expect(notice).toHaveCount(0)

  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 30_000 })
  await page.reload()
  await expect(page.getByTestId('login-email')).toBeVisible({ timeout: 30_000 })
  await expect(notice).toHaveAttribute('data-kind', 'signIn')
  await expect(notice).toContainText('Sign in as an admin')
  await shot(page, 'move-sign-in')

  await page.getByTestId('move-dismiss').click()
  await expect(notice).toHaveCount(0)
  await page.getByTestId('login-email').fill(ADMIN.email)
  await page.getByTestId('login-password').fill(ADMIN.password)
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('kpi-net')).toBeVisible({ timeout: 30_000 })
  await expect(notice).toHaveAttribute('data-kind', 'backup')

  await page.getByTestId('language-select').selectOption('ru')
  await expect(notice).toContainText('Джайби переезжает на jaybi.uz.')
  await page.getByTestId('language-select').selectOption('uz-Latn')
  await expect(notice).toContainText('Jaybi jaybi.uz manziliga koʻchmoqda.')
  await page.getByTestId('language-select').selectOption('uz-Cyrl')
  await expect(notice).toContainText('Жайби jaybi.uz манзилига кўчмоқда.')
  await page.getByTestId('language-select').selectOption('en')

  expect(await violations()).toEqual([])
})

test('other addresses show no moving notice', async ({ page }) => {
  const violations = await watchViolations(page)
  await page.goto('/')
  await expect(page.getByTestId('setup-name')).toBeVisible()
  await expect(page.getByTestId('move-notice')).toHaveCount(0)
  await expect(page.getByTestId('move-import-hint')).toHaveCount(0)
  await createVault(page)
  await expect(page.getByTestId('move-notice')).toHaveCount(0)
  expect(await violations()).toEqual([])
})

test('jaybi.uz points people with an old vault to the import', async ({ page }) => {
  const violations = await watchViolations(page)
  await simulateHost(page, 'jaybi.uz')
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  const hint = page.getByTestId('move-import-hint')
  await expect(hint).toContainText('Coming from kool277.github.io/iqtisod? Import your backup here.')
  await expect(page.getByTestId('move-notice')).toHaveCount(0)
  await shot(page, 'move-import-hint')
  await hint.getByRole('button').click()
  await expect(page.getByTestId('import-file')).toBeFocused()
  expect(await violations()).toEqual([])
})
