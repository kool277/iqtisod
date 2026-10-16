import { randomBytes, randomUUID, webcrypto } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { watchViolations } from '../support/csp'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = resolve(here, '../fixtures/backups/v4/access-household.moliya')
const ADMIN = { email: 'admin@access.test', password: 'Plum orchard admin v4' }
const EXPENSE_ID = '7f80fe7c-e1b9-482a-90c1-1ae3124d0d9c'
const MIB = 1024 * 1024
/** 1.0.0–1.6.0 refused any backup file larger than this. */
const LEGACY_FILE_LIMIT = 72 * MIB
const COPIES = 48
/** Enough for a file well above the 512 KiB envelope allowance and well below {@link LEGACY_FILE_LIMIT}. */
const MEDIUM_COPIES = 2
const RECEIPT_BYTES = 0.9375 * MIB

const { subtle } = webcrypto
const bytes = (text: string) => new Uint8Array(Buffer.from(text, 'base64'))

/**
 * The golden 1.3.0 household backup with `copies` more copies of its one expense, each with a receipt of about
 * 1.25 MiB, re-encrypted under the same data key: with {@link COPIES}, a vault of about 60 MiB in a backup file of
 * about 80 MiB.
 */
async function buildLargeBackup(dir: string, copies = COPIES): Promise<string> {
  const backup = JSON.parse(readFileSync(FIXTURE, 'utf8'))
  const wrap = backup.wraps.find((item: { email: string }) => item.email === ADMIN.email)
  const material = await subtle.importKey('raw', new TextEncoder().encode(ADMIN.password), 'PBKDF2', false, ['deriveBits'])
  const bits = await subtle.deriveBits({ name: 'PBKDF2', salt: bytes(wrap.salt), iterations: wrap.kdf.iterations, hash: wrap.kdf.hash }, material, 256)
  const kek = await subtle.importKey('raw', bits, 'AES-GCM', false, ['decrypt'])
  const rawDek = await subtle.decrypt({ name: 'AES-GCM', iv: bytes(wrap.iv) }, kek, bytes(wrap.wrappedDek))
  const dek = await subtle.importKey('raw', rawDek, 'AES-GCM', false, ['encrypt', 'decrypt'])
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: bytes(backup.body.iv) }, dek, bytes(backup.body.ciphertext)))

  const path = join(dir, 'vault.sqlite')
  writeFileSync(path, plain)
  const db = new DatabaseSync(path)
  try {
    const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(EXPENSE_ID) as Record<string, unknown>
    const columns = Object.keys(row)
    const insert = db.prepare(`INSERT INTO transactions (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    db.exec('BEGIN')
    for (let copy = 0; copy < copies; copy += 1) {
      const values: Record<string, unknown> = { ...row, id: randomUUID(), receipt_data: `data:image/png;base64,${randomBytes(RECEIPT_BYTES).toString('base64')}` }
      insert.run(...columns.map((column) => values[column] as string | number | null))
    }
    db.exec('COMMIT')
  } finally {
    db.close()
  }

  const iv = randomBytes(12)
  const ciphertext = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, dek, readFileSync(path)))
  backup.body = { iv: iv.toString('base64'), ciphertext: Buffer.from(ciphertext).toString('base64') }
  const file = join(dir, `household-${copies}.moliya`)
  writeFileSync(file, JSON.stringify(backup))
  return file
}

let workDir = ''
let largeFile = ''
let mediumFile = ''

test.beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'jaybi-large-backup-'))
  largeFile = await buildLargeBackup(workDir)
  expect(statSync(largeFile).size).toBeGreaterThan(LEGACY_FILE_LIMIT)
  mediumFile = await buildLargeBackup(workDir, MEDIUM_COPIES)
  expect(statSync(mediumFile).size).toBeGreaterThan(MIB)
})

/** Makes the page believe the browser has `quota` bytes of storage, all free. */
async function reportQuota(page: Page, quota: number) {
  await page.addInitScript((value) => {
    Object.defineProperty(StorageManager.prototype, 'estimate', { value: async () => ({ quota: value, usage: 0 }) })
  }, quota)
}

test.afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

async function openSetup(page: Page) {
  await page.goto('/')
  await expect(page.getByTestId('import-file')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('import-budget')).toContainText('Largest backup this device can restore')
}

async function login(page: Page) {
  await page.getByTestId('login-email').fill(ADMIN.email)
  await page.getByTestId('login-password').fill(ADMIN.password)
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('kpi-net')).toBeVisible({ timeout: 60_000 })
}

async function expectTotals(page: Page, copies = COPIES) {
  await page.getByTestId('period-custom').click()
  await page.getByTestId('period-from').fill('2026-02-01')
  await page.getByTestId('period-to').fill('2026-02-28')
  await expect(page.getByTestId('kpi-income')).toHaveAttribute('data-amount', '12500000')
  await expect(page.getByTestId('kpi-expense')).toHaveAttribute('data-amount', String(185000 * (copies + 1)))
}

test('restores, saves and backs up a vault whose backup is larger than the old 72 MB limit', async ({ page }) => {
  test.setTimeout(300_000)
  const violations = await watchViolations(page)
  await openSetup(page)
  // Chromium stores at most a 127 MiB IndexedDB value, so a vault there is capped at 126 MiB (a 168 MB backup).
  await expect(page.getByTestId('import-budget')).toContainText('168 MB · limited by what this browser can save')

  await page.getByTestId('import-file').setInputFiles(largeFile)
  await expect(page.getByTestId('confirm-import')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('confirm-import').click()
  await login(page)
  await expectTotals(page)
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 60_000 })

  await page.reload()
  await login(page)
  await expectTotals(page)

  await page.getByTestId('nav-backup').click()
  const download = page.waitForEvent('download')
  await page.getByTestId('export-backup').click()
  const exported = await (await download).path()
  const file = readFileSync(exported!)
  expect(file.byteLength).toBeGreaterThan(LEGACY_FILE_LIMIT)
  const written = JSON.parse(file.toString('utf8'))
  expect(written).toMatchObject({ format: 'moliya-vault', version: 2 })
  expect(bytes(written.body.ciphertext).byteLength).toBeGreaterThan(COPIES * RECEIPT_BYTES)

  if (process.env.E2E_TARGET === 'preview') {
    await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveCount(1)
  }
  expect(await violations()).toEqual([])
})

test('explains which limit refuses a backup that is too large for this device', async ({ page }) => {
  const violations = await watchViolations(page)
  // Free storage for about 43 MB of backup, below the 72 MB every device accepts.
  await reportQuota(page, 120 * MIB)
  await openSetup(page)
  await expect(page.getByTestId('import-budget')).toContainText('72 MB · limited by free storage in this browser')

  await page.getByTestId('import-file').setInputFiles(largeFile)
  await expect(page.getByText(/This backup is \d+ MB, more than this browser can store here \(72 MB\)/)).toBeVisible()
  await expect(page.getByTestId('confirm-import')).toHaveCount(0)
  await expect(page.getByTestId('import-file')).toBeEnabled()
  expect(await violations()).toEqual([])
})

test('restores a backup within the old 72 MB limit even when the browser reports almost no free storage', async ({ page }) => {
  const violations = await watchViolations(page)
  await reportQuota(page, 3 * MIB)
  await openSetup(page)
  await expect(page.getByTestId('import-budget')).toContainText('72 MB · limited by free storage in this browser')

  await page.getByTestId('import-file').setInputFiles(mediumFile)
  await expect(page.getByTestId('confirm-import')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('confirm-import').click()
  await login(page)
  await expectTotals(page, MEDIUM_COPIES)
  expect(await violations()).toEqual([])
})
