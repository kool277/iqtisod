import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BlobReader, TextWriter, ZipReader, configure } from '@zip.js/zip.js/index-native.js'
import { expect, test, type Page } from '@playwright/test'
import Database from 'better-sqlite3-multiple-ciphers'
import readXlsxFile from 'read-excel-file/node'
import { extractText, getDocumentProxy } from 'unpdf'

configure({ useWebWorkers: false })

const here = dirname(fileURLToPath(import.meta.url))
const LEDGER = resolve(here, '../fixtures/backups/v2/ledger-v2.moliya')
const FORMATS = ['csv', 'json', 'jsonl', 'xlsx', 'pdf', 'sqlite'] as const
const LAZY = /jspdf|write-excel-file|@zip(\.|_+)js|export-(pdf|xlsx|zip)-|NotoSans|services\/export\/(?!options|password)/i
const NAME = (suffix: string) => new RegExp(`^moliya-Ledger-Two-\\d{4}-\\d{2}-\\d{2}${suffix.replace(/\./g, '\\.')}$`)

async function importLedger(page: Page, email: string, password: string) {
  await page.goto('/')
  await page.getByTestId('import-file').setInputFiles(LEDGER)
  await page.getByTestId('confirm-import').click()
  await page.getByTestId('login-email').fill(email)
  await page.getByTestId('login-password').fill(password)
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('kpi-net')).toBeVisible({ timeout: 30_000 })
}

async function chooseFormats(page: Page, wanted: readonly string[]) {
  for (const format of FORMATS) await page.getByTestId(`export-format-${format}`).setChecked(wanted.includes(format))
}

async function download(page: Page): Promise<{ name: string; bytes: Buffer }> {
  const pending = page.waitForEvent('download')
  await page.getByTestId('export-start').click()
  const file = await pending
  const bytes = readFileSync((await file.path())!)
  await expect(page.getByTestId('export-progress')).toHaveText('Export downloaded.')
  return { name: file.suggestedFilename(), bytes }
}

async function unzip(bytes: Buffer, password: string): Promise<Map<string, string>> {
  const reader = new ZipReader(new BlobReader(new Blob([new Uint8Array(bytes)])), { password })
  const files = new Map<string, string>()
  for (const entry of await reader.getEntries()) {
    if (!entry.directory) files.set(entry.filename, await entry.getData(new TextWriter()))
  }
  await reader.close()
  return files
}

function withSqlite<T>(bytes: Buffer, key: string | null, read: (db: Database) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'moliya-e2e-'))
  const path = join(dir, 'export.sqlite')
  writeFileSync(path, bytes)
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    if (key) {
      db.pragma("cipher = 'sqlcipher'")
      db.pragma('legacy = 4')
      db.pragma(`key = '${key}'`)
    }
    return read(db)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const CHECKS: Record<(typeof FORMATS)[number], (bytes: Buffer) => Promise<void>> = {
  async csv(bytes) {
    const text = bytes.toString('utf8')
    expect(text.startsWith('\ufeffid,date,type,category,amount,currency,amount_minor')).toBe(true)
    expect(text).toContain('Oʻzbekcha izoh — Ўзбекча')
    expect(text).toContain("'@SUM(1+1) csv trap")
    expect(text.split('\r\n').length).toBeGreaterThan(12)
  },
  async json(bytes) {
    const data = JSON.parse(bytes.toString('utf8'))
    expect(data.format).toBe('moliya-export')
    expect(data.transactions).toHaveLength(12)
    expect(data.transactions.some((row: { amountMinor: number }) => row.amountMinor === 999999999999999)).toBe(true)
  },
  async jsonl(bytes) {
    const lines = bytes.toString('utf8').trimEnd().split('\n').map((line) => JSON.parse(line))
    expect(lines[0].type).toBe('header')
    expect(lines.at(-1)).toMatchObject({ type: 'footer', counts: { transaction: 12 } })
  },
  async xlsx(bytes) {
    const sheets = await readXlsxFile(bytes)
    expect(sheets.map((sheet) => sheet.sheet)).toEqual(['Summary', 'Records', 'Categories', 'Groups', 'People', 'About'])
    expect(sheets[1].data).toHaveLength(13)
  },
  async pdf(bytes) {
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    const { text } = await extractText(await getDocumentProxy(new Uint8Array(bytes)), { mergePages: true })
    expect(text).toContain('Ledger Two')
    expect(text).toContain('Oʻzbekcha izoh — Ўзбекча')
    expect(text).toContain('Confidential')
  },
  async sqlite(bytes) {
    expect(bytes.subarray(0, 16).toString('latin1')).toBe('SQLite format 3\0')
    withSqlite(bytes, null, (db) => {
      expect(db.prepare('SELECT COUNT(*) AS n FROM transactions').get()).toEqual({ n: 12 })
      expect(db.prepare("SELECT COUNT(*) AS n FROM users WHERE password_hash <> ''").get()).toEqual({ n: 0 })
    })
  },
}

