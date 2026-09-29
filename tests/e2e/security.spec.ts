import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { base32Decode, importTotpKey, totpAt } from '../../src/lib/totp'

const TARGET = process.env.E2E_TARGET === 'preview' ? 'preview' : 'dev'
const SCREENS = resolve(process.env.SCREENSHOT_DIR ?? `/tmp/moliya-security-screens/${TARGET}`)

const ADMIN = { email: 'admin@example.com', password: 'Correct horse lantern 7' }
const NEWCOMER = { email: 'newcomer@example.com', password: 'Newly chosen river words 8' }

type Watch = { console: string[]; violations: () => Promise<string[]> }

async function watch(page: Page): Promise<Watch> {
  const lines: string[] = []
  page.on('console', (message) => lines.push(message.text()))
  page.on('pageerror', (error) => lines.push(error.message))
  await page.addInitScript(() => {
    const seen: string[] = []
    ;(window as unknown as { __violations: string[] }).__violations = seen
    document.addEventListener('securitypolicyviolation', (event) => seen.push(`${event.effectiveDirective} ${event.blockedURI}`))
  })
  return {
    console: lines,
    violations: async () => [
      ...lines.filter((line) => /Content Security Policy|Trusted Type|Refused to/i.test(line)),
      ...(await page.evaluate(() => (window as unknown as { __violations?: string[] }).__violations ?? [])),
    ],
  }
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
}

async function lock(page: Page) {
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 30_000 })
  await page.getByTestId('lock-vault').click()
  await expect(page.getByTestId('login-email')).toBeVisible({ timeout: 30_000 })
}

async function screenshot(page: Page, name: string, target?: Locator) {
  mkdirSync(SCREENS, { recursive: true })
  await page.mouse.move(0, 0)
  const path = resolve(SCREENS, `${name}.png`)
  if (target) await target.screenshot({ path, animations: 'disabled' })
  else await page.screenshot({ path, fullPage: true, animations: 'disabled' })
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

/** Everything a secret must never reach: the title, the URL, and attributes other scripts or extensions read. */
async function expectNotExposed(page: Page, secrets: string[], console: string[]) {
  const exposed = await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    attributes: [...document.querySelectorAll('*')].flatMap((node) =>
      [...node.attributes].filter((attr) => attr.name.startsWith('data-') || ['title', 'aria-label', 'href', 'id', 'name'].includes(attr.name)).map((attr) => `${attr.name}=${attr.value}`),
    ),
  }))
  const variants = secrets.flatMap((secret) => [secret, secret.replace(/[\s-]/g, '')]).filter((secret) => secret.length >= 6)
  for (const secret of variants) {
    expect(exposed.title, 'secret in the title').not.toContain(secret)
    expect(exposed.url, 'secret in the URL').not.toContain(secret)
    expect(exposed.attributes.filter((value) => value.includes(secret)), 'secret in an attribute').toEqual([])
    expect(console.filter((line) => line.includes(secret)), 'secret in the console').toEqual([])
  }
}

function totpCode(secret: string, offsetMs = 0): Promise<string> {
  return importTotpKey(base32Decode(secret)).then((key) => totpAt(key, Date.now() + offsetMs))
}

