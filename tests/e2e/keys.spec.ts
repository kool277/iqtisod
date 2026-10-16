import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { watchViolations } from '../support/csp'

/**
 * Per-person keys (2.0 alpha). Setup creates such vaults and admins are offered the upgrade only in a build made with
 * VITE_V2_KEYS=1, so this file runs only against one: `VITE_V2_KEYS=1 E2E_TARGET=preview npx playwright test keys`.
 */
test.skip(process.env.VITE_V2_KEYS !== '1', 'needs a build with VITE_V2_KEYS=1')

const here = dirname(fileURLToPath(import.meta.url))
const V4 = resolve(here, '../fixtures/backups/v4/access-household.moliya')

const FOUNDER = { email: 'founder@keys.test', password: 'Founder keys lantern 7' }
const MEMBER = { email: 'member@keys.test', password: 'Member keys lantern 7' }

async function createVault(page: Page): Promise<string> {
  await page.goto('/')
  await page.getByTestId('setup-name').fill('Keys Home')
  await page.getByTestId('setup-email').fill(FOUNDER.email)
  await page.getByTestId('setup-password').fill(FOUNDER.password)
  await page.getByTestId('setup-confirm').fill(FOUNDER.password)
  await page.getByTestId('setup-submit').click()
  // The founder is shown the key to write down once the vault exists.
  await expect(page.getByTestId('fingerprint-notice')).toBeVisible({ timeout: 60_000 })
  const fingerprint = (await page.getByTestId('notice-fingerprint').textContent())!.trim()
  expect(fingerprint).toMatch(/^[0-9A-F]{4}( [0-9A-F]{4}){5}$/)
  await page.getByTestId('fingerprint-done').click()
  await expect(page.getByTestId('kpi-net')).toBeVisible({ timeout: 30_000 })
  return fingerprint
}

async function signIn(page: Page, email: string, password: string) {
  await page.getByTestId('login-email').fill(email)
  await page.getByTestId('login-password').fill(password)
  await page.getByTestId('login-submit').click()
}

async function lock(page: Page) {
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 60_000 })
  await page.getByTestId('lock-vault').click()
  await expect(page.getByTestId('login-email')).toBeVisible({ timeout: 30_000 })
}

async function issueInvite(page: Page, email: string): Promise<string> {
  await page.getByTestId('nav-users').click()
  await page.getByTestId('user-add').click()
  // A vault with per-person keys has no temporary passwords.
  await expect(page.getByTestId('advanced-temp-toggle')).toHaveCount(0)
  await page.getByTestId('invite-email').fill(email)
  await page.getByTestId('invite-role').selectOption('Manager')
  await page.getByTestId('invite-create').click()
  const code = (await page.getByTestId('issued-code').textContent({ timeout: 60_000 }))!.trim()
  await page.getByTestId('code-done').click()
  return code
}

