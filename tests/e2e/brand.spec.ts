import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'

const TARGET = process.env.E2E_TARGET === 'preview' ? 'preview' : 'dev'
const SCREENS = resolve(process.env.SCREENSHOT_DIR ?? `/tmp/jaybi-brand-screens/${TARGET}`)
const ADMIN = { email: 'admin@example.com', password: 'Correct horse lantern 7' }
const MARK = 'جيبي'

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

async function screenshot(page: Page, name: string, target?: Locator) {
  mkdirSync(SCREENS, { recursive: true })
  await page.mouse.move(0, 0)
  const path = resolve(SCREENS, `${name}.png`)
  if (target) await target.screenshot({ path, animations: 'disabled' })
  else await page.screenshot({ path, animations: 'disabled' })
}

async function inBothThemes(page: Page, name: string, target?: Locator) {
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  await screenshot(page, `${name}-light`, target)
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveClass(/dark/)
  await screenshot(page, `${name}-dark`, target)
  await page.emulateMedia({ colorScheme: 'light' })
}

async function expectMark(mark: Locator) {
  await expect(mark).toHaveText(MARK)
  await expect(mark).toHaveAttribute('dir', 'rtl')
  await expect(mark).toHaveAttribute('lang', 'ar')
  const box = await mark.boundingBox()
  expect(box?.width ?? 0, 'the mark has rendered glyphs').toBeGreaterThan(8)
}

test('shows the Jaybi name and the Arabic mark on sign-in screens and in the sidebar', async ({ page }) => {
  const violations = await watchViolations(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await expect(page.getByTestId('setup-name')).toBeVisible()
  await expect(page).toHaveTitle('Jaybi')
  const lockup = page.getByTestId('brand-lockup').first()
  await expect(lockup).toContainText('Jaybi')
  await expectMark(lockup.getByTestId('brand-mark'))
  await inBothThemes(page, 'setup')

  await page.getByTestId('setup-name').fill('Home')
  await page.getByTestId('setup-email').fill(ADMIN.email)
  await page.getByTestId('setup-password').fill(ADMIN.password)
  await page.getByTestId('setup-confirm').fill(ADMIN.password)
  await page.getByTestId('setup-submit').click()
  await expect(page.getByTestId('kpi-net')).toBeVisible({ timeout: 30_000 })

  const brand = page.getByTestId('brand-home')
  await expect(brand).toHaveAttribute('href', '#/app')
  await expect(brand).toHaveAttribute('aria-label', 'Jaybi: Dashboard')
  await expect(brand).toContainText('Jaybi')
  await expectMark(brand.getByTestId('brand-mark'))
  const sidebar = page.locator('#app-sidebar')
  await inBothThemes(page, 'sidebar-expanded', sidebar)
  await inBothThemes(page, 'app-expanded')

  await page.getByTestId('sidebar-toggle').click()
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-sidebar', 'collapsed')
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(65)
  await expect(brand).not.toContainText('Jaybi')
  const mark = brand.getByTestId('brand-mark')
  await expectMark(mark)
  const [linkBox, markBox] = await Promise.all([brand.boundingBox(), mark.boundingBox()])
  expect(linkBox?.width).toBe(40)
  expect(linkBox?.height).toBe(40)
  expect(markBox!.x).toBeGreaterThanOrEqual(linkBox!.x)
  expect(markBox!.x + markBox!.width).toBeLessThanOrEqual(linkBox!.x + linkBox!.width)
  expect(markBox!.height).toBeLessThanOrEqual(40)
  await inBothThemes(page, 'sidebar-collapsed', sidebar)
  await page.getByTestId('sidebar-toggle').click()

  await page.getByTestId('language-select').selectOption('ru')
  await expect(page).toHaveTitle('Джайби')
  await expect(brand).toHaveAttribute('aria-label', /^Джайби: /)
  await page.getByTestId('language-select').selectOption('uz-Cyrl')
  await expect(page).toHaveTitle('Жайби')
  await page.getByTestId('language-select').selectOption('en')

  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 30_000 })
  await page.getByTestId('lock-vault').click()
  await expect(page.getByTestId('login-email')).toBeVisible({ timeout: 30_000 })
  await expectMark(page.getByTestId('brand-lockup').first().getByTestId('brand-mark'))
  await inBothThemes(page, 'sign-in')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByTestId('brand-lockup').last()).toBeVisible()
  await inBothThemes(page, 'sign-in-mobile')

  expect(await violations()).toEqual([])
})
