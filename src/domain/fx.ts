import { Decimal } from '../lib/decimal.ts'
import { sha256Hex } from '../lib/sha256.ts'

export const FX_SCHEMA = 1
export const FX_BASE = 'USD'
export const FX_QUOTES = ['UZS', 'KRW', 'ILS'] as const
export const FX_SOURCES = ['CBU', 'ECB', 'BOI'] as const

export type FxQuoteCurrency = (typeof FX_QUOTES)[number]
export type FxCurrency = typeof FX_BASE | FxQuoteCurrency
export type FxSourceId = (typeof FX_SOURCES)[number]

export const FX_MINOR_UNITS: Readonly<Record<FxCurrency, number>> = { USD: 2, UZS: 2, KRW: 0, ILS: 2 }

export const FX_SOURCE_PAGES: Readonly<Record<FxSourceId, string>> = {
  CBU: 'https://cbu.uz/en/arkhiv-kursov-valyut/',
  ECB: 'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html',
  BOI: 'https://www.boi.org.il/en/economic-roles/financial-markets/exchange-rates/',
}

export const FX_BOUNDS: Readonly<Record<FxQuoteCurrency, readonly [string, string]>> = {
  UZS: ['1000', '100000'],
  KRW: ['100', '10000'],
  ILS: ['1', '20'],
}

export const CROSS_PRECISION = 12
export const DISPLAY_PRECISION = 6
export const EXACT_PRECISION = 20
export const STALE_AFTER_BUSINESS_DAYS = 2
export const FUTURE_TOLERANCE_DAYS = 4

export type FxObservation = { rate: string; date: string }
export type FxLeg = { pair: string; rate: string }

export type FxQuote = {
  base: typeof FX_BASE
  quote: FxQuoteCurrency
  rate: string
  date: string
  source: FxSourceId
  method: 'official' | 'cross'
  legs: [FxLeg, FxLeg] | null
  previous: FxObservation | null
}

export type FxFetch = { source: FxSourceId; url: string; fetchedAt: string; sha256: string }

export type FxCheck = {
  subject: string
  reference: string
  deviationPercent: string
  tolerancePercent: string
  passed: boolean
}

export type FxSnapshotBody = {
  schema: typeof FX_SCHEMA
  generatedAt: string
  quotes: FxQuote[]
  fetches: FxFetch[]
  checks: FxCheck[]
}

export type FxSnapshot = FxSnapshotBody & { digest: string }

export type FxDirection = { id: string; from: FxCurrency; to: FxCurrency; quote: FxQuoteCurrency; inverse: boolean }

export const FX_DIRECTIONS: readonly FxDirection[] = FX_QUOTES.flatMap((quote) => [
  { id: `${quote}-USD`, from: quote, to: FX_BASE, quote, inverse: true },
  { id: `USD-${quote}`, from: FX_BASE, to: quote, quote, inverse: false },
])

export class FxDataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FxDataError'
  }
}

const RATE_TEXT = /^\d{1,12}(?:\.\d{1,20})?$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const DAY_MS = 86_400_000

function fail(message: string): never {
  throw new FxDataError(message)
}

export function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && ISO_DATE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value)
}