async function issueInvite(page: Page, email: string, validity?: string): Promise<string> {
  await page.getByTestId('nav-users').click()
  await page.getByTestId('invite-email').fill(email)
  if (validity) await page.getByTestId('invite-validity').selectOption(validity)
  await page.getByTestId('invite-role').selectOption('Manager')
  await page.getByTestId('invite-create').click()
  const code = (await page.getByTestId('issued-code').textContent({ timeout: 30_000 }))!.trim()
  // 26 Crockford base32 data symbols, then a mod-37 check symbol that may also be one of * ~ $ = U.
  expect(code).toMatch(/^(?:[0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{3}[0-9A-HJKMNP-TV-Z*~$=U]$/)
  return code
}

async function register(page: Page, input: { email: string; code: string; password: string }) {
  await page.getByTestId('register-email').fill(input.email)
  await page.getByTestId('register-code').fill(input.code)
  await page.getByTestId('register-password').fill(input.password)
  await page.getByTestId('register-confirm').fill(input.password)
  await page.getByTestId('register-submit').click()
}

test('an invited person joins with a one-time code that works exactly once', async ({ page, context }) => {
  const watcher = await watch(page)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.setViewportSize({ width: 1440, height: 1000 })
  await createVault(page)
  const code = await issueInvite(page, NEWCOMER.email)
  await expect(page.getByTestId('issued-code-panel')).toContainText(NEWCOMER.email)
  await inBothThemes(page, 'invite-panel')
  await page.getByTestId('copy-link').click()
  const link = await page.evaluate(() => navigator.clipboard.readText())
  expect(link).toContain('#/register?')
  await expectNotExposed(page, [code], watcher.console)
  await page.getByTestId('code-done').click()
  await expect(page.getByTestId('issued-code-panel')).toHaveCount(0)
  await expect(page.getByTestId('grant-row')).toHaveCount(1)
  await expect(page.getByTestId('grant-row')).toContainText(NEWCOMER.email)
  await expect(page.getByTestId('grant-row')).not.toContainText(code)
  await lock(page)

  await page.goto(link)
  await expect(page.getByTestId('register-code')).toHaveValue(code, { timeout: 30_000 })
  await expect(page.getByTestId('register-email')).toHaveValue(NEWCOMER.email)
  await expect.poll(() => page.url()).not.toContain('code=')
  await expectNotExposed(page, [code], watcher.console)
  await inBothThemes(page, 'register-page')
  await page.getByTestId('register-password').fill(NEWCOMER.password)
  await page.getByTestId('register-confirm').fill(NEWCOMER.password)
  await page.getByTestId('register-submit').click()
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('must-change-banner')).toHaveCount(0)
  await expect(page.getByTestId('nav-transactions')).toBeVisible()
  await expectNotExposed(page, [code, NEWCOMER.password], watcher.console)
  await lock(page)

  await page.getByTestId('join-link').click()
  await register(page, { email: NEWCOMER.email, code, password: 'Another fresh passphrase 9' })
  await expect(page.getByTestId('form-error')).toContainText('do not match an open invitation', { timeout: 30_000 })

  await page.goto('/#/login')
  await signIn(page, NEWCOMER.email, NEWCOMER.password)
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 })
  await lock(page)
  await signIn(page, ADMIN.email, ADMIN.password)
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('nav-users').click()
  await expect(page.getByTestId('grant-row')).toHaveCount(0)
  await expect(page.getByTestId('person-row').filter({ hasText: NEWCOMER.email })).toBeVisible()
  await page.getByTestId('nav-audit').click()
  await expect(page.getByText('Invite code created')).toBeVisible()
  await expect(page.getByText('Invite accepted')).toBeVisible()
  await expect(page.getByTestId('audit-integrity')).toHaveAttribute('data-ok', 'true')
  await expect(page.locator('main')).not.toContainText(code)
  await expectNotExposed(page, [code, NEWCOMER.password], watcher.console)
  expect(await watcher.violations()).toEqual([])
})

test('an expired invite code is refused and recorded as expired', async ({ page }) => {
  const watcher = await watch(page)
  await page.clock.install()
  await createVault(page)
  const code = await issueInvite(page, NEWCOMER.email, '15m')
  await page.getByTestId('code-done').click()
  await lock(page)
  await page.clock.fastForward('16:00')
  await page.getByTestId('join-link').click()
  await register(page, { email: NEWCOMER.email, code, password: NEWCOMER.password })
  await expect(page.getByTestId('form-error')).toContainText('expired', { timeout: 30_000 })

  await page.getByRole('link', { name: 'Back to sign-in' }).click()
  await signIn(page, ADMIN.email, ADMIN.password)
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('nav-users').click()
  await expect(page.getByTestId('grant-row')).toHaveCount(0)
  await page.getByTestId('nav-audit').click()
  await expect(page.getByText('Code expired')).toBeVisible()
  expect(await watcher.violations()).toEqual([])
})

