import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Browser, type Locator } from '@playwright/test'
import { addDays, sealSnapshot, type FxSnapshot } from '../../src/domain/fx'
import { base32Decode, importTotpKey, totpAt } from '../../src/lib/totp'
import { watchViolations } from '../support/csp'

// User-guide screenshots only: DOCS_SCREENS=1 writes docs/images/<locale>/*.webp. DOCS_LOCALES=en,ru narrows the run.
const ENABLED = process.env.DOCS_SCREENS === '1'
const ROOT = resolve(process.cwd(), 'docs/images')
const RECORDED = JSON.parse(readFileSync(new URL('../fixtures/fx/snapshot.json', import.meta.url), 'utf8')) as FxSnapshot
const DESKTOP = { width: 1440, height: 900 }
const MOBILE = { width: 390, height: 844 }
const UZS_PER_USD = 12_500

type Locale = 'en' | 'ru' | 'uz-Latn' | 'uz-Cyrl'
type NoteKey =
  | 'salary' | 'rent' | 'groceries' | 'taxi' | 'utilities' | 'pharmacy' | 'course' | 'cinema' | 'clothes' | 'freelance'
  | 'client' | 'equipment' | 'stock' | 'hotel' | 'flight' | 'gift' | 'bazaar' | 'online' | 'dinner'

type Demo = {
  base: 'USD' | 'UZS'
  saved: string
  vault: string
  business: string
  travel: string
  search: string
  searchHelp: string
  notes: Record<NoteKey, string>
  safe: string
  card: string
  wifi: string
  wifiBody: string
  locker: string
}

const DEMO: Record<Locale, Demo> = {
  en: {
    base: 'USD',
    saved: 'Saved',
    vault: 'Karimov family',
    business: 'Family business',
    travel: 'Travel',
    search: 'istanbul',
    searchHelp: 'backup',
    notes: {
      salary: 'Salary, Aziza', rent: 'Apartment rent', groceries: 'Groceries at Korzinka', taxi: 'Taxi to the airport',
      utilities: 'Electricity and gas', pharmacy: 'Pharmacy', course: 'English course for Malika', cinema: 'Cinema with the kids',
      clothes: 'School uniform', freelance: 'Website for a client', client: 'Client payment', equipment: 'Sewing machine',
      stock: 'Fabric stock', hotel: 'Hotel in Istanbul', flight: 'Flights to Istanbul', gift: 'Birthday gift from parents',
      bazaar: 'Chorsu bazaar', online: 'Online design course', dinner: 'Dinner with friends',
    },
    safe: 'Family documents',
    card: 'Family Visa',
    wifi: 'Wi-Fi at home',
    wifiBody: 'Network: Karimovs-5G\nPassword: tulip-orchard-42',
    locker: 'Old locker code',
  },
  ru: {
    base: 'USD',
    saved: 'Сохранено',
    vault: 'Семья Каримовых',
    business: 'Семейный бизнес',
    travel: 'Путешествия',
    search: 'стамбул',
    searchHelp: 'резервн',
    notes: {
      salary: 'Зарплата Азизы', rent: 'Аренда квартиры', groceries: 'Продукты в Корзинке', taxi: 'Такси в аэропорт',
      utilities: 'Свет и газ', pharmacy: 'Аптека', course: 'Английский для Малики', cinema: 'Кино с детьми',
      clothes: 'Школьная форма', freelance: 'Сайт для клиента', client: 'Оплата от клиента', equipment: 'Швейная машина',
      stock: 'Закупка ткани', hotel: 'Отель в Стамбуле', flight: 'Билеты в Стамбул', gift: 'Подарок от родителей',
      bazaar: 'Базар Чорсу', online: 'Онлайн-курс дизайна', dinner: 'Ужин с друзьями',
    },
    safe: 'Семейные документы',
    card: 'Семейная Visa',
    wifi: 'Домашний Wi-Fi',
    wifiBody: 'Сеть: Karimovs-5G\nПароль: tulip-orchard-42',
    locker: 'Старый код шкафчика',
  },
  'uz-Latn': {
    base: 'UZS',
    saved: 'Saqlandi',
    vault: 'Karimovlar oilasi',
    business: 'Oilaviy biznes',
    travel: 'Sayohat',
    search: 'istanbul',
    searchHelp: 'zaxira',
    notes: {
      salary: 'Aziza maoshi', rent: 'Kvartira ijarasi', groceries: 'Korzinkadan oziq-ovqat', taxi: 'Aeroportga taksi',
      utilities: 'Elektr va gaz', pharmacy: 'Dorixona', course: 'Malika uchun ingliz tili kursi', cinema: 'Bolalar bilan kino',
      clothes: 'Maktab formasi', freelance: 'Mijoz uchun veb-sayt', client: 'Mijozdan toʻlov', equipment: 'Tikuv mashinasi',
      stock: 'Gazlama xaridi', hotel: 'Istanbuldagi mehmonxona', flight: 'Istanbulga aviachipta', gift: 'Ota-onadan sovgʻa',
      bazaar: 'Chorsu bozori', online: 'Onlayn dizayn kursi', dinner: 'Doʻstlar bilan kechki ovqat',
    },
    safe: 'Oilaviy hujjatlar',
    card: 'Oilaviy Visa',
    wifi: 'Uydagi Wi-Fi',
    wifiBody: 'Tarmoq: Karimovs-5G\nParol: tulip-orchard-42',
    locker: 'Eski shkafcha kodi',
  },
  'uz-Cyrl': {
    base: 'UZS',
    saved: 'Сақланди',
    vault: 'Каримовлар оиласи',
    business: 'Оилавий бизнес',
    travel: 'Саёҳат',
    search: 'истанбул',
    searchHelp: 'захира',
    notes: {
      salary: 'Азиза маоши', rent: 'Квартира ижараси', groceries: 'Корзинкадан озиқ-овқат', taxi: 'Аэропортга такси',
      utilities: 'Электр ва газ', pharmacy: 'Дорихона', course: 'Малика учун инглиз тили курси', cinema: 'Болалар билан кино',
      clothes: 'Мактаб формаси', freelance: 'Мижоз учун веб-сайт', client: 'Мижоздан тўлов', equipment: 'Тикув машинаси',
      stock: 'Газлама хариди', hotel: 'Истанбулдаги меҳмонхона', flight: 'Истанбулга авиачипта', gift: 'Ота-онадан совға',
      bazaar: 'Чорсу бозори', online: 'Онлайн дизайн курси', dinner: 'Дўстлар билан кечки овқат',
    },
    safe: 'Оилавий ҳужжатлар',
    card: 'Оилавий Visa',
    wifi: 'Уйдаги Wi-Fi',
    wifiBody: 'Тармоқ: Karimovs-5G\nПарол: tulip-orchard-42',
    locker: 'Эски шкафча коди',
  },
}

