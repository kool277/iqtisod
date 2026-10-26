import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { watchViolations } from '../support/csp'

/**
 * Per-person keys (2.0). A build made with VITE_V2_KEYS=0 creates 1.x vaults and offers no upgrade, so this file
 * skips itself against one.
 */
test.skip(process.env.VITE_V2_KEYS === '0', 'needs a build that creates vaults with per-person keys')

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

test('a blocked sign-in still lets the person download the vault, as stored and without open codes', async ({ page }) => {
  test.setTimeout(240_000)
  const violations = await watchViolations(page)
  await createVault(page)
  // An open code: its wrap is in the stored record, and must not be in the downloaded copy.
  await issueInvite(page, MEMBER.email)
  await lock(page)
  // This browser now expects another founder: the vault looks like a different household.
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) if (key.startsWith('moliya.v2.founder.')) localStorage.setItem(key, btoa(String.fromCharCode(...new Uint8Array(32).fill(9))))
  })
  await signIn(page, FOUNDER.email, FOUNDER.password)
  await expect(page.getByText('This vault’s founder key is not the one this browser saw before')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('kpi-net')).toHaveCount(0)
  const download = page.waitForEvent('download')
  await page.getByTestId('blocked-download').click()
  const saved = await download
  expect(saved.suggestedFilename()).toMatch(/^moliya-backup-\d{4}-\d{2}-\d{2}\.moliya$/)
  const file = JSON.parse(await readFile((await saved.path())!, 'utf8')) as Record<string, unknown>
  expect(file).toMatchObject({ format: 'moliya-vault', version: 3 })
  expect(file).not.toHaveProperty('grants')
  expect(Object.keys(file.identities as object)).toHaveLength(1)
  await expect(page.getByTestId('blocked-downloaded')).toBeVisible()
  // A different error clears the offer: a wrong password proves nothing about the vault.
  await signIn(page, FOUNDER.email, 'not the password at all 7')
  await expect(page.getByText('Email or password is incorrect.')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('blocked-escape')).toHaveCount(0)
  expect(await violations()).toEqual([])
})

test('suspending a member makes a new household key for everyone who stays, and they cannot sign in', async ({ page }) => {
  test.setTimeout(240_000)
  const violations = await watchViolations(page)
  await createVault(page)
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

  await signIn(page, FOUNDER.email, FOUNDER.password)
  await expect(page.getByTestId('kpi-net')).toBeVisible({ timeout: 60_000 })
  // An open invite for someone else, which the new key stops.
  await issueInvite(page, 'pending@keys.test')
  await page.getByRole('link', { name: `Open: ${MEMBER.email}` }).click()
  await page.getByTestId('user-action-suspend').click()
  await expect(page.getByTestId('removal-new-key')).toContainText('Everyone who stays gets a new household key')
  await expect(page.getByTestId('removal-codes')).toContainText('1')
  await page.getByTestId('user-suspend-dialog-confirm').click()
  await expect(page.getByTestId('user-detail')).toHaveAttribute('data-status', 'SUSPENDED')
  await lock(page)

  await signIn(page, MEMBER.email, MEMBER.password)
  await expect(page.getByText('Email or password is incorrect.')).toBeVisible({ timeout: 60_000 })
  // A failed attempt first: the sign-in after it writes an entry that only its save signs, which is no problem.
  await signIn(page, FOUNDER.email, `${FOUNDER.password} wrong`)
  await expect(page.getByText('Email or password is incorrect.')).toBeVisible({ timeout: 60_000 })
  await signIn(page, FOUNDER.email, FOUNDER.password)
  await expect(page.getByTestId('kpi-net')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('failures-seen-banner')).toBeVisible()
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 60_000 })
  await expect(page.getByTestId('audit-warning')).toHaveCount(0)
  // The copy from just before the new key is the one earlier copy kept.
  await page.getByTestId('nav-backup').click()
  await expect(page.getByText('Before a new household key')).toBeVisible()

  // Every entry, the member's own and the removal's, is signed by the person who made it and checks out.
  await page.getByTestId('nav-audit').click()
  await expect(page.getByTestId('audit-signatures')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 })
  await expect(page.getByTestId('audit-signatures')).toHaveAttribute('data-problems', '0')
  await expect(page.getByTestId('audit-signatures')).toContainText('Signatures:')
  await expect(page.locator('[data-testid="audit-signature"][data-signature="signed"]').first()).toBeVisible()
  await expect(page.locator('[data-testid="audit-signature"]:not([data-signature="signed"])')).toHaveCount(0)
  await page.getByTestId('audit-problems-only').check()
  await expect(page.getByTestId('audit-signature')).toHaveCount(0)
  await page.getByTestId('nav-health').click()
  const signatures = page.locator('[data-testid="health-check"][data-id="auditSignatures"]')
  await expect(signatures).toHaveAttribute('data-status', 'pass', { timeout: 60_000 })
  // The sign-in checked what was new; the full check is offered and then covers every entry.
  await signatures.getByTestId('health-action').click()
  await expect(signatures).toHaveAttribute('data-status', 'pass', { timeout: 60_000 })
  await expect(signatures.getByTestId('health-action')).toHaveCount(0)
  expect(await violations()).toEqual([])
})

