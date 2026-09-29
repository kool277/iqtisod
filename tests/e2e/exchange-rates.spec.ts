import { readFileSync } from 'node:fs'
import { expect, test, type Page, type Route } from '@playwright/test'
import { addDays, sealSnapshot, type FxSnapshot } from '../../src/domain/fx'

const RECORDED = JSON.parse(readFileSync(new URL('../fixtures/fx/snapshot.json', import.meta.url), 'utf8')) as FxSnapshot

function localToday(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function snapshotAged(days: number): string {
  const { digest: _digest, ...body } = structuredClone(RECORDED)
  const date = addDays(localToday(), -days)
  body.generatedAt = new Date().toISOString()
  body.quotes = body.quotes.map((quote) => ({
    ...quote,
    date,
    previous: quote.previous ? { ...quote.previous, date: addDays(date, -3) } : null,
  }))
  return JSON.stringify(sealSnapshot(body))
}

type Reply = { body: string } | { status: number } | 'abort'

async function serveRates(page: Page, reply: Reply) {
  const context = page.context()
  await context.unroute('**/rates/latest.json')
  await context.route('**/rates/latest.json', (route: Route) => {
    if (reply === 'abort') return route.abort('internetdisconnected')
    if ('status' in reply) return route.fulfill({ status: reply.status, body: 'unavailable' })
    return route.fulfill({ status: 200, contentType: 'application/json', body: reply.body })
  })
}

async function createVault(page: Page) {
  await page.goto('/')
  await page.getByTestId('setup-name').fill('Home')
  await page.getByTestId('setup-email').fill('admin@example.com')
  await page.getByTestId('setup-password').fill('Correct horse lantern 7')
  await page.getByTestId('setup-confirm').fill('Correct horse lantern 7')
  await page.getByTestId('setup-submit').click()
  await expect(page.getByTestId('kpi-net')).toBeVisible({ timeout: 30_000 })
}

async function convert(page: Page, direction: string, amount: string) {
  await page.getByTestId('fx-direction').selectOption(direction)
  await page.getByTestId('fx-amount').fill(amount)
  return page.getByTestId('fx-result')
}

test('shows official rates for all six directions and converts exactly', async ({ page }) => {
  await serveRates(page, { body: snapshotAged(0) })
  await createVault(page)

  const panel = page.getByTestId('fx-panel')
  await expect(panel.getByTestId('fx-pair')).toHaveCount(3)
  const expected: Record<string, string> = {
    'USD-UZS': '11806.97',
    'UZS-USD': '0.0000846957',
    'USD-KRW': '1357.93',
    'KRW-USD': '0.000736416',
    'USD-ILS': '3.066',
    'ILS-USD': '0.326158',
  }
  for (const [direction, rate] of Object.entries(expected)) {
    await expect(panel.getByTestId(`fx-rate-${direction}`)).toHaveAttribute('data-rate', rate)
  }
  await expect(panel.getByTestId('fx-rate-USD-UZS')).toContainText('1 USD = 11,806.97 UZS')
  await expect(panel.getByTestId('fx-rate-UZS-USD').getByTestId('fx-nominal')).toHaveText('100,000 UZS = 8.47 USD')
  await expect(panel.getByTestId('fx-rate-USD-UZS').getByTestId('fx-change')).toHaveAttribute('data-change', '-0.16')
  await expect(panel.getByTestId('fx-rate-UZS-USD').getByTestId('fx-change')).toHaveAttribute('data-change', '0.16')
  await expect(panel.getByTestId('fx-source')).toHaveText(['Central Bank of Uzbekistan', 'European Central Bank', 'Bank of Israel'])
  await expect(panel.getByTestId('fx-source').first()).toHaveAttribute('href', 'https://cbu.uz/en/arkhiv-kursov-valyut/')
  await expect(panel.getByTestId('fx-stale')).toHaveCount(0)
  await expect(panel.getByTestId('fx-disclaimer')).toHaveText(
    'Official central-bank reference rates for information only; bank buy/sell rates differ.',
  )

  const result = page.getByTestId('fx-result')
  await expect(result).toHaveAttribute('data-amount', '1180697.00')
  await convert(page, 'USD-UZS', '1234.5')
  await expect(result).toHaveAttribute('data-amount', '14575704.46')
  await expect(result).toHaveAttribute('data-exact', '14575704.465')
  await expect(result).toContainText('14,575,704.46 UZS')
  await convert(page, 'UZS-USD', '1 000 000')
  await expect(result).toHaveAttribute('data-amount', '84.70')
  await expect(result).toHaveAttribute('data-exact', '84.695734807490829569')
  await convert(page, 'USD-KRW', '1000000000')
  await expect(result).toHaveAttribute('data-amount', '1357927579539')
  await convert(page, 'ILS-USD', '100')
  await expect(result).toHaveAttribute('data-amount', '32.62')
  await page.getByTestId('fx-swap').click()
  await expect(page.getByTestId('fx-direction')).toHaveValue('USD-ILS')
  await expect(result).toHaveAttribute('data-amount', '306.60')
  await convert(page, 'KRW-USD', '1.5')
  await expect(page.getByTestId('fx-amount-error')).toHaveText('Too many decimal places for this currency.')
  await expect(result).toHaveAttribute('data-amount', '')

  await page.getByTestId('language-select').selectOption('uz-Latn')
  await expect(panel.getByRole('heading', { name: 'Valyuta kurslari' })).toBeVisible()
  await expect(panel.getByTestId('fx-rate-USD-UZS')).toHaveAttribute('data-rate', '11806.97')
  await page.getByTestId('language-select').selectOption('en')

  await page.setViewportSize({ width: 360, height: 800 })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  expect((await page.getByTestId('app-shell').locator('header').boundingBox())?.height).toBe(40)
})

test('flags rates older than two business days as stale', async ({ page }) => {
  await serveRates(page, { body: snapshotAged(10) })
  await createVault(page)
  await expect(page.getByTestId('fx-pair')).toHaveCount(3)
  await expect(page.getByTestId('fx-stale')).toHaveCount(3)
  await expect(page.getByTestId('fx-pair').first()).toHaveAttribute('data-stale', 'true')
})

test('never blocks the dashboard: error, retry, cached fallback, and offline states', async ({ page }) => {
  await serveRates(page, { status: 503 })
  await createVault(page)
  await expect(page.getByTestId('fx-error')).toHaveText(/Exchange rates are unavailable right now\./)
  await expect(page.getByTestId('kpi-income')).toBeVisible()

  await serveRates(page, { body: snapshotAged(0) })
  await page.getByTestId('fx-retry').click()
  await expect(page.getByTestId('fx-pair')).toHaveCount(3)
  expect(await page.evaluate(() => localStorage.getItem('moliya.fx.snapshot.v1'))).toContain('"schema":1')

  await serveRates(page, { status: 503 })
  await page.getByTestId('nav-transactions').click()
  await expect(page.getByTestId('fx-panel')).toHaveCount(0)
  await page.getByTestId('nav-dashboard').click()
  await expect(page.getByTestId('fx-notice')).toHaveAttribute('data-failure', 'unavailable')
  await expect(page.getByTestId('fx-pair')).toHaveCount(3)

  await serveRates(page, 'abort')
  await page.context().setOffline(true)
  await page.getByTestId('fx-refresh').click()
  await expect(page.getByTestId('fx-notice')).toHaveAttribute('data-failure', 'offline')
  await expect(page.getByTestId('fx-notice')).toContainText('You are offline. Showing the last saved rates.')

  await serveRates(page, { body: snapshotAged(0) })
  await page.context().setOffline(false)
  await expect(page.getByTestId('fx-notice')).toHaveCount(0)
})

test('rejects a tampered snapshot instead of showing wrong numbers', async ({ page }) => {
  await serveRates(page, { body: snapshotAged(0).replace('"11806.97"', '"11906.97"') })
  await createVault(page)
  await expect(page.getByTestId('fx-error')).toBeVisible()
  await expect(page.getByTestId('fx-pair')).toHaveCount(0)
})
