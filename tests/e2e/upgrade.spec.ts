import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(here, '../fixtures/backups')
const household = readFileSync(resolve(FIXTURES, 'v1/household-usd.moliya'), 'utf8')
const businessFile = resolve(FIXTURES, 'v1/business-uzs.moliya')
const packageVersion = (JSON.parse(readFileSync(resolve(here, '../../package.json'), 'utf8')) as { version: string }).version

type StoredSummary = {
  version: unknown
  schemaVersion: unknown
  appVersion: unknown
  hasBody: boolean
  hasPayload: boolean
  iterations: Record<string, unknown>
  archives: { key: string; reason: unknown; sourceVersion: unknown }[]
}

async function openApp(page: Page) {
  await page.goto('/')
  await expect(page.getByTestId('setup-email').or(page.getByTestId('login-email')).or(page.getByTestId('boot-error'))).toBeVisible({
    timeout: 30_000,
  })
}

async function putRecord(page: Page, key: string, value: unknown) {
  await page.evaluate(
    async ({ key, value }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('moliya', 1)
        request.onupgradeneeded = () => request.result.createObjectStore('vault')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('vault', 'readwrite')
        tx.objectStore('vault').put(value, key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      db.close()
    },
    { key, value },
  )
}

async function injectV1Record(page: Page, backupText: string) {
  await page.evaluate(async (text) => {
    const backup = JSON.parse(text)
    const buffer = (b64: string) => Uint8Array.from(atob(b64), (char) => char.charCodeAt(0)).buffer
    const record = {
      id: 'primary',
      version: 1,
      kdf: backup.kdf,
      wraps: backup.wraps.map((wrap: Record<string, string>) => ({
        userId: wrap.userId,
        email: wrap.email,
        salt: buffer(wrap.salt),
        iv: buffer(wrap.iv),
        wrappedDek: buffer(wrap.wrappedDek),
      })),
      payload: { iv: buffer(backup.payload.iv), ciphertext: buffer(backup.payload.ciphertext) },
      updatedAt: '2026-04-01T09:00:00.000Z',
    }
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('moliya', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('vault')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('vault', 'readwrite')
      tx.objectStore('vault').put(record, 'primary')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  }, backupText)
}

async function storedSummary(page: Page): Promise<StoredSummary> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('moliya', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const store = db.transaction('vault', 'readonly').objectStore('vault')
    const read = <T,>(request: IDBRequest<T>) =>
      new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    const record = (await read(store.get('primary'))) as Record<string, any>
    const keys = (await read(store.getAllKeys())) as string[]
    const archives = []
    for (const key of keys.filter((item) => item.startsWith('archive:'))) {
      const entry = (await read(db.transaction('vault', 'readonly').objectStore('vault').get(key))) as Record<string, any>
      archives.push({ key, reason: entry.reason, sourceVersion: entry.raw?.version })
    }
    db.close()
    return {
      version: record.version,
      schemaVersion: record.schemaVersion,
      appVersion: record.appVersion,
      hasBody: 'body' in record,
      hasPayload: 'payload' in record,
      iterations: Object.fromEntries((record.wraps ?? []).map((wrap: any) => [wrap.email, wrap.kdf?.iterations ?? null])),
      archives,
    }
  })
}

async function login(page: Page, email: string, password: string) {
  await page.getByTestId('login-email').fill(email)
  await page.getByTestId('login-password').fill(password)
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('kpi-net')).toBeVisible({ timeout: 30_000 })
}

async function showRange(page: Page, from: string, to: string) {
  await page.getByTestId('period-custom').click()
  await page.getByTestId('period-from').fill(from)
  await page.getByTestId('period-to').fill(to)
}

async function expectKpis(page: Page, values: { income: string; expense: string; net: string; savings: string }) {
  await expect(page.getByTestId('kpi-income')).toHaveAttribute('data-amount', values.income)
  await expect(page.getByTestId('kpi-expense')).toHaveAttribute('data-amount', values.expense)
  await expect(page.getByTestId('kpi-net')).toHaveAttribute('data-amount', values.net)
  await expect(page.getByTestId('kpi-savings')).toHaveAttribute('data-amount', values.savings)
}

function watchCsp(page: Page): string[] {
  const violations: string[] = []
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text())
  })
  return violations
}

