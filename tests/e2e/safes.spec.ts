import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const TARGET = process.env.E2E_TARGET === 'preview' ? 'preview' : 'dev'
const SCREENS = resolve(process.env.SCREENSHOT_DIR ?? `/tmp/moliya-safes-screens/${TARGET}`)

const CARD_NUMBER = '4111 1111 1111 1111'
const CVV = '737'
const NOTE_SECRET = 'router password: tulip-42'
const SECRETS = [CARD_NUMBER, CARD_NUMBER.replaceAll(' ', ''), 'tulip-42', 'Locker code 5591']

async function createVault(page: Page) {
  await page.goto('/')
  await page.getByTestId('setup-name').fill('Home')
  await page.getByTestId('setup-email').fill('admin@example.com')
  await page.getByTestId('setup-password').fill('Correct horse lantern 7')
  await page.getByTestId('setup-confirm').fill('Correct horse lantern 7')
  await page.getByTestId('setup-submit').click()
  await expect(page.getByTestId('kpi-net')).toBeVisible({ timeout: 30_000 })
}

async function loginAs(page: Page, email: string, password: string) {
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

async function createMember(page: Page, email: string, password: string, role: 'Manager' | 'Viewer') {
  await page.getByTestId('nav-users').click()
  await page.getByTestId('user-add').click()
  await page.getByTestId('advanced-temp-toggle').click()
  await page.getByTestId('user-email').fill(email)
  await page.getByTestId('user-password').fill(password)
  await page.getByTestId('user-role').selectOption(role)
  await page.getByTestId('user-save').click()
  await expect(page.getByText(email)).toBeVisible({ timeout: 30_000 })
}

async function changeOwnPassword(page: Page, current: string, next: string) {
  await expect(page.getByTestId('must-change-banner')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('account-current').fill(current)
  await page.getByTestId('account-new').fill(next)
  await page.getByTestId('account-confirm').fill(next)
  await page.getByTestId('account-save').click()
  await expect(page.getByTestId('must-change-banner')).toHaveCount(0, { timeout: 30_000 })
}

async function adminResets(page: Page, email: string, temporary: string) {
  await page.getByTestId('nav-users').click()
  const row = page.getByTestId('person-row').filter({ hasText: email })
  await row.getByTestId('user-issue-reset').click()
  await row.getByTestId('user-reset').click()
  await expect(row.getByTestId('reset-safes-warn')).toContainText('recovery code')
  await row.getByTestId('user-reset-password').fill(temporary)
  await row.getByTestId('user-reset-save').click()
  await expect(row.getByTestId('user-reset-password')).toHaveCount(0, { timeout: 30_000 })
}

async function setUpSafes(page: Page, password: string, recovery: boolean): Promise<string | null> {
  await page.getByTestId('nav-safes').click()
  await page.getByTestId('safes-setup-password').fill(password)
  let code: string | null = null
  if (recovery) {
    await page.getByTestId('recovery-yes').check()
    await page.getByTestId('safes-setup-submit').click()
    const shown = page.getByTestId('recovery-code')
    await expect(shown).toBeVisible({ timeout: 30_000 })
    code = (await shown.textContent())!.trim()
    await page.getByTestId('recovery-confirm').fill('XXXX')
    await page.getByTestId('recovery-done').click()
    await expect(page.getByTestId('form-error')).toBeVisible()
    await page.getByTestId('recovery-confirm').fill(code.replace(/[^0-9A-Z]/gi, '').slice(-4))
    await page.getByTestId('recovery-done').click()
  } else {
    await page.getByTestId('recovery-no').check()
    await expect(page.getByTestId('safes-setup-submit')).toBeDisabled()
    await page.getByTestId('recovery-skip-confirm').check()
    await page.getByTestId('safes-setup-submit').click()
  }
  await expect(page.getByTestId('safe-card')).toHaveCount(1, { timeout: 30_000 })
  return code
}

async function openFirstSafe(page: Page) {
  await page.getByTestId('safe-card').first().click()
  await expect(page.getByTestId('safe-title')).toBeVisible()
}

async function addNote(page: Page, title: string, body: string) {
  await page.getByTestId('add-note').click()
  await page.getByTestId('item-title').fill(title)
  await page.getByTestId('note-body').fill(body)
  await page.getByTestId('item-submit').click()
  await expect(page.getByTestId('note-body-value')).toHaveText(body)
}

async function expectNoSecretsInChrome(page: Page) {
  const exposed = await page.evaluate(() => {
    const values = [document.title, location.href]
    const labels = [document.title]
    for (const element of document.querySelectorAll('*')) {
      for (const attribute of element.attributes) {
        if (attribute.name.startsWith('aria-') || attribute.name === 'title') labels.push(attribute.value)
        if (attribute.name.startsWith('aria-') || attribute.name.startsWith('data-') || attribute.name === 'title' || attribute.name === 'href') {
          values.push(attribute.value)
        }
      }
    }
    return { values, labels }
  })
  for (const secret of SECRETS) {
    expect(exposed.values.filter((value) => value.includes(secret)), `"${secret}" leaks into URL, title or attributes`).toEqual([])
  }
  expect(exposed.labels.filter((value) => value.includes(CVV)), 'CVV leaks into a title or label').toEqual([])
}

async function setTabHidden(page: Page, hidden: boolean) {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (value ? 'hidden' : 'visible') })
    document.dispatchEvent(new Event('visibilitychange'))
  }, hidden)
}