test('repeated wrong passwords lock sign-in with a countdown', async ({ page }) => {
  const watcher = await watch(page)
  await page.clock.install()
  await createVault(page)
  await lock(page)
  const submit = page.getByTestId('login-submit')
  let attempts = 0
  while (attempts < 8 && !(await page.getByTestId('throttled').isVisible())) {
    await signIn(page, ADMIN.email, `Wrong guess number ${attempts}`)
    await expect(page.getByTestId('form-error').or(page.getByTestId('throttled'))).toBeVisible({ timeout: 30_000 })
    attempts += 1
  }
  expect(attempts).toBe(5)
  const notice = page.getByTestId('throttled')
  await expect(notice).toContainText('Too many attempts')
  await expect(submit).toBeDisabled()
  const first = await notice.textContent()
  await expect.poll(() => notice.textContent(), { timeout: 5_000 }).not.toBe(first)
  await inBothThemes(page, 'lockout-countdown')

  await page.reload()
  await signIn(page, ADMIN.email, ADMIN.password)
  await expect(page.getByTestId('throttled')).toBeVisible()
  await expect(page.getByTestId('app-shell')).toHaveCount(0)
  await page.clock.fastForward('00:31')
  await expect(page.getByTestId('throttled')).toHaveCount(0)
  await signIn(page, ADMIN.email, ADMIN.password)
  await expect(page.getByTestId('failures-seen-banner')).toContainText('5', { timeout: 30_000 })
  await page.getByTestId('nav-audit').click()
  await expect(page.getByText('Failed sign-in attempts seen')).toBeVisible()
  expect(await watcher.violations()).toEqual([])
})

test('the sign-in check asks for an authenticator code and accepts each recovery code once', async ({ page }) => {
  const watcher = await watch(page)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await createVault(page)
  await page.getByTestId('nav-account').click()
  await expect(page.getByTestId('sign-in-check')).toHaveAttribute('data-state', 'off')
  await page.getByTestId('totp-start').click()
  await expect(page.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible()
  const secret = (await page.getByTestId('totp-secret').textContent())!.replace(/\s/g, '')
  expect(secret).toMatch(/^[A-Z2-7]{32}$/)
  await inBothThemes(page, 'totp-setup', page.getByTestId('sign-in-check').locator('xpath=..'))
  await page.getByTestId('totp-setup-code').fill('000000')
  await page.getByTestId('totp-setup-password').fill(ADMIN.password)
  await page.getByTestId('totp-confirm').click()
  await expect(page.getByTestId('form-error')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('totp-setup-code').fill(await totpCode(secret))
  await page.getByTestId('totp-setup-password').fill(ADMIN.password)
  await page.getByTestId('totp-confirm').click()
  await expect(page.getByTestId('totp-recovery').locator('li')).toHaveCount(10, { timeout: 30_000 })
  const recovery = await page.getByTestId('totp-recovery').locator('li').allTextContents()
  expect(recovery).toHaveLength(10)
  for (const item of recovery) expect(item).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/)
  await page.getByTestId('totp-recovery-done').click()
  await expect(page.getByTestId('sign-in-check')).toHaveAttribute('data-state', 'on')
  await expectNotExposed(page, [secret, ...recovery], watcher.console)
  await lock(page)

  await signIn(page, ADMIN.email, ADMIN.password)
  await expect(page.getByTestId('totp-code')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('app-shell')).toHaveCount(0)
  await page.getByTestId('totp-code').fill('123456')
  await page.getByTestId('totp-submit').click()
  await expect(page.getByTestId('form-error')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('totp-code').fill(await totpCode(secret, 30_000))
  await page.getByTestId('totp-submit').click()
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 })
  await lock(page)

  await signIn(page, ADMIN.email, ADMIN.password)
  await page.getByTestId('totp-code').fill(recovery[2].toLowerCase())
  await page.getByTestId('totp-submit').click()
  await expect(page.getByTestId('recovery-used-banner')).toContainText('9', { timeout: 30_000 })
  await lock(page)
  await signIn(page, ADMIN.email, ADMIN.password)
  await page.getByTestId('totp-code').fill(recovery[2])
  await page.getByTestId('totp-submit').click()
  await expect(page.getByTestId('form-error')).toContainText('not correct', { timeout: 30_000 })
  await page.getByTestId('totp-cancel').click()
  await expect(page.getByTestId('login-email')).toBeVisible()

  await signIn(page, ADMIN.email, ADMIN.password)
  await page.getByTestId('totp-code').fill(recovery[5])
  await page.getByTestId('totp-submit').click()
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('nav-account').click()
  await page.getByTestId('totp-disable').click()
  await page.getByTestId('totp-disable-password').fill(ADMIN.password)
  await page.getByTestId('totp-disable-confirm').click()
  await expect(page.getByTestId('sign-in-check')).toHaveAttribute('data-state', 'off', { timeout: 30_000 })
  await page.getByTestId('nav-audit').click()
  await expect(page.getByText('Sign-in check turned on')).toBeVisible()
  await expect(page.getByText('Sign-in recovery code used').first()).toBeVisible()
  await expect(page.getByText('Sign-in check turned off')).toBeVisible()
  await expectNotExposed(page, [secret, ...recovery], watcher.console)
  expect(await watcher.violations()).toEqual([])
})