test('restoring a backup from before a removal takes that person out again', async ({ page }) => {
  test.setTimeout(240_000)
  const violations = await watchViolations(page)
  await createVault(page)
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
  await signIn(page, FOUNDER.email, FOUNDER.password)
  await expect(page.getByTestId('kpi-net')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 60_000 })
  await page.getByTestId('nav-backup').click()
  const download = page.waitForEvent('download')
  await page.getByTestId('export-backup').click()
  const file = (await (await download).path())!

  await page.getByTestId('nav-users').click()
  await page.getByRole('link', { name: `Open: ${MEMBER.email}` }).click()
  await page.getByTestId('user-action-suspend').click()
  await page.getByTestId('user-suspend-dialog-confirm').click()
  await expect(page.getByTestId('user-detail')).toHaveAttribute('data-status', 'SUSPENDED')
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 60_000 })

  // The backup from before the suspension is older than this browser has seen.
  await page.getByTestId('nav-backup').click()
  await page.getByTestId('import-file').setInputFiles(file)
  await page.getByTestId('replace-password').fill(FOUNDER.password)
  await page.getByTestId('replace-name').fill('Keys Home')
  await page.getByTestId('confirm-import').click()
  await expect(page.getByTestId('replace-older')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('replace-older-removals')).toHaveText(MEMBER.email)
  await page.getByTestId('replace-older-confirm').click()
  await expect(page.getByTestId('login-email')).toBeVisible({ timeout: 60_000 })

  await signIn(page, MEMBER.email, MEMBER.password)
  await expect(page.getByText('Email or password is incorrect.')).toBeVisible({ timeout: 60_000 })
  // The restored copy is this browser's vault now: the founder signs in without the older-copy warning, back on the
  // page they left.
  await signIn(page, FOUNDER.email, FOUNDER.password)
  await expect(page.getByTestId('lock-vault')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('rollback-open')).toHaveCount(0)
  // The restored copy's log checks out, with the suspension made again signed by the admin who restored it.
  await page.getByTestId('nav-audit').click()
  await expect(page.getByTestId('audit-signatures')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 })
  await expect(page.getByTestId('audit-signatures')).toHaveAttribute('data-problems', '0')
  await expect(page.getByTestId('audit-warning')).toHaveCount(0)
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

  // A member given a new invite code signs in with new keys; one who was not still cannot.
  await page.getByTestId('nav-users').click()
  await page.getByRole('link', { name: 'Open: viewer@access.test' }).click()
  await page.getByTestId('user-action-reset').click()
  await page.getByTestId('detail-reset-issue').click()
  const code = (await page.getByTestId('issued-code').textContent({ timeout: 60_000 }))!.trim()
  await page.getByTestId('code-done').click()
  await lock(page)
  // A new code is a reset code underneath; told it is an invite, the person may well open the join page, which takes it.
  await page.getByTestId('join-link').click()
  await page.getByTestId('register-email').fill('viewer@access.test')
  await page.getByTestId('register-code').fill(code)
  await page.getByTestId('register-password').fill('Viewer keys after upgrade 7')
  await page.getByTestId('register-confirm').fill('Viewer keys after upgrade 7')
  await page.getByTestId('register-submit').click()
  await expect(page.getByTestId('kpi-net')).toBeVisible({ timeout: 60_000 })
  await lock(page)
  await signIn(page, 'manager@access.test', 'Joined by invite · v4 · Олма')
  await expect(page.getByText('Email or password is incorrect.')).toBeVisible({ timeout: 60_000 })
  await signIn(page, 'admin@access.test', 'Plum orchard admin v4')
  await expect(page.getByTestId('kpi-net')).toBeVisible({ timeout: 60_000 })

  // Signing starts at the upgrade: the 1.x entries before it are shown as written before signatures.
  await page.getByTestId('nav-audit').click()
  await expect(page.getByTestId('audit-signatures')).toHaveAttribute('data-problems', '0', { timeout: 30_000 })
  await expect(page.locator('[data-testid="audit-signature"][data-signature="legacy"]').first()).toBeVisible()
  await expect(page.getByTestId('audit-signatures')).toContainText('written before entries were signed')
  expect(await violations()).toEqual([])
})