test('a vault with per-person keys: setup, an invite, and a first sign-in elsewhere that compares the founder key', async ({ page, browser }) => {
  test.setTimeout(240_000)
  const violations = await watchViolations(page)
  const fingerprint = await createVault(page)
  await page.getByTestId('nav-account').click()
  await expect(page.getByTestId('account-fingerprint')).toHaveText(fingerprint)

  const code = await issueInvite(page, MEMBER.email)
  await lock(page)
  await page.getByTestId('join-link').click()
  await page.getByTestId('register-email').fill(MEMBER.email)
  await page.getByTestId('register-code').fill(code)
  await page.getByTestId('register-password').fill(MEMBER.password)
  await page.getByTestId('register-confirm').fill(MEMBER.password)
  await page.getByTestId('register-submit').click()
  await expect(page.getByTestId('kpi-net')).toBeVisible({ timeout: 60_000 })
  await lock(page)

  // The founder's next save signs the new member into the roster.
  await signIn(page, FOUNDER.email, FOUNDER.password)
  await expect(page.getByTestId('kpi-net')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('nav-backup').click()
  const download = page.waitForEvent('download')
  await page.getByTestId('export-backup').click()
  const file = await (await download).path()
  expect(file).toBeTruthy()

  // Another browser has never seen this vault: the member compares the founder key before it opens.
  const context = await browser.newContext()
  const fresh = await context.newPage()
  const freshViolations = await watchViolations(fresh)
  await fresh.goto('/')
  await fresh.getByTestId('import-file').setInputFiles(file!)
  await fresh.getByTestId('confirm-import').click()
  await signIn(fresh, MEMBER.email, MEMBER.password)
  await expect(fresh.getByTestId('trust-step')).toBeVisible({ timeout: 60_000 })
  await expect(fresh.getByTestId('trust-fingerprint')).toHaveText(fingerprint)
  await fresh.getByTestId('trust-cancel').click()
  await expect(fresh.getByTestId('login-email')).toBeVisible()
  await signIn(fresh, MEMBER.email, MEMBER.password)
  await fresh.getByTestId('trust-confirm').click()
  await expect(fresh.getByTestId('kpi-net')).toBeVisible({ timeout: 60_000 })
  await lock(fresh)
  // Pinned now: the next sign-in goes straight in.
  await signIn(fresh, MEMBER.email, MEMBER.password)
  await expect(fresh.getByTestId('kpi-net')).toBeVisible({ timeout: 60_000 })
  await expect(fresh.getByTestId('trust-step')).toHaveCount(0)
  expect(await freshViolations()).toEqual([])
  await context.close()
  expect(await violations()).toEqual([])
})

test('an admin upgrades a 1.x vault: they become the founder and everyone else needs a new invite', async ({ page }) => {
  test.setTimeout(240_000)
  const violations = await watchViolations(page)
  await page.goto('/')
  await page.getByTestId('import-file').setInputFiles(V4)
  await page.getByTestId('confirm-import').click()
  await signIn(page, 'admin@access.test', 'Plum orchard admin v4')
  await expect(page.getByTestId('upgrade-offer')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('upgrade-reinvites')).toContainText('2')
  await page.getByTestId('upgrade-password').fill('Plum orchard admin v4')
  await page.getByTestId('upgrade-confirm').click()
  await expect(page.getByTestId('fingerprint-notice')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('fingerprint-done').click()

  await page.getByTestId('nav-users').click()
  await page.getByRole('link', { name: 'Open: viewer@access.test' }).click()
  await expect(page.getByTestId('user-detail-access')).toHaveText('Needs a new invite', { timeout: 30_000 })
  await expect(page.getByTestId('user-no-access-note')).toBeVisible()
  await lock(page)
  // A member's 1.x password no longer opens the upgraded vault.
  await signIn(page, 'viewer@access.test', 'Viewer after reset code v4')
  await expect(page.getByText('Email or password is incorrect.')).toBeVisible({ timeout: 60_000 })
  await signIn(page, 'admin@access.test', 'Plum orchard admin v4')
  await expect(page.getByTestId('kpi-net')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('upgrade-offer')).toHaveCount(0)
  expect(await violations()).toEqual([])
})

test('a browser without X25519 or Ed25519 is refused at setup, with no weaker fallback', async ({ page }) => {
  await page.addInitScript(() => {
    const subtle = window.crypto.subtle
    const generateKey = subtle.generateKey.bind(subtle)
    Object.defineProperty(subtle, 'generateKey', {
      value: (algorithm: AlgorithmIdentifier, extractable: boolean, usages: KeyUsage[]) => {
        const name = typeof algorithm === 'string' ? algorithm : algorithm.name
        if (name === 'X25519' || name === 'Ed25519') return Promise.reject(new DOMException('Unsupported', 'NotSupportedError'))
        return generateKey(algorithm as AesKeyGenParams, extractable, usages)
      },
    })
  })
  await page.goto('/')
  await page.getByTestId('setup-name').fill('Old Browser')
  await page.getByTestId('setup-email').fill(FOUNDER.email)
  await page.getByTestId('setup-password').fill(FOUNDER.password)
  await page.getByTestId('setup-confirm').fill(FOUNDER.password)
  await page.getByTestId('setup-submit').click()
  await expect(page.getByText('This browser cannot use the keys this vault needs')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('kpi-net')).toHaveCount(0)
})