test('a reset code replaces a password that someone else may know', async ({ page }) => {
  const watcher = await watch(page)
  const member = { email: 'member@example.com', temporary: 'Temporary lamp words 22', next: 'Member picks own words 4' }
  await createVault(page)
  await page.getByTestId('nav-users').click()
  await page.getByTestId('advanced-temp-toggle').click()
  await page.getByTestId('user-email').fill(member.email)
  await page.getByTestId('user-password').fill(member.temporary)
  await page.getByTestId('user-save').click()
  const row = page.getByTestId('person-row').filter({ hasText: member.email })
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.getByTestId('user-issue-reset').click()
  await expect(row.getByTestId('reset-stop-old')).toBeChecked()
  await row.getByTestId('reset-validity').selectOption('1h')
  await row.getByTestId('reset-issue-save').click()
  const code = (await page.getByTestId('issued-code').textContent({ timeout: 30_000 }))!.trim()
  await expectNotExposed(page, [code], watcher.console)
  await page.getByTestId('code-done').click()
  await expect(page.getByTestId('grant-row')).toContainText(member.email)
  await lock(page)

  await signIn(page, member.email, member.temporary)
  await expect(page.getByTestId('form-error')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('reset-link').click()
  await register(page, { email: member.email, code, password: member.next })
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('must-change-banner')).toHaveCount(0)
  await lock(page)

  await signIn(page, ADMIN.email, ADMIN.password)
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('nav-audit').click()
  await expect(page.getByText('Reset code issued')).toBeVisible()
  await expect(page.getByText('Password reset with code')).toBeVisible()
  await expectNotExposed(page, [code, member.next], watcher.console)
  expect(await watcher.violations()).toEqual([])
})

test('replacing a vault with a backup needs the password and the vault name', async ({ page }) => {
  const watcher = await watch(page)
  await createVault(page)
  await page.getByTestId('nav-backup').click()
  const download = page.waitForEvent('download')
  await page.getByTestId('export-backup').click()
  const file = await (await download).path()
  const panel = page.getByTestId('replace-panel')
  await panel.getByTestId('import-file').setInputFiles(file)
  await expect(panel.getByTestId('import-summary')).toBeVisible()
  const label = (await panel.locator('label', { has: page.getByTestId('replace-name') }).locator('span').first().textContent())!
  const vaultName = label.slice(label.lastIndexOf(': ') + 2)
  await panel.getByTestId('replace-password').fill('Not my password at all')
  await panel.getByTestId('replace-name').fill(vaultName)
  await panel.getByTestId('confirm-import').click()
  await expect(panel.getByTestId('form-error')).toBeVisible({ timeout: 30_000 })
  await panel.getByTestId('replace-password').fill(ADMIN.password)
  await panel.getByTestId('replace-name').fill(`${vaultName} typo`)
  await panel.getByTestId('confirm-import').click()
  await expect(panel.getByTestId('form-error')).toContainText('does not match', { timeout: 30_000 })
  await panel.getByTestId('replace-password').fill(ADMIN.password)
  await panel.getByTestId('replace-name').fill(vaultName.toUpperCase())
  await panel.getByTestId('confirm-import').click()
  await expect(page.getByTestId('login-email')).toBeVisible({ timeout: 30_000 })
  await signIn(page, ADMIN.email, ADMIN.password)
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('nav-backup').click()
  await expect(page.getByTestId('archive-row')).toHaveCount(1)
  expect(await watcher.violations()).toEqual([])
})