const ADMIN = { email: 'aziza@example.com', password: 'Quiet cedar morning 42' }
const MEMBER = { email: 'rustam@example.com', temporary: 'Temporary maple kettle 7' }
const INVITED = { email: 'dilnoza@example.com', password: 'Bright river window 19' }
const CARD_NUMBER = '4111 1111 1111 1111'

/** BASE is the vault currency; OTHER is UZS in a dollar vault and dollars in a sum vault. Amounts are in dollars. */
type Entry = { daysAgo: number; type: 'INCOME' | 'EXPENSE'; category: number; amount: number; currency: 'BASE' | 'OTHER' | 'EUR' | 'RUB'; group: 0 | 1 | 2; note: NoteKey }

// Category indexes follow the seeded order: income Salary, Freelance, Investment, Gift, Other; expense Food, Transport, Housing, Utilities, Health, Education, Entertainment, Shopping, Other.
const ENTRIES: Entry[] = [
  { daysAgo: 92, type: 'INCOME', category: 0, amount: 2400, currency: 'BASE', group: 0, note: 'salary' },
  { daysAgo: 91, type: 'EXPENSE', category: 2, amount: 700, currency: 'BASE', group: 0, note: 'rent' },
  { daysAgo: 88, type: 'EXPENSE', category: 0, amount: 120, currency: 'BASE', group: 0, note: 'groceries' },
  { daysAgo: 80, type: 'INCOME', category: 1, amount: 1800, currency: 'BASE', group: 1, note: 'client' },
  { daysAgo: 76, type: 'EXPENSE', category: 8, amount: 870.25, currency: 'BASE', group: 1, note: 'stock' },
  { daysAgo: 62, type: 'INCOME', category: 0, amount: 2400, currency: 'BASE', group: 0, note: 'salary' },
  { daysAgo: 61, type: 'EXPENSE', category: 2, amount: 700, currency: 'BASE', group: 0, note: 'rent' },
  { daysAgo: 57, type: 'EXPENSE', category: 1, amount: 410, currency: 'BASE', group: 2, note: 'flight' },
  { daysAgo: 55, type: 'EXPENSE', category: 2, amount: 320, currency: 'EUR', group: 2, note: 'hotel' },
  { daysAgo: 50, type: 'INCOME', category: 3, amount: 200, currency: 'BASE', group: 0, note: 'gift' },
  { daysAgo: 44, type: 'EXPENSE', category: 3, amount: 92, currency: 'BASE', group: 0, note: 'utilities' },
  { daysAgo: 40, type: 'EXPENSE', category: 0, amount: 28, currency: 'OTHER', group: 0, note: 'bazaar' },
  { daysAgo: 31, type: 'INCOME', category: 0, amount: 2400, currency: 'BASE', group: 0, note: 'salary' },
  { daysAgo: 30, type: 'EXPENSE', category: 2, amount: 700, currency: 'BASE', group: 0, note: 'rent' },
  { daysAgo: 27, type: 'EXPENSE', category: 5, amount: 250, currency: 'BASE', group: 0, note: 'course' },
  { daysAgo: 24, type: 'EXPENSE', category: 5, amount: 9900, currency: 'RUB', group: 1, note: 'online' },
  { daysAgo: 22, type: 'EXPENSE', category: 8, amount: 1210, currency: 'OTHER', group: 1, note: 'equipment' },
  { daysAgo: 20, type: 'INCOME', category: 1, amount: 950, currency: 'BASE', group: 1, note: 'client' },
  { daysAgo: 18, type: 'EXPENSE', category: 7, amount: 129, currency: 'BASE', group: 0, note: 'clothes' },
  { daysAgo: 15, type: 'EXPENSE', category: 4, amount: 38, currency: 'BASE', group: 0, note: 'pharmacy' },
  { daysAgo: 12, type: 'INCOME', category: 1, amount: 650, currency: 'BASE', group: 0, note: 'freelance' },
  { daysAgo: 10, type: 'EXPENSE', category: 3, amount: 85, currency: 'BASE', group: 0, note: 'utilities' },
  { daysAgo: 8, type: 'EXPENSE', category: 6, amount: 45, currency: 'EUR', group: 0, note: 'cinema' },
  { daysAgo: 5, type: 'EXPENSE', category: 1, amount: 62, currency: 'BASE', group: 0, note: 'taxi' },
  { daysAgo: 2, type: 'EXPENSE', category: 0, amount: 184.5, currency: 'BASE', group: 0, note: 'groceries' },
  { daysAgo: 1, type: 'EXPENSE', category: 2, amount: 700, currency: 'BASE', group: 0, note: 'rent' },
  { daysAgo: 0, type: 'INCOME', category: 0, amount: 2400, currency: 'BASE', group: 0, note: 'salary' },
]

function isoDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function daysFromToday(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return isoDay(date)
}

function freshSnapshot(): string {
  const { digest: _digest, ...body } = structuredClone(RECORDED)
  const date = isoDay(new Date())
  body.generatedAt = new Date().toISOString()
  body.quotes = body.quotes.map((quote) => ({ ...quote, date, previous: quote.previous ? { ...quote.previous, date: addDays(date, -3) } : null }))
  return JSON.stringify(sealSnapshot(body))
}

function money(entry: Entry, base: Demo['base']): { amount: string; currency: string } {
  const sum = (dollars: number) => String(Math.round((dollars * UZS_PER_USD) / 1000) * 1000)
  if (entry.currency === 'EUR' || entry.currency === 'RUB') return { amount: String(entry.amount), currency: entry.currency }
  const inSum = (entry.currency === 'BASE') === (base === 'UZS')
  return inSum ? { amount: sum(entry.amount), currency: 'UZS' } : { amount: String(entry.amount), currency: 'USD' }
}

function totpCode(secret: string, offsetMs = 0): Promise<string> {
  return importTotpKey(base32Decode(secret)).then((key) => totpAt(key, Date.now() + offsetMs))
}

/** Screenshots go through a blank page in its own context, so the WebP encoder never runs under the app's policy. */
async function webpEncoder(browser: Browser) {
  const context = await browser.newContext()
  const page = await context.newPage()
  return {
    async encode(png: Buffer, maxWidth: number): Promise<Buffer> {
      const out = await page.evaluate(
        async ({ data, maxWidth }) => {
          const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
          const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
          const scale = Math.min(1, maxWidth / bitmap.width)
          const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale))
          const context = canvas.getContext('2d')!
          context.imageSmoothingQuality = 'high'
          context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
          const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 })
          const view = new Uint8Array(await blob.arrayBuffer())
          let text = ''
          for (let index = 0; index < view.length; index += 0x8000) text += String.fromCharCode(...view.subarray(index, index + 0x8000))
          return btoa(text)
        },
        { data: png.toString('base64'), maxWidth },
      )
      return Buffer.from(out, 'base64')
    },
    close: () => context.close(),
  }
}

const LOCALES = (process.env.DOCS_LOCALES?.split(',') ?? ['en', 'ru', 'uz-Latn', 'uz-Cyrl']) as Locale[]

test.use({ actionTimeout: 30_000, navigationTimeout: 60_000 })