test('upgrades a vault stored by 1.0.0 in this browser without losing anything', async ({ page }) => {
  const violations = watchCsp(page)
  await openApp(page)
  await injectV1Record(page, household)
  await page.reload()
  await expect(page.getByTestId('login-email')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(`v${packageVersion}`).filter({ visible: true })).toHaveCount(1)

  await login(page, 'admin@golden.test', 'golden-admin-v1')
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 30_000 })
  const stored = await storedSummary(page)
  expect(stored).toMatchObject({ version: 2, schemaVersion: 4, appVersion: packageVersion, hasBody: true, hasPayload: false })
  expect(stored.iterations).toEqual({ 'admin@golden.test': 600000, 'manager@golden.test': 200000, 'viewer@golden.test': 200000 })
  expect(stored.archives).toHaveLength(1)
  expect(stored.archives[0]).toMatchObject({ reason: 'upgrade', sourceVersion: 1 })

  await showRange(page, '2026-01-01', '2026-03-31')
  await expectKpis(page, { income: '1002500', expense: '1314.7', net: '1001185.3', savings: '99.9' })
  await expect(page.getByTestId('other-currencies').locator('[data-currency]')).toHaveCount(2)
  await expect(page.getByTestId('chart-monthly').locator('canvas')).toBeVisible()

  await page.getByTestId('nav-transactions').click()
  await showRange(page, '2026-01-01', '2026-03-31')
  await expect(page.getByTestId('tx-row')).toHaveCount(14)
  await expect(page.locator('[data-testid="tx-row"][data-amount="2.68"]')).toHaveCount(1)
  await expect(page.locator('[data-testid="tx-row"][data-amount="1"]')).toHaveCount(1)

  await page.getByTestId('nav-audit').click()
  await expect(page.getByTestId('audit-integrity')).toHaveAttribute('data-ok', 'true')

  await page.getByTestId('nav-backup').click()
  await expect(page.getByTestId('archive-row')).toHaveCount(1)
  const download = page.waitForEvent('download')
  await page.getByTestId('archive-row').getByRole('button').click()
  const archived = await (await download).path()
  expect(readFileSync(archived!, 'utf8')).toBe(household)

  await page.getByTestId('nav-settings').click()
  await expect(page.getByTestId('about-version')).toHaveText(packageVersion)
  await expect(page.getByTestId('about-schema')).toHaveText('4')
  await expect(page.getByTestId('app-version')).toHaveText(`v${packageVersion}`)

  await page.getByTestId('lock-vault').click()
  await login(page, 'manager@golden.test', 'golden-manager-v1')
  await showRange(page, '2026-01-01', '2026-03-31')
  await expectKpis(page, { income: '1002500', expense: '80.14', net: '1002419.86', savings: '100' })
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 30_000 })

  await page.getByTestId('lock-vault').click()
  await login(page, 'viewer@golden.test', 'golden-viewer-v1')
  await showRange(page, '2026-01-01', '2026-03-31')
  await expect(page.getByTestId('kpi-expense')).toHaveAttribute('data-amount', '80.14')
  const after = await storedSummary(page)
  expect(after.iterations).toEqual({ 'admin@golden.test': 600000, 'manager@golden.test': 600000, 'viewer@golden.test': 600000 })
  expect(after.archives).toHaveLength(1)

  if (process.env.E2E_TARGET === 'preview') {
    await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveCount(1)
  }
  expect(violations).toEqual([])
})

test('imports a 1.0.0 backup file into a fresh browser', async ({ page }) => {
  await openApp(page)
  await page.getByTestId('import-file').setInputFiles(businessFile)
  await page.getByTestId('confirm-import').click()
  await login(page, 'owner@business.test', 'пароль-oʻzbek-🔐-v1')
  await showRange(page, '2026-06-01', '2026-06-30')
  await expectKpis(page, { income: '12500000.75', expense: '350000.5', net: '12150000.25', savings: '97.2' })
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 30_000 })
  expect((await storedSummary(page)).schemaVersion).toBe(4)
})

test('refuses a vault written by a newer version and leaves it untouched', async ({ page }) => {
  await openApp(page)
  const future = { id: 'primary', version: 99, appVersion: '9.0.0', note: 'from the future' }
  await putRecord(page, 'primary', future)
  await page.reload()
  await expect(page.getByTestId('boot-error')).toHaveAttribute('data-code', 'FORMAT_TOO_NEW', { timeout: 30_000 })
  await expect(page.getByTestId('boot-error')).toContainText('newer version')
  const stored = await storedSummary(page)
  expect(stored.version).toBe(99)
  expect(stored.appVersion).toBe('9.0.0')
})

test('reports a damaged vault instead of overwriting it', async ({ page }) => {
  await openApp(page)
  await putRecord(page, 'primary', { id: 'primary', version: 2, body: 'not binary' })
  await page.reload()
  await expect(page.getByTestId('boot-error')).toHaveAttribute('data-code', 'RECORD_INVALID', { timeout: 30_000 })
  expect((await storedSummary(page)).version).toBe(2)
})

test('allows only one unlocked session per browser', async ({ page, context }) => {
  await openApp(page)
  await injectV1Record(page, household)
  await page.reload()
  await login(page, 'admin@golden.test', 'golden-admin-v1')
  const second = await context.newPage()
  await second.goto('/')
  await second.getByTestId('login-email').fill('manager@golden.test')
  await second.getByTestId('login-password').fill('golden-manager-v1')
  await second.getByTestId('login-submit').click()
  await expect(second.getByTestId('form-error')).toContainText('already unlocked', { timeout: 30_000 })
  await page.getByTestId('lock-vault').click()
  await second.getByTestId('login-submit').click()
  await expect(second.getByTestId('kpi-net')).toBeVisible({ timeout: 30_000 })
})