async function screenshot(page: Page, name: string, target?: ReturnType<Page['getByTestId']>) {
  mkdirSync(SCREENS, { recursive: true })
  await page.mouse.move(0, 0)
  const path = resolve(SCREENS, `${name}.png`)
  if (target) await target.screenshot({ path, animations: 'disabled' })
  else await page.screenshot({ path, fullPage: true, animations: 'disabled' })
}

async function overflowing(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('main *')]
      .filter((node) => node.children.length === 0 && node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX === 'visible')
      .filter((node) => !['INPUT', 'SELECT', 'TEXTAREA', 'svg', 'path'].includes(node.tagName))
      .map((node) => `${node.tagName}.${node.className}: ${node.textContent?.slice(0, 40)}`),
  )
}

test('keeps cards, subscriptions and notes in a private safe with masked secrets, open until the vault locks', async ({ page, context }) => {
  const consoleText: string[] = []
  page.on('console', (message) => consoleText.push(message.text()))
  page.on('pageerror', (error) => consoleText.push(error.message))
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.clock.install()
  await page.setViewportSize({ width: 1440, height: 1000 })
  await createVault(page)

  await setUpSafes(page, 'Correct horse lantern 7', true)
  await expect(page.getByTestId('no-recovery-banner')).toHaveCount(0)
  await openFirstSafe(page)

  await page.getByTestId('add-card').click()
  await page.getByTestId('item-title').fill('Visa Classic')
  await page.getByTestId('card-number').fill(CARD_NUMBER)
  await expect(page.getByTestId('card-brand')).toHaveValue('VISA')
  await page.getByTestId('card-holder').fill('A. Karimova')
  await page.getByTestId('card-exp-month').selectOption('12')
  await page.getByTestId('card-exp-year').selectOption(String(new Date().getFullYear() + 3))
  await page.getByTestId('card-bank').fill('Kapitalbank')
  await expect(page.getByTestId('card-cvv')).toHaveCount(0)
  await page.getByTestId('card-add-cvv').click()
  await page.getByTestId('card-cvv').fill(CVV)
  await page.getByTestId('item-submit').click()

  const number = page.getByTestId('card-number-value')
  await expect(number).toHaveText('•••• •••• •••• 1111')
  await expect(page.getByTestId('card-cvv-value')).toHaveText('•••')
  await expect(page.getByTestId('item-detail')).not.toContainText(CARD_NUMBER)
  await expect(page.getByTestId('item-detail')).not.toContainText(CVV)
  await screenshot(page, 'card-detail-masked-light')

  await page.getByTestId('card-number-value-reveal').click()
  await expect(number).toHaveText(CARD_NUMBER)
  await expect(page.getByTestId('card-number-value-countdown')).toBeVisible()
  await page.clock.fastForward(16_000)
  await expect(number).toHaveText('•••• •••• •••• 1111')

  await page.getByTestId('card-number-value-copy').click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(CARD_NUMBER)
  await page.clock.fastForward(31_000)
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('')

  await page.getByTestId('add-subscription').click()
  await page.getByTestId('item-title').fill('Netflix')
  await page.getByTestId('sub-amount').fill('9.99')
  await page.getByTestId('sub-currency').selectOption('USD')
  await page.getByTestId('sub-cycle').selectOption('MONTHLY')
  await page.getByTestId('sub-card').selectOption({ label: 'Visa Classic' })
  await page.getByTestId('item-submit').click()
  await expect(page.getByTestId('item-detail')).toContainText('Visa Classic')
  await expect(page.getByTestId('sub-next')).toBeVisible()

  await addNote(page, 'Wi-Fi', NOTE_SECRET)
  await page.getByTestId('item-favorite').click()
  await expect(page.getByTestId('item-favorite')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('safe-item')).toHaveCount(3)
  await page.getByTestId('filter-card').click()
  await expect(page.getByTestId('safe-item')).toHaveCount(1)
  await page.getByTestId('filter-all').click()
  await expectNoSecretsInChrome(page)

  await page.getByTestId('safe-back').click()
  const summary = page.getByTestId('subscription-summary')
  await expect(summary).toContainText('$9.99')
  await expect(page.getByTestId('upcoming-payment')).toHaveCount(1)
  await expect(page.getByTestId('favorite-items').getByTestId('safe-item')).toHaveCount(1)
  expect(await overflowing(page)).toEqual([])
  await screenshot(page, 'safes-home-light')
  await screenshot(page, 'subscription-summary-light', summary.locator('xpath=..'))

  await page.getByTestId('safes-search').fill('kapital')
  await expect(page.getByTestId('safes-search-results').getByTestId('safe-item')).toHaveCount(1)
  await page.getByTestId('safes-search').fill('')

  await page.getByTestId('language-select').selectOption('uz-Cyrl')
  await expect(page.getByTestId('nav-safes')).toContainText('сейф', { ignoreCase: true })
  expect(await overflowing(page)).toEqual([])
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await overflowing(page)).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByTestId('language-select').selectOption('en')

  await page.getByTestId('theme-dark').click()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await screenshot(page, 'safes-home-dark')
  await screenshot(page, 'subscription-summary-dark', summary.locator('xpath=..'))
  await page.getByTestId('safe-card').first().click()
  await page.getByTestId('safe-item').filter({ hasText: 'Visa Classic' }).click()
  await expect(page.getByTestId('card-number-value')).toHaveText('•••• •••• •••• 1111')
  await screenshot(page, 'card-detail-masked-dark')
  await expectNoSecretsInChrome(page)
  await page.getByTestId('theme-light').click()

  await page.getByTestId('nav-account').click()
  await expect(page.getByTestId('recovery-status')).toHaveAttribute('data-state', 'set')
  await page.getByTestId('nav-safes').click()
  await expect(page.getByTestId('safe-grid')).toBeVisible()
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 30_000 })
  await page.clock.fastForward('05:05')
  await expect(page.getByTestId('safe-grid')).toBeVisible()
  await setTabHidden(page, true)
  await page.clock.fastForward('02:00')
  await setTabHidden(page, false)
  await expect(page.getByTestId('safe-grid')).toBeVisible()
  await expect(page.getByTestId('safes-unlock')).toHaveCount(0)
  await page.clock.fastForward('08:30')
  await expect(page.getByTestId('login-email')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('idle-locked')).toBeVisible()
  await loginAs(page, 'admin@example.com', 'Correct horse lantern 7')
  await page.getByTestId('nav-safes').click()
  await expect(page.getByTestId('safes-unlock')).toBeVisible()
  await page.getByTestId('safes-unlock-password').fill('wrong-password')
  await page.getByTestId('safes-unlock-submit').click()
  await expect(page.getByTestId('form-error')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('safes-unlock-password').fill('Correct horse lantern 7')
  await page.getByTestId('safes-unlock-submit').click()
  await expect(page.getByTestId('safes-last-unlock')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('upcoming-payment')).toHaveCount(1)

  await page.getByTestId('safes-activity-link').click()
  await expect(page.getByTestId('safe-event').first()).toBeVisible()

  await page.getByTestId('nav-users').click()
  await expect(page.getByTestId('user-use-account')).toBeVisible()
  await expect(page.getByTestId('user-reset')).toHaveCount(0)
  await expect(page.getByTestId('user-issue-reset')).toHaveCount(0)

  await page.getByTestId('nav-account').click()
  await expect(page.getByTestId('safes-stay-open')).toBeVisible()
  await page.getByTestId('nav-safes').click()
  await page.getByTestId('safes-lock').click()
  await expect(page.getByTestId('safes-unlock')).toBeVisible()
  await lockVault(page)
  await expect(page.getByTestId('idle-locked')).toHaveCount(0)

  const leaks = consoleText.filter((line) => [...SECRETS, `cvv ${CVV}`].some((secret) => line.includes(secret)))
  expect(leaks).toEqual([])
  expect(consoleText.filter((line) => /Content Security Policy|Refused to/i.test(line))).toEqual([])
})