function isIsoInstant(value: unknown): value is string {
  return typeof value === 'string' && ISO_INSTANT.test(value) && !Number.isNaN(Date.parse(value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseRate(value: unknown, label: string): Decimal {
  if (typeof value !== 'string' || !RATE_TEXT.test(value)) fail(`${label}: rate must be a plain decimal string`)
  const rate = Decimal.parse(value)
  if (rate.sign() <= 0) fail(`${label}: rate must be positive`)
  return rate
}

export function assertWithinBounds(quote: FxQuoteCurrency, rate: Decimal, label: string): void {
  const [min, max] = FX_BOUNDS[quote]
  if (rate.compareTo(Decimal.parse(min)) < 0 || rate.compareTo(Decimal.parse(max)) > 0) {
    fail(`${label}: ${rate.toString()} is outside the sanity range ${min}–${max}`)
  }
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

export function businessDaysBetween(from: string, to: string): number {
  let count = 0
  for (let day = addDays(from, 1), guard = 0; day <= to && guard < 3660; day = addDays(day, 1), guard += 1) {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay()
    if (weekday !== 0 && weekday !== 6) count += 1
  }
  return count
}

export function isStale(rateDate: string, today: string): boolean {
  return businessDaysBetween(rateDate, today) > STALE_AFTER_BUSINESS_DAYS
}

export function localIsoDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function crossRate(numerator: Decimal, denominator: Decimal): Decimal {
  return numerator.divideToPrecision(denominator, CROSS_PRECISION)
}

export function crossVia(legs: readonly [FxLeg, FxLeg]): string {
  const [a, b] = legs.map((leg) => leg.pair.split('/'))
  return a.find((currency) => b.includes(currency)) ?? '?'
}

export function quoteRatio(quote: FxQuote, inverse: boolean): { numerator: Decimal; denominator: Decimal } {
  const top = quote.legs ? Decimal.parse(quote.legs[0].rate) : Decimal.parse(quote.rate)
  const bottom = quote.legs ? Decimal.parse(quote.legs[1].rate) : Decimal.ONE
  return inverse ? { numerator: bottom, denominator: top } : { numerator: top, denominator: bottom }
}

export function displayRate(quote: FxQuote, inverse: boolean): Decimal {
  if (!inverse && quote.method === 'official') return Decimal.parse(quote.rate)
  const { numerator, denominator } = quoteRatio(quote, inverse)
  return numerator.divideToPrecision(denominator, DISPLAY_PRECISION)
}

export type Conversion = { rounded: Decimal; exact: Decimal; currency: FxCurrency }

export function convert(amount: Decimal, quote: FxQuote, inverse: boolean): Conversion {
  const { numerator, denominator } = quoteRatio(quote, inverse)
  const currency = inverse ? FX_BASE : quote.quote
  const product = amount.multiply(numerator)
  return {
    currency,
    rounded: product.divide(denominator, FX_MINOR_UNITS[currency]),
    exact: product.divideToPrecision(denominator, EXACT_PRECISION).stripTrailingZeros(),
  }
}

export function scaledNominal(quote: FxQuote, inverse: boolean): Decimal | null {
  const rate = displayRate(quote, inverse)
  if (rate.compareTo(Decimal.parse('0.01')) >= 0) return null
  return Decimal.of(10n ** BigInt(-rate.adjustedExponent()))
}

export function changePercent(quote: FxQuote, inverse: boolean): Decimal | null {
  if (!quote.previous) return null
  const current = Decimal.parse(quote.rate)
  const previous = Decimal.parse(quote.previous.rate)
  const [from, to] = inverse ? [current, previous] : [previous, current]
  return to.subtract(from).multiply(Decimal.of(100n)).divide(from, 2)
}

function parseQuote(value: unknown, expected: FxQuoteCurrency, generatedDate: string): FxQuote {
  const label = `USD/${expected}`
  if (!isRecord(value)) fail(`${label}: quote must be an object`)
  if (value.base !== FX_BASE || value.quote !== expected) fail(`${label}: unexpected pair ${String(value.base)}/${String(value.quote)}`)
  const rate = parseRate(value.rate, label)
  assertWithinBounds(expected, rate, label)
  if (!isIsoDate(value.date)) fail(`${label}: date must be YYYY-MM-DD`)
  if (value.date > addDays(generatedDate, FUTURE_TOLERANCE_DAYS)) fail(`${label}: date ${value.date} is in the future`)
  if (!(FX_SOURCES as readonly unknown[]).includes(value.source)) fail(`${label}: unknown source`)
  const method = value.method
  let legs: [FxLeg, FxLeg] | null = null
  if (method === 'official') {
    if (value.legs !== null) fail(`${label}: official quotes have no legs`)
  } else if (method === 'cross') {
    if (!Array.isArray(value.legs) || value.legs.length !== 2) fail(`${label}: cross quotes need two legs`)
    const [top, bottom] = value.legs.map((leg: unknown, index: number): FxLeg => {
      if (!isRecord(leg) || typeof leg.pair !== 'string' || !/^[A-Z]{3}\/[A-Z]{3}$/.test(leg.pair)) fail(`${label}: leg ${index} is invalid`)
      parseRate(leg.rate, `${label} leg ${leg.pair}`)
      return { pair: leg.pair, rate: leg.rate as string }
    })
    legs = [top, bottom]
    if (!crossRate(Decimal.parse(top.rate), Decimal.parse(bottom.rate)).equals(rate)) fail(`${label}: rate does not match its legs`)
  } else {
    fail(`${label}: unknown method`)
  }
  let previous: FxObservation | null = null
  if (value.previous !== null) {
    if (!isRecord(value.previous)) fail(`${label}: previous must be an object or null`)
    const previousRate = parseRate(value.previous.rate, `${label} previous`)
    assertWithinBounds(expected, previousRate, `${label} previous`)
    if (!isIsoDate(value.previous.date) || value.previous.date >= value.date) fail(`${label}: previous date must precede the rate date`)
    previous = { rate: value.previous.rate as string, date: value.previous.date }
  }
  return {
    base: FX_BASE,
    quote: expected,
    rate: value.rate as string,
    date: value.date,
    source: value.source as FxSourceId,
    method,
    legs,
    previous,
  }
}

function parseFetch(value: unknown): FxFetch {
  if (!isRecord(value)) fail('fetch must be an object')
  const { source, url, fetchedAt, sha256 } = value
  if (!(FX_SOURCES as readonly unknown[]).includes(source)) fail('fetch: unknown source')
  if (typeof url !== 'string' || !url.startsWith('https://')) fail('fetch: url must be https')
  if (!isIsoInstant(fetchedAt)) fail('fetch: fetchedAt must be an ISO instant')
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) fail('fetch: sha256 must be 64 hex characters')
  return { source: source as FxSourceId, url, fetchedAt, sha256 }
}

function parseCheck(value: unknown): FxCheck {
  if (!isRecord(value)) fail('check must be an object')
  const { subject, reference, deviationPercent, tolerancePercent, passed } = value
  if (typeof subject !== 'string' || typeof reference !== 'string') fail('check: subject and reference are required')
  parseRate(tolerancePercent, `check ${subject}`)
  if (typeof deviationPercent !== 'string' || !RATE_TEXT.test(deviationPercent)) fail(`check ${subject}: invalid deviation`)
  if (passed !== true) fail(`check ${subject} did not pass`)
  return { subject, reference, deviationPercent, tolerancePercent: tolerancePercent as string, passed }
}

export function snapshotDigest(body: FxSnapshotBody): string {
  return sha256Hex(JSON.stringify(body))
}

export function sealSnapshot(body: FxSnapshotBody): FxSnapshot {
  return { ...body, digest: snapshotDigest(body) }
}

export function parseSnapshot(text: string): FxSnapshot {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    fail('snapshot is not valid JSON')
  }
  if (!isRecord(raw)) fail('snapshot must be an object')
  const { digest, ...rest } = raw
  if (typeof digest !== 'string' || digest !== sha256Hex(JSON.stringify(rest))) fail('snapshot digest does not match its content')
  if (rest.schema !== FX_SCHEMA) fail(`unsupported snapshot schema ${String(rest.schema)}`)
  if (!isIsoInstant(rest.generatedAt)) fail('generatedAt must be an ISO instant')
  const generatedDate = rest.generatedAt.slice(0, 10)
  if (!Array.isArray(rest.quotes) || rest.quotes.length !== FX_QUOTES.length) fail(`snapshot must contain ${FX_QUOTES.length} quotes`)
  const quotes = FX_QUOTES.map((quote, index) => parseQuote((rest.quotes as unknown[])[index], quote, generatedDate))
  if (!Array.isArray(rest.fetches) || rest.fetches.length === 0) fail('snapshot must list its fetches')
  if (!Array.isArray(rest.checks)) fail('snapshot must list its checks')
  return {
    schema: FX_SCHEMA,
    generatedAt: rest.generatedAt,
    quotes,
    fetches: rest.fetches.map(parseFetch),
    checks: rest.checks.map(parseCheck),
    digest,
  }
}