test('the vault locks itself after the chosen idle time', async ({ page }) => {
  const watcher = await watch(page)
  await page.clock.install()
  await createVault(page)
  await page.getByTestId('nav-account').click()
  await page.getByTestId('idle-minutes').selectOption('5')
  await page.getByTestId('nav-dashboard').click()
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 30_000 })
  await page.clock.fastForward('04:00')
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.clock.fastForward('01:30')
  await expect(page.getByTestId('login-email')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('idle-locked')).toBeVisible()
  expect(await watcher.violations()).toEqual([])
})

test('refuses an import file larger than any real backup before reading it', async ({ page }, testInfo) => {
  const watcher = await watch(page)
  const big = testInfo.outputPath('huge.moliya')
  writeFileSync(big, Buffer.alloc(73 * 1024 * 1024, 0x20))
  await page.goto('/')
  await page.getByTestId('import-file').setInputFiles(big)
  await expect(page.getByTestId('form-error')).toContainText('too large', { timeout: 30_000 })
  await expect(page.getByTestId('confirm-import')).toHaveCount(0)
  expect(await watcher.violations()).toEqual([])
})

test('the register page explains that codes only work where the vault is stored', async ({ page }) => {
  await page.goto('/#/register')
  await expect(page.getByTestId('register-no-vault')).toBeVisible({ timeout: 30_000 })
})

test('does not run inside another page', async ({ browser, baseURL }) => {
  // A route-fulfilled parent counts as a public origin, which Chrome may not let frame 127.0.0.1 without this permission.
  const context = await browser.newContext({ serviceWorkers: 'block', permissions: ['local-network-access'] })
  const page = await context.newPage()
  const parent = `${baseURL!.replace('127.0.0.1', 'localhost')}/frame-host.html`
  expect(new URL(parent).origin).not.toBe(new URL(baseURL!).origin)
  await page.route(parent, (route) =>
    route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>host</title><iframe src="${baseURL}/" width="800" height="600"></iframe>` }),
  )
  await page.goto(parent)
  const frame = page.frameLocator('iframe')
  await expect(frame.getByText('does not run inside another page')).toBeVisible({ timeout: 30_000 })
  const link = frame.getByRole('link', { name: 'Open Jaybi in its own tab' })
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('rel', /noopener/)
  await expect(frame.getByTestId('setup-email')).toHaveCount(0)
  await expect(frame.getByTestId('login-email')).toHaveCount(0)
  await context.close()
})

test('ships a strict Content Security Policy with Trusted Types in the production build', async ({ page }) => {
  test.skip(TARGET !== 'preview', 'the policy is added to the production build only')
  const watcher = await watch(page)
  await page.goto('/')
  await expect(page.getByTestId('setup-email')).toBeVisible({ timeout: 30_000 })
  const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')
  for (const directive of ["default-src 'none'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "require-trusted-types-for 'script'"]) {
    expect(policy).toContain(directive)
  }
  expect(policy).not.toContain('unsafe-inline')
  expect(await page.locator('meta[name="referrer"]').getAttribute('content')).toBe('no-referrer')
  const heads = await page.evaluate(() => [...document.head.children].map((node) => node.getAttribute('http-equiv') ?? node.getAttribute('name') ?? node.tagName))
  expect(heads.slice(0, 3)).toEqual(['META', 'referrer', 'Content-Security-Policy'])
  expect(await page.evaluate(() => document.characterSet)).toBe('UTF-8')
  expect(await watcher.violations()).toEqual([])
  const sink = await page.evaluate(() => {
    try {
      document.createElement('div').innerHTML = '<img src=x>'
      return 'allowed'
    } catch (error) {
      return (error as Error).name
    }
  })
  expect(sink).toBe('TypeError')
})