test('admin exports every format, encrypted and plain, and the files read back', async ({ page }) => {
  const requests: string[] = []
  page.on('request', (request) => requests.push(request.url()))
  const lazy = () => requests.filter((url) => LAZY.test(url))

  await importLedger(page, 'admin@ledger.test', 'ledger-admin-v2')
  expect(lazy(), 'export code is not loaded at sign-in or on the dashboard').toEqual([])
  await page.getByTestId('nav-backup').click()
  await expect(page.getByTestId('export-panel')).toBeVisible()
  expect(lazy(), 'opening the backup page loads no export library').toEqual([])
  await expect(page.getByTestId('export-protection-zip')).toBeChecked()
  await expect(page.getByTestId('export-format-csv')).toBeChecked()
  await expect(page.getByTestId('export-include-receipts')).not.toBeChecked()

  await page.getByTestId('export-protection-none').check()
  await page.getByTestId('export-start').click()
  await expect(page.getByTestId('form-error')).toHaveText('Confirm that you understand the file is not encrypted.')
  await page.getByTestId('export-plain-confirm').check()
  for (const format of FORMATS) {
    await chooseFormats(page, [format])
    const file = await download(page)
    expect(file.name).toMatch(NAME(`.${format}`))
    await CHECKS[format](file.bytes)
  }
  expect(lazy().some((url) => /jspdf|export-pdf-/.test(url))).toBe(true)
  expect(lazy().some((url) => /NotoSans/.test(url))).toBe(true)
  expect(lazy().some((url) => /write-excel-file|export-xlsx-/.test(url))).toBe(true)

  await page.getByTestId('export-protection-zip').check()
  await chooseFormats(page, FORMATS)
  await page.getByTestId('export-include-audit').check()
  await page.getByTestId('export-generate').click()
  const password = await page.getByTestId('export-password').inputValue()
  expect(password).toMatch(/^([A-HJ-NP-Z2-9]{4}-){5}[A-HJ-NP-Z2-9]{4}$/)
  await expect(page.getByTestId('export-password-confirm')).toHaveValue(password)
  await expect(page.getByTestId('export-strength')).toHaveAttribute('data-strength', 'strong')
  const zip = await download(page)
  expect(zip.name).toMatch(NAME('-encrypted.zip'))
  expect(lazy().some((url) => /@zip(\.|_+)js|export-zip-/.test(url))).toBe(true)
  const files = await unzip(zip.bytes, password)
  expect([...files.keys()].sort()).toEqual(
    ['README.txt', 'audit-log.csv', 'moliya.json', 'moliya.jsonl', 'moliya.sqlite', 'moliya.xlsx', 'report.pdf', 'transactions.csv'].sort(),
  )
  expect(files.get('audit-log.csv')).toContain('DATA_EXPORTED')
  await expect(page.getByTestId('export-password')).toHaveValue('')

  await page.getByTestId('export-protection-sqlcipher').check()
  await expect(page.getByTestId('export-format-sqlite')).toBeChecked()
  await expect(page.getByTestId('export-format-csv')).toBeDisabled()
  await page.getByTestId('export-password').fill('ledger-admin-v2')
  await page.getByTestId('export-password-confirm').fill('ledger-admin-v2')
  await page.getByTestId('export-start').click()
  await expect(page.getByTestId('form-error')).toBeVisible()
  const key = 'Maple-Harbor-Quill-Ferry-2027'
  await page.getByTestId('export-password').fill(key)
  await page.getByTestId('export-password-confirm').fill(key)
  const cipher = await download(page)
  expect(cipher.name).toMatch(NAME('-encrypted.sqlite'))
  withSqlite(cipher.bytes, key, (db) => {
    expect(db.prepare('SELECT COUNT(*) AS n FROM transactions').get()).toEqual({ n: 12 })
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
  })

  await page.getByTestId('nav-audit').click()
  await expect(page.getByRole('cell', { name: 'Data exported', exact: true })).toHaveCount(FORMATS.length + 2)
})

test('a manager cannot reach exports', async ({ page }) => {
  await importLedger(page, 'manager@ledger.test', 'ledger-manager-v2')
  await expect(page.getByTestId('nav-backup')).toHaveCount(0)
  await page.evaluate(() => {
    window.location.hash = '#/app/backup'
  })
  await expect(page.getByTestId('forbidden')).toBeVisible()
  await expect(page.getByTestId('export-panel')).toHaveCount(0)
})
