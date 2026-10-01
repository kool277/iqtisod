import { expect, test, type Page } from '@playwright/test'
import { watchViolations } from '../support/csp'

const TARGET = process.env.E2E_TARGET === 'preview' ? 'preview' : 'dev'

const ADMIN = { email: 'admin@example.com', password: 'Correct horse lantern 7' }
const MEMBER = { email: 'viewer@example.com', temporary: 'Temp birch window 101', password: 'Own willow harbor 11' }

const APP_ROUTES = [
  '/app',
  '/app/transactions',
  '/app/transactions?group=1',
  '/app/users',
  '/app/groups',
  '/app/audit',
  '/app/backup',
  '/app/settings',
  '/app/safes',
  '/app/safes/trash',
  '/app/safes/activity',
  '/app/safes/no-such-safe',
  '/app/account',
  '/app/health',
  '/app/help',
  '/app/help?section=backup',
]

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function endsWithHash(route: string): RegExp {
  return new RegExp(`/#${escaped(route)}$`)
}

/** Console errors other than the missing exchange-rate snapshot, which dev and preview do not serve. */
function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    if (/Failed to load resource/.test(message.text()) && /\/rates\/|\/app\/|\/register|\/iqtisod|\/nope/.test(message.location().url)) return
    errors.push(message.text())
  })
  return errors
}

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

async function lockVault(page: Page) {
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 30_000 })
  await page.getByTestId('lock-vault').click()
  await expect(page.getByTestId('login-email')).toBeVisible({ timeout: 30_000 })
}

async function openHash(page: Page, route: string) {
  await page.evaluate((hash) => {
    window.location.hash = hash
  }, `#${route}`)
}

async function expectPage(page: Page, route: string) {
  await expect(page).toHaveURL(endsWithHash(route))
  const main = page.locator('main#content')
  await expect(main.locator('h1, h2, [data-testid="forbidden"]').first()).toBeVisible({ timeout: 30_000 })
  await expect(main.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 30_000 })
  await expect(page.getByTestId('not-found'), route).toHaveCount(0)
  await expect(page).toHaveURL(endsWithHash(route))
}

async function visitEveryRoute(page: Page) {
  for (const route of APP_ROUTES) {
    await openHash(page, route)
    await expectPage(page, route)
  }
}

test('path-style addresses reach their page through the 404 page, then sign-in returns there', async ({ page }) => {
  const violations = await watchViolations(page)
  await createVault(page)

  const cases: [string, string][] = [
    ['/app/transactions?group=1', '/app/transactions?group=1'],
    ['/app/groups/', '/app/groups'],
    ['/iqtisod/app/audit', '/app/audit'],
    ['/iqtisod/#/app/backup', '/app/backup'],
    ['/app/safes/trash', '/app/safes/trash'],
  ]
  for (const [address, route] of cases) {
    const response = await page.goto(address)
    expect(response?.status(), address).toBe(404)
    await expect(page).toHaveURL(endsWithHash(`/login?next=${encodeURIComponent(route)}`), { timeout: 30_000 })
    await signIn(page, ADMIN.email, ADMIN.password)
    await expectPage(page, route)
  }

  await page.goto('/app')
  await expect(page).toHaveURL(endsWithHash('/login'), { timeout: 30_000 })

  await page.goto('/register?kind=reset')
  await expect(page).toHaveURL(endsWithHash('/register?kind=reset'), { timeout: 30_000 })
  await expect(page.getByTestId('register-email')).toBeVisible({ timeout: 30_000 })

  await page.goto('/nope/deeper')
  await expect(page).toHaveURL(endsWithHash('/nope/deeper'), { timeout: 30_000 })
  await expect(page.getByTestId('not-found')).toBeVisible()

  expect(await violations()).toEqual([])
})

test('the 404 page never leaves the site and leaves missing files alone', async ({ page, baseURL }) => {
  const violations = await watchViolations(page)
  const origin = new URL(baseURL!).origin

  for (const address of ['//evil.com', '/%2F%2Fevil.com', '/%5Cevil.com', '/javascript:alert(1)', `/app/${'a'.repeat(600)}`, '/app/%2e%2e/%2e%2e/setup']) {
    await page.goto(`${origin}${address}`)
    await expect(page.getByTestId('setup-email')).toBeVisible({ timeout: 30_000 })
    const url = new URL(page.url())
    expect(url.origin, address).toBe(origin)
    expect(url.pathname, address).toBe('/')
    expect(url.hash, address).toBe('#/setup')
  }

  for (const address of ['/assets/index-gone.js', '/rates/1999-01-01.json']) {
    const response = await page.goto(address)
    expect(response?.status(), address).toBe(404)
    await page.waitForLoadState('load')
    expect(new URL(page.url()).pathname, address).toBe(address)
    await expect(page.getByRole('link', { name: 'Open Jaybi' })).toBeVisible()
  }

  // version.json is written by the build, so only the preview has it.
  for (const file of [...(TARGET === 'preview' ? ['/version.json'] : []), '/coi-serviceworker.js', '/coi-config.js']) {
    const response = await page.request.get(file)
    expect(response.status(), file).toBe(200)
  }

  expect(await violations()).toEqual([])
})