test('an admin who says Not now keeps a working 1.x vault and is asked again next time; nobody else is asked', async ({ page }) => {
  test.setTimeout(240_000)
  const violations = await watchViolations(page)
  await page.goto('/')
  await page.getByTestId('import-file').setInputFiles(V4)
  await page.getByTestId('confirm-import').click()
  await signIn(page, 'admin@access.test', 'Plum orchard admin v4')
  await expect(page.getByTestId('upgrade-offer')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('upgrade-later').click()
  await expect(page.getByTestId('upgrade-offer')).toHaveCount(0)
  // Still a 1.x vault: temporary passwords are there, and the Health check says an upgrade can be made.
  await page.getByTestId('nav-users').click()
  await page.getByTestId('user-add').click()
  await expect(page.getByTestId('advanced-temp-toggle')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByTestId('nav-health').click()
  await expect(page.locator('[data-testid="health-check"][data-id="keysUpgrade"]')).toHaveAttribute('data-status', 'info', { timeout: 60_000 })
  await lock(page)
  await signIn(page, 'viewer@access.test', 'Viewer after reset code v4')
  await expect(page.getByTestId('kpi-net')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('upgrade-offer')).toHaveCount(0)
  await lock(page)
  await signIn(page, 'admin@access.test', 'Plum orchard admin v4')
  await expect(page.getByTestId('upgrade-offer')).toBeVisible({ timeout: 60_000 })
  expect(await violations()).toEqual([])
})

test('a vault whose audit signatures were deleted warns its admin on any browser, until the admin accepts the log', async ({ page }, testInfo) => {
  test.setTimeout(240_000)
  const violations = await watchViolations(page)
  // Forged with the app's own code by tests/e2e/forge/stripped-audit.forge.ts: a Viewer deleted every signature.
  const file = testInfo.outputPath('stripped.moliya')
  execFileSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'tests/e2e/forge/vitest.config.ts'], { env: { ...process.env, FORGE_OUT: file }, stdio: 'pipe' })
  await page.goto('/')
  await page.getByTestId('import-file').setInputFiles(file)
  await page.getByTestId('confirm-import').click()
  // A browser that never saw this vault: the founder compares the key, then the log is checked from its anchor.
  await signIn(page, 'founder@stripped.test', 'Founder stripped lantern 7')
  await page.getByTestId('trust-confirm').click({ timeout: 60_000 })
  await expect(page.getByTestId('audit-warning')).toHaveAttribute('data-kind', 'SIGNATURES', { timeout: 60_000 })
  await expect(page.getByTestId('audit-warning')).toContainText('#1')
  await page.getByTestId('audit-warning').getByRole('link').click()
  await page.getByTestId('audit-problems-only').check()
  await expect(page.locator('[data-testid="audit-signature"][data-signature="problem"]').first()).toContainText('Not signed')
  await expect(page.locator('[data-testid="audit-signature"]:not([data-signature="problem"])')).toHaveCount(0)
  await page.getByTestId('audit-accept').click()
  await expect(page.getByTestId('audit-warning')).toHaveCount(0)
  await lock(page)
  // Accepted: signing in here no longer warns, while the audit log keeps showing what is wrong in it.
  await signIn(page, 'founder@stripped.test', 'Founder stripped lantern 7')
  await expect(page.getByTestId('kpi-net')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('nav-audit').click()
  await expect(page.getByTestId('audit-signatures')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 })
  await expect(page.getByTestId('audit-signatures')).not.toHaveAttribute('data-problems', '0')
  await expect(page.getByTestId('audit-warning')).toHaveCount(0)
  expect(await violations()).toEqual([])
})