test('a member without a recovery code gets their safes back with the previous password after an admin reset', async ({ page }) => {
  await createVault(page)
  await createMember(page, 'manager@example.com', 'Temp maple kettle 101', 'Manager')
  await lockVault(page)

  await loginAs(page, 'manager@example.com', 'Temp maple kettle 101')
  await changeOwnPassword(page, 'Temp maple kettle 101', 'Own orchard lantern 11')
  await setUpSafes(page, 'Own orchard lantern 11', false)
  await expect(page.getByTestId('no-recovery-banner')).toBeVisible()
  await openFirstSafe(page)
  await addNote(page, 'Gym', 'Locker code 5591')
  await page.getByTestId('nav-account').click()
  await expect(page.getByTestId('recovery-status')).toHaveAttribute('data-state', 'none')
  await lockVault(page)

  await loginAs(page, 'admin@example.com', 'Correct horse lantern 7')
  await adminResets(page, 'manager@example.com', 'Temp maple kettle 202')
  await lockVault(page)

  await loginAs(page, 'manager@example.com', 'Temp maple kettle 202')
  await changeOwnPassword(page, 'Temp maple kettle 202', 'Own orchard lantern 22')
  await page.getByTestId('nav-safes').click()
  await expect(page.getByTestId('safes-stale')).toBeVisible()
  await expect(page.getByTestId('stale-no-recovery')).toBeVisible()
  await expect(page.getByTestId('stale-switch')).toHaveCount(0)
  await page.getByTestId('stale-previous').fill('Temp maple kettle 202')
  await page.getByTestId('stale-current').fill('Own orchard lantern 22')
  await page.getByTestId('stale-submit').click()
  await expect(page.getByTestId('form-error')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('stale-previous').fill('Own orchard lantern 11')
  await page.getByTestId('stale-submit').click()
  await expect(page.getByTestId('form-success')).toBeVisible({ timeout: 30_000 })
  await openFirstSafe(page)
  await page.getByTestId('safe-item').filter({ hasText: 'Gym' }).click()
  await expect(page.getByTestId('note-body-value')).toHaveText('Locker code 5591')
})

test('a member with a recovery code gets their safes back with it after an admin reset', async ({ page }) => {
  await createVault(page)
  await createMember(page, 'viewer@example.com', 'Temp birch window 101', 'Viewer')
  await lockVault(page)

  await loginAs(page, 'viewer@example.com', 'Temp birch window 101')
  await changeOwnPassword(page, 'Temp birch window 101', 'Own willow harbor 11')
  const code = await setUpSafes(page, 'Own willow harbor 11', true)
  expect(code).toBeTruthy()
  await openFirstSafe(page)
  await addNote(page, 'Passport', 'AA 1234567')
  await lockVault(page)

  await loginAs(page, 'admin@example.com', 'Correct horse lantern 7')
  await adminResets(page, 'viewer@example.com', 'Temp birch window 202')
  await lockVault(page)

  await loginAs(page, 'viewer@example.com', 'Temp birch window 202')
  await changeOwnPassword(page, 'Temp birch window 202', 'Own willow harbor 22')
  await page.getByTestId('nav-safes').click()
  await expect(page.getByTestId('safes-stale')).toBeVisible()
  await page.getByTestId('stale-switch').click()
  await page.getByTestId('stale-recovery-code').fill(code!.toLowerCase())
  await page.getByTestId('stale-current').fill('Own willow harbor 22')
  await page.getByTestId('stale-submit').click()
  await expect(page.getByTestId('form-success')).toBeVisible({ timeout: 30_000 })
  await openFirstSafe(page)
  await page.getByTestId('safe-item').filter({ hasText: 'Passport' }).click()
  await expect(page.getByTestId('note-body-value')).toHaveText('AA 1234567')
})