test('every route renders for an admin and for a member, and unknown routes say so', async ({ page }) => {
  const violations = await watchViolations(page)
  const errors = watchErrors(page)
  await createVault(page)

  await page.getByTestId('nav-users').click()
  await page.getByTestId('advanced-temp-toggle').click()
  await page.getByTestId('user-email').fill(MEMBER.email)
  await page.getByTestId('user-password').fill(MEMBER.temporary)
  await page.getByTestId('user-role').selectOption('Viewer')
  await page.getByTestId('user-save').click()
  await expect(page.getByText(MEMBER.email)).toBeVisible({ timeout: 30_000 })

  await visitEveryRoute(page)

  await openHash(page, '/app/no-such-page')
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect(page.getByTestId('not-found')).toBeVisible()
  await page.getByTestId('not-found-home').click()
  await expect(page).toHaveURL(endsWithHash('/app'))
  await expect(page.getByTestId('kpi-net')).toBeVisible()

  await openHash(page, '/no-such-page')
  await expect(page.getByTestId('not-found')).toBeVisible()
  await expect(page.getByTestId('app-shell')).toHaveCount(0)
  await page.getByTestId('not-found-home').click()
  await expect(page.getByTestId('kpi-net')).toBeVisible()

  await page.getByTestId('language-select').selectOption('ru')
  await openHash(page, '/app/no-such-page')
  await expect(page.getByTestId('not-found')).toContainText('Страница не найдена')
  await page.getByTestId('language-select').selectOption('en')

  await openHash(page, '/app/transactions')
  await page.getByTestId('skip-link').focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('main#content')).toBeFocused()
  await expect(page).toHaveURL(endsWithHash('/app/transactions'))

  // Lock ends the visit: the next person to sign in starts on their dashboard, not on this page.
  await openHash(page, '/app/groups')
  await expectPage(page, '/app/groups')
  await lockVault(page)
  await expect(page).toHaveURL(endsWithHash('/login'))

  await page.getByTestId('login-email').fill(MEMBER.email)
  await page.getByTestId('login-password').fill(MEMBER.temporary)
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('must-change-banner')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('account-current').fill(MEMBER.temporary)
  await page.getByTestId('account-new').fill(MEMBER.password)
  await page.getByTestId('account-confirm').fill(MEMBER.password)
  await page.getByTestId('account-save').click()
  await expect(page.getByTestId('must-change-banner')).toHaveCount(0, { timeout: 30_000 })

  await visitEveryRoute(page)
  for (const route of ['/app/users', '/app/audit', '/app/backup', '/app/settings']) {
    await openHash(page, route)
    await expect(page.getByTestId('forbidden'), route).toBeVisible()
  }
  await openHash(page, '/app/no-such-page')
  await expect(page.getByTestId('not-found')).toBeVisible()
  await page.getByTestId('not-found-home').click()
  await expect(page.getByTestId('kpi-net')).toBeVisible()

  expect(errors).toEqual([])
  expect(await violations()).toEqual([])
})

test('after an idle lock, signing in reopens the page that was open', async ({ page }) => {
  const violations = await watchViolations(page)
  await page.clock.install()
  await createVault(page)
  await page.getByTestId('nav-account').click()
  await page.getByTestId('idle-minutes').selectOption('5')
  await openHash(page, '/app/transactions?group=1')
  await expectPage(page, '/app/transactions?group=1')
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 30_000 })
  await page.clock.fastForward('05:30')
  await expect(page.getByTestId('idle-locked')).toBeVisible({ timeout: 30_000 })
  await expect(page).toHaveURL(endsWithHash(`/login?next=${encodeURIComponent('/app/transactions?group=1')}`))
  await signIn(page, ADMIN.email, ADMIN.password)
  await expectPage(page, '/app/transactions?group=1')

  await openHash(page, `/login?next=${encodeURIComponent('//evil.com')}`)
  await expect(page).toHaveURL(endsWithHash('/app'))
  await expect(page.getByTestId('kpi-net')).toBeVisible()
  expect(await violations()).toEqual([])
})