for (const locale of LOCALES) {
  test(`user guide screenshots: ${locale}`, async ({ page, context, browser }) => {
    test.skip(!ENABLED, 'set DOCS_SCREENS=1 to take the user-guide screenshots')
    test.setTimeout(15 * 60_000)
    const demo = DEMO[locale]
    const dir = resolve(ROOT, locale)
    mkdirSync(dir, { recursive: true })
    for (const file of readdirSync(dir)) if (file.endsWith('.webp')) rmSync(resolve(dir, file))
    const encoder = await webpEncoder(browser)
    const taken: string[] = []
    const violations = await watchViolations(page)
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await context.route('**/rates/latest.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: freshSnapshot() }))
    await page.setViewportSize(DESKTOP)

    async function shot(name: string, options: { target?: Locator; full?: boolean } = {}) {
      if (await page.getByTestId('save-state').count()) await settle()
      await page.mouse.move(0, 0)
      if (!options.target) await page.evaluate(() => window.scrollTo(0, 0))
      await page.evaluate(() => document.fonts.ready)
      const png = options.target
        ? await options.target.screenshot({ animations: 'disabled' })
        : await page.screenshot({ fullPage: options.full ?? false, animations: 'disabled' })
      writeFileSync(resolve(dir, `${name}.webp`), await encoder.encode(png, 1440))
      taken.push(name)
    }

    async function dismissReminder() {
      const reminder = page.getByTestId('backup-reminder')
      if (await reminder.count()) await reminder.getByRole('button').click()
    }

    async function theme(mode: 'light' | 'dark') {
      await page.getByTestId(`theme-${mode}`).click()
      if (mode === 'dark') await expect(page.locator('html')).toHaveClass(/dark/)
      else await expect(page.locator('html')).not.toHaveClass(/dark/)
    }

    async function settle() {
      await expect(page.getByTestId('save-state')).toHaveText(demo.saved, { timeout: 30_000 })
    }

    async function lock() {
      await settle()
      await page.getByTestId('lock-vault').click()
      await expect(page.getByTestId('login-email')).toBeVisible({ timeout: 30_000 })
    }

    async function signIn(email: string, password: string) {
      await page.getByTestId('login-email').fill(email)
      await page.getByTestId('login-password').fill(password)
      await page.getByTestId('login-submit').click()
    }

    async function addEntry(entry: Entry, groups: string[]) {
      const { amount, currency } = money(entry, demo.base)
      await page.getByTestId('add-transaction').click()
      await page.getByTestId('tx-type').selectOption(entry.type)
      await page.getByTestId('tx-amount').fill(amount)
      await page.getByTestId('tx-category').selectOption({ index: entry.category })
      await page.getByTestId('tx-date').fill(daysFromToday(-entry.daysAgo))
      await page.getByTestId('tx-currency').selectOption(currency)
      await page.getByTestId('tx-group').selectOption({ label: groups[entry.group] })
      await page.getByTestId('tx-notes').fill(demo.notes[entry.note])
      await page.getByTestId('tx-save').click()
      await expect(page.getByTestId('tx-save')).toHaveCount(0)
    }

    async function choosePeriod() {
      const start = new Date()
      start.setDate(start.getDate() - 100)
      if (start.getFullYear() === new Date().getFullYear()) {
        await page.getByTestId('period-ytd').click()
        return
      }
      await page.getByTestId('period-custom').click()
      await page.getByTestId('period-from').fill(isoDay(new Date(start.getFullYear(), start.getMonth(), 1)))
      await page.getByTestId('period-to').fill(isoDay(new Date()))
    }

    // Setting up and the first look.
    await page.goto('/')
    await page.getByTestId('language-select').selectOption(locale)
    await theme('light')
    await page.getByTestId('setup-name').fill(demo.vault)
    await page.getByTestId('setup-email').fill(ADMIN.email)
    await page.getByTestId('setup-currency').selectOption(demo.base)
    await page.getByTestId('setup-password').fill(ADMIN.password)
    await page.getByTestId('setup-confirm').fill(ADMIN.password)
    await shot('setup')
    await page.getByTestId('setup-submit').click()
    await expect(page.getByTestId('kpi-net')).toBeVisible({ timeout: 60_000 })
    await shot('dashboard-empty')

    // Groups first, so records can go into them.
    await page.getByTestId('nav-groups').click()
    for (const name of [demo.business, demo.travel]) {
      await page.getByTestId('group-name').fill(name)
      await page.getByTestId('group-save').click()
      await expect(page.locator(`[data-testid="group-row"][data-group="${name}"]`)).toBeVisible()
    }
    const groups = [demo.vault, demo.business, demo.travel]

    await page.getByTestId('nav-transactions').click()
    for (const entry of ENTRIES) await addEntry(entry, groups)
    await choosePeriod()
    await expect(page.getByTestId('tx-row').first()).toBeVisible()
    await settle()

    // Dashboard.
    await page.getByTestId('nav-dashboard').click()
    await choosePeriod()
    await expect(page.getByTestId('fx-pair').first()).toBeVisible()
    await expect(page.getByTestId('chart-monthly')).toBeVisible()
    await shot('backup-reminder', { target: page.getByTestId('backup-reminder') })
    await dismissReminder()
    await shot('dashboard')
    await shot('dashboard-kpis', { target: page.getByTestId('kpi-net').locator('xpath=..') })
    await shot('period-presets', { target: page.getByTestId('period-ytd').locator('xpath=../..') })
    await page.getByTestId('dashboard-group').selectOption({ label: demo.business })
    await expect(page.getByTestId('kpi-income')).not.toHaveAttribute('data-amount', '0')
    await shot('dashboard-group-filter')
    await page.getByTestId('dashboard-group').selectOption({ index: 0 })
    await shot('exchange-rates', { target: page.getByTestId('fx-panel') })
    await page.getByTestId('fx-amount').fill('100')
    await expect(page.getByTestId('fx-result')).toBeVisible()
    await shot('converter', { target: page.getByTestId('fx-converter') })
    await page.getByTestId('period-custom').click()
    await shot('period-custom', { target: page.getByTestId('period-custom').locator('xpath=../..') })
    await choosePeriod()

    // The ledger.
    await page.getByTestId('nav-transactions').click()
    await choosePeriod()
    await shot('transactions')
    await page.getByTestId('add-transaction').click()
    await page.getByTestId('tx-type').selectOption('EXPENSE')
    await page.getByTestId('tx-amount').fill(money({ ...ENTRIES[0], amount: 58, currency: 'BASE' }, demo.base).amount)
    await page.getByTestId('tx-category').selectOption({ index: 0 })
    await page.getByTestId('tx-notes').fill(demo.notes.dinner)
    await shot('transaction-add')
    await page.getByTestId('tx-save').click()
    await expect(page.getByTestId('tx-save')).toHaveCount(0)
    const dinner = page.getByTestId('tx-row').filter({ hasText: demo.notes.dinner })
    await dinner.locator('[data-testid^="edit-amount-"]').click()
    await dinner.locator('[data-testid^="editor-amount-"]').fill(money({ ...ENTRIES[0], amount: 64, currency: 'BASE' }, demo.base).amount)
    await shot('transaction-inline-edit', { target: page.getByTestId('table-transactions') })
    await dinner.locator('[data-testid^="editor-amount-"]').press('Enter')
    await dinner.locator('[data-testid^="delete-"]').click()
    await expect(page.getByTestId('confirm-delete')).toBeVisible()
    await shot('transaction-delete')
    await page.getByTestId('confirm-delete').click()
    await expect(dinner).toHaveCount(0)
    await page.getByTestId('transactions-search').fill(demo.search)
    await expect(page.getByTestId('tx-row')).toHaveCount(2)
    await shot('transactions-search')
    await page.getByTestId('transactions-search').press('Escape')
    await page.getByTestId('transactions-filters-toggle').click()
    await expect(page.getByTestId('transactions-filters')).toBeVisible()
    await shot('transactions-filters')
    await page.getByTestId('transactions-filters-toggle').click()
    await page.getByTestId('transactions-columns').click()
    await shot('transactions-columns')
    await page.keyboard.press('Escape')
    await page.getByTestId('transactions-export').click()
    await expect(page.getByTestId('transactions-export-start')).toBeVisible()
    await shot('transactions-export')
    await page.keyboard.press('Escape')

    // Groups and the ledger link.
    await page.getByTestId('nav-groups').click()
    await choosePeriod()
    await expect(page.getByTestId('group-summary-total')).toBeVisible()
    await shot('groups')
    await page.locator(`[data-testid="group-row"][data-group="${demo.travel}"]`).getByTestId('group-ledger-link').click()
    await expect(page.getByTestId('tx-row')).toHaveCount(2)
    await shot('group-ledger-link')

    // People.
    await page.getByTestId('nav-users').click()
    await page.getByTestId('user-add').click()
    await page.getByTestId('advanced-temp-toggle').click()
    await page.getByTestId('user-email').fill(MEMBER.email)
    await page.getByTestId('user-password').fill(MEMBER.temporary)
    await page.getByTestId('user-role').selectOption('Manager')
    await page.getByTestId('user-group').selectOption({ label: demo.business })
    await shot('user-create')
    await page.getByTestId('user-save').click()
    const member = page.getByTestId('person-row').filter({ hasText: MEMBER.email })
    await expect(member).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('user-add').click()
    await page.getByTestId('invite-email').fill(INVITED.email)
    await page.getByTestId('invite-role').selectOption('Viewer')
    await page.getByTestId('invite-create').click()
    await expect(page.getByTestId('issued-code-panel')).toBeVisible({ timeout: 30_000 })
    await shot('invite-code', { target: page.getByTestId('issued-code-panel') })
    await page.getByTestId('copy-link').click()
    const inviteLink = await page.evaluate(() => navigator.clipboard.readText())
    await page.getByTestId('code-done').click()
    await member.getByTestId('user-issue-reset').click()
    await expect(member.getByTestId('reset-issue-save')).toBeVisible()
    await shot('user-reset-code', { target: member })
    await member.getByTestId('user-issue-reset').click()
    await shot('users')
    await shot('users-full', { full: true })
    await page.getByTestId('clock-floor').locator('summary').click()
    await shot('clock-floor', { target: page.getByTestId('clock-floor') })

    // Safes.
    await page.getByTestId('nav-safes').click()
    await page.getByTestId('safes-setup-password').fill(ADMIN.password)
    await page.getByTestId('recovery-yes').check()
    await shot('safes-setup')
    await page.getByTestId('safes-setup-submit').click()
    const recovery = page.getByTestId('recovery-code')
    await expect(recovery).toBeVisible({ timeout: 30_000 })
    await shot('safes-recovery-code')
    const code = (await recovery.textContent())!.trim()
    await page.getByTestId('recovery-confirm').fill(code.replace(/[^0-9A-Z]/gi, '').slice(-4))
    await page.getByTestId('recovery-done').click()
    await expect(page.getByTestId('safe-card')).toHaveCount(1, { timeout: 30_000 })
    await page.getByTestId('safe-card').first().click()
    await expect(page.getByTestId('safe-title')).toBeVisible()

    await page.getByTestId('add-card').click()
    await page.getByTestId('item-title').fill(demo.card)
    await page.getByTestId('card-number').fill(CARD_NUMBER)
    await page.getByTestId('card-holder').fill('AZIZA KARIMOVA')
    await page.getByTestId('card-exp-month').selectOption('8')
    await page.getByTestId('card-exp-year').selectOption(String(new Date().getFullYear() + 3))
    await page.getByTestId('card-bank').fill('Kapitalbank')
    await page.getByTestId('card-add-cvv').click()
    await page.getByTestId('card-cvv').fill('737')
    await shot('safe-add-card', { target: page.getByTestId('item-dialog') })
    await page.getByTestId('item-submit').click()
    await expect(page.getByTestId('card-number-value')).toHaveText('•••• •••• •••• 1111')
    await shot('safe-card')
    await page.getByTestId('card-number-value-reveal').click()
    await expect(page.getByTestId('card-number-value')).toHaveText(CARD_NUMBER)
    await shot('safe-card-revealed', { target: page.getByTestId('item-detail') })

    await page.getByTestId('add-subscription').click()
    await page.getByTestId('item-title').fill('Netflix')
    await page.getByTestId('sub-amount').fill('9.99')
    await page.getByTestId('sub-currency').selectOption('USD')
    await page.getByTestId('sub-cycle').selectOption('MONTHLY')
    await page.getByTestId('sub-anchor').fill(daysFromToday(4))
    await page.getByTestId('sub-card').selectOption({ label: demo.card })
    await shot('safe-add-subscription', { target: page.getByTestId('item-dialog') })
    await page.getByTestId('item-submit').click()
    await expect(page.getByTestId('sub-next')).toBeVisible()
    await shot('safe-subscription')

    await page.getByTestId('add-note').click()
    await page.getByTestId('item-title').fill(demo.wifi)
    await page.getByTestId('note-body').fill(demo.wifiBody)
    await page.getByTestId('item-submit').click()
    await expect(page.getByTestId('note-body-value')).toBeVisible()
    await page.getByTestId('item-favorite').click()
    await page.getByTestId('add-note').click()
    await page.getByTestId('item-title').fill(demo.locker)
    await page.getByTestId('note-body').fill('5591')
    await page.getByTestId('item-submit').click()
    await expect(page.getByTestId('safe-item')).toHaveCount(4)
    await shot('safe-view')
    await page.getByTestId('item-trash').click()
    await expect(page.getByTestId('safe-item')).toHaveCount(3)

    await page.getByTestId('safe-back').click()
    await page.getByTestId('safe-new').click()
    await page.getByTestId('safe-name').fill(demo.safe)
    await page.getByTestId('safe-require-password').check()
    await shot('safe-create', { target: page.getByTestId('safe-create-dialog') })
    await page.getByTestId('safe-submit').click()
    await expect(page.getByTestId('safe-create-dialog')).toHaveCount(0)
    await expect(page.getByTestId('safe-title')).toContainText(demo.safe)
    await page.getByTestId('safe-back').click()
    await expect(page.getByTestId('safe-grid')).toBeVisible()
    await expect(page.getByTestId('safe-card')).toHaveCount(2)
    await expect(page.getByTestId('upcoming-payment')).toHaveCount(1)
    await shot('safes-home')
    await page.getByTestId('safes-trash-link').click()
    await expect(page.getByTestId('safes-trash')).toBeVisible()
    await shot('safes-trash')
    await page.getByTestId('nav-safes').click()
    await page.getByTestId('safes-activity-link').click()
    await expect(page.getByTestId('safe-event').first()).toBeVisible()
    await shot('safes-activity')
    await page.getByTestId('nav-safes').click()
    await page.getByTestId('safe-card').filter({ hasText: demo.safe }).click()
    await page.getByTestId('safe-close').click()
    await expect(page.getByTestId('safe-grid')).toBeVisible()
    await page.getByTestId('safe-card').filter({ hasText: demo.safe }).click()
    await expect(page.getByTestId('safe-open-password')).toBeVisible()
    await shot('safe-open-password')
    await page.getByTestId('safe-open-password').fill(ADMIN.password)
    await page.getByTestId('safe-open-submit').click()
    await expect(page.getByTestId('safe-title')).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('nav-safes').click()
    await page.getByTestId('safes-lock').click()
    await expect(page.getByTestId('safes-unlock')).toBeVisible()
    await shot('safes-unlock')
    await page.getByTestId('safes-unlock-password').fill(ADMIN.password)
    await page.getByTestId('safes-unlock-submit').click()
    await expect(page.getByTestId('safe-grid')).toBeVisible({ timeout: 30_000 })

    // Health, before the first backup so the backup row asks for one.
    await page.getByTestId('nav-health').click()
    await expect(page.getByTestId('health-overall')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-testid="health-check"][data-id="backup"]')).toHaveAttribute('data-status', 'warn')
    await shot('health')
    await shot('health-warning', { target: page.locator('[data-testid="health-check"][data-id="backup"]') })

    // Backups.
    await page.getByTestId('nav-backup').click()
    const pending = page.waitForEvent('download')
    await page.getByTestId('export-backup').click()
    const download = await pending
    const backupFile = test.info().outputPath(download.suggestedFilename())
    await download.saveAs(backupFile)
    await expect(page.getByTestId('last-backup')).not.toBeEmpty()
    await shot('backup-full', { full: true })
    await shot('backup-export', { target: page.getByTestId('export-panel') })
    await page.getByTestId('replace-panel').locator('[data-testid="import-file"]').setInputFiles(backupFile)
    await expect(page.getByTestId('import-summary')).toBeVisible({ timeout: 30_000 })
    await shot('backup-import', { target: page.getByTestId('replace-panel') })

    // Settings, account, audit, help.
    await page.getByTestId('nav-settings').click()
    await shot('settings')
    await page.getByTestId('nav-account').click()
    await shot('account-full', { full: true })
    await shot('preferences', { target: page.locator('header') })
    await page.getByTestId('nav-audit').click()
    await expect(page.getByTestId('audit-integrity')).toHaveAttribute('data-ok', 'true')
    await shot('audit')
    await page.getByTestId('nav-help').click()
    await expect(page.getByTestId('help-section').first()).toBeVisible({ timeout: 30_000 })
    await shot('help')
    await page.getByTestId('help-search').fill(demo.searchHelp)
    await expect(page.getByTestId('help-results')).toBeVisible()
    await shot('help-search')

    // Dark examples.
    await theme('dark')
    await page.getByTestId('nav-dashboard').click()
    await choosePeriod()
    await expect(page.getByTestId('chart-monthly')).toBeVisible()
    await shot('dark-dashboard')
    await page.getByTestId('nav-transactions').click()
    await shot('dark-transactions')
    await page.getByTestId('nav-safes').click()
    await page.getByTestId('safe-card').first().click()
    await page.getByTestId('safe-item').filter({ hasText: demo.card }).click()
    await shot('dark-safe')
    await page.getByTestId('nav-health').click()
    await expect(page.getByTestId('health-overall')).toBeVisible({ timeout: 30_000 })
    await shot('dark-health')
    await theme('light')

    // Phone-sized screens.
    await page.setViewportSize(MOBILE)
    await page.getByTestId('nav-dashboard').click()
    await expect(page.getByTestId('kpi-net')).toBeVisible()
    await shot('mobile-dashboard')
    const toggle = page.getByTestId('sidebar-toggle')
    if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
    await shot('mobile-menu')
    await page.getByTestId('nav-transactions').click()
    await expect(page.getByTestId('tx-row').first()).toBeVisible()
    await shot('mobile-transactions')
    await page.getByTestId('nav-safes').click()
    await expect(page.getByTestId('safe-grid')).toBeVisible()
    await shot('mobile-safes')
    await page.getByTestId('nav-health').click()
    await expect(page.getByTestId('health-overall')).toBeVisible({ timeout: 30_000 })
    await shot('mobile-health')
    await page.setViewportSize(DESKTOP)

    // Two-step sign-in, then the lock screen.
    await page.getByTestId('nav-account').click()
    await page.getByTestId('totp-start').click()
    const secret = (await page.getByTestId('totp-secret').textContent())!.replace(/\s/g, '')
    await expect(page.getByTestId('totp-setup').getByRole('img')).toBeVisible()
    await shot('account-totp', { target: page.getByTestId('sign-in-check') })
    await page.getByTestId('totp-setup-code').fill(await totpCode(secret))
    await page.getByTestId('totp-setup-password').fill(ADMIN.password)
    await page.getByTestId('totp-confirm').click()
    await expect(page.getByTestId('totp-recovery').locator('li')).toHaveCount(10, { timeout: 30_000 })
    await shot('account-totp-recovery', { target: page.getByTestId('sign-in-check') })
    await page.getByTestId('totp-recovery-done').click()
    await lock()
    await shot('sign-in')
    await signIn(ADMIN.email, ADMIN.password)
    await expect(page.getByTestId('totp-code')).toBeVisible({ timeout: 30_000 })
    await shot('sign-in-totp')
    await page.getByTestId('totp-code').fill(await totpCode(secret, 30_000))
    await page.getByTestId('totp-submit').click()
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 })
    await lock()

    // Joining with an invitation, and what a viewer sees.
    await page.goto(inviteLink)
    await expect(page.getByTestId('register-email')).toHaveValue(INVITED.email, { timeout: 30_000 })
    await page.getByTestId('register-password').fill(INVITED.password)
    await page.getByTestId('register-confirm').fill(INVITED.password)
    await shot('register')
    await page.getByTestId('register-submit').click()
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 60_000 })
    await dismissReminder()
    await expect(page.getByTestId('kpi-net')).toBeVisible()
    await shot('viewer-dashboard')
    await page.getByTestId('nav-health').click()
    await expect(page.getByTestId('health-overall')).toBeVisible({ timeout: 30_000 })
    await shot('viewer-health')
    await lock()

    // Before signing in: help, health and a page that does not exist.
    await page.getByTestId('health-entry').click()
    await expect(page.getByTestId('health-overall')).toBeVisible({ timeout: 30_000 })
    await shot('health-signed-out')
    await page.goto('/#/help')
    await expect(page.getByTestId('help-section').first()).toBeVisible({ timeout: 30_000 })
    await shot('help-signed-out')
    await page.goto('/#/no-such-page')
    await expect(page.getByTestId('not-found')).toBeVisible()
    await shot('not-found')

    // A new version on the server; the banner only appears in a production build.
    const production = (await page.locator('meta[http-equiv="Content-Security-Policy"]').count()) > 0
    if (production) {
      await page.route('**/version.json', async (route) => {
        const response = await route.fetch()
        const body = (await response.json()) as Record<string, unknown>
        await route.fulfill({ response, json: { ...body, version: '9.9.9', commit: 'f00dfeed' } })
      })
      await page.goto('/')
      await expect(page.getByTestId('update-banner')).toBeVisible({ timeout: 30_000 })
      await shot('update-banner')
      await page.unroute('**/version.json')
    }

    // Moving to a new device: a fresh browser profile restores the backup file.
    const fresh = await browser.newContext({ viewport: DESKTOP })
    const other = await fresh.newPage()
    await other.goto(page.url().replace(/#.*$/, ''))
    await other.getByTestId('language-select').selectOption(locale)
    await other.getByTestId('import-file').setInputFiles(backupFile)
    await expect(other.getByTestId('confirm-import')).toBeVisible({ timeout: 30_000 })
    await other.mouse.move(0, 0)
    writeFileSync(resolve(dir, 'move-import.webp'), await encoder.encode(await other.screenshot({ fullPage: true, animations: 'disabled' }), 1440))
    taken.push('move-import')
    await fresh.close()

    await encoder.close()
    console.log(`${locale}: ${taken.length} screenshots`)
    expect(await violations()).toEqual([])
  })
}