test('putting a 1.x backup back over an upgraded vault warns that every old password works again', async ({ page }) => {
  test.setTimeout(240_000)
  await page.goto('/')
  await page.getByTestId('import-file').setInputFiles(V4)
  await page.getByTestId('confirm-import').click()
  await signIn(page, 'admin@access.test', 'Plum orchard admin v4')
  await expect(page.getByTestId('upgrade-offer')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('upgrade-password').fill('Plum orchard admin v4')
  await page.getByTestId('upgrade-confirm').click()
  await expect(page.getByTestId('fingerprint-notice')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('fingerprint-done').click()
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 60_000 })

  await page.getByTestId('nav-backup').click()
  await page.getByTestId('import-file').setInputFiles(V4)
  await page.getByTestId('replace-password').fill('Plum orchard admin v4')
  await page.getByTestId('replace-name').fill('Access House')
  await page.getByTestId('confirm-import').click()
  await expect(page.getByTestId('replace-older-legacy')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('replace-older-confirm').click()
  await expect(page.getByTestId('login-email')).toBeVisible({ timeout: 60_000 })
  // The 1.x vault is back, old passwords and all (the Viewer lands back on the Backup page, which is not theirs).
  await signIn(page, 'viewer@access.test', 'Viewer after reset code v4')
  await expect(page.getByTestId('lock-vault')).toBeVisible({ timeout: 60_000 })
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
  // The setup screen says so before anything is typed, and keeps importing a backup open.
  await expect(page.getByTestId('setup-unsupported')).toContainText('This browser cannot use the keys this vault needs', { timeout: 30_000 })
  await expect(page.getByTestId('setup-submit')).toBeDisabled()
  await expect(page.getByTestId('import-file')).toBeEnabled()
  await expect(page.getByTestId('kpi-net')).toHaveCount(0)
})

test('a founder upgrade that cannot be saved leaves the 1.x vault as it was', async ({ page }) => {
  test.setTimeout(240_000)
  await page.goto('/')
  await page.getByTestId('import-file').setInputFiles(V4)
  await page.getByTestId('confirm-import').click()
  await signIn(page, 'admin@access.test', 'Plum orchard admin v4')
  await expect(page.getByTestId('upgrade-offer')).toBeVisible({ timeout: 60_000 })
  // The browser refuses to store the upgraded record, as when storage is full.
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (key === 'primary' && (value as { version?: unknown } | null)?.version === 3) throw new DOMException('No room', 'QuotaExceededError')
      return put.call(this, value, key)
    }
  })
  await page.getByTestId('upgrade-password').fill('Plum orchard admin v4')
  await page.getByTestId('upgrade-confirm').click()
  // The half-upgraded session is dropped without saving, and the page starts over.
  await expect(page.getByTestId('login-email')).toBeVisible({ timeout: 60_000 })
  // Still the 1.x vault: a member's old password opens it, and the admin is offered the upgrade again.
  await signIn(page, 'viewer@access.test', 'Viewer after reset code v4')
  await expect(page.getByTestId('kpi-net')).toBeVisible({ timeout: 60_000 })
  await lock(page)
  await signIn(page, 'admin@access.test', 'Plum orchard admin v4')
  await expect(page.getByTestId('upgrade-offer')).toBeVisible({ timeout: 60_000 })
})
