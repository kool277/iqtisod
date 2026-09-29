import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  FX_DIRECTIONS,
  FX_MINOR_UNITS,
  businessDaysBetween,
  changePercent,
  convert,
  crossVia,
  displayRate,
  isStale,
  parseSnapshot,
  scaledNominal,
  sealSnapshot,
  type FxQuote,
  type FxSnapshot,
  type FxSnapshotBody,
} from '../../src/domain/fx'
import { Decimal } from '../../src/lib/decimal'
import { CURRENCY_MINOR_UNITS } from '../../src/lib/money'

const SNAPSHOT_TEXT = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/fx/snapshot.json'), 'utf8')
const snapshot = parseSnapshot(SNAPSHOT_TEXT)
const [uzs, krw, ils] = snapshot.quotes

function body(): FxSnapshotBody {
  const { digest: _digest, ...rest } = JSON.parse(SNAPSHOT_TEXT) as FxSnapshot
  return rest
}

function resealed(change: (draft: FxSnapshotBody) => void): string {
  const draft = body()
  change(draft)
  return JSON.stringify(sealSnapshot(draft))
}

describe('currency metadata', () => {
  it('uses ISO 4217 exponents that agree with the ledger', () => {
    expect(FX_MINOR_UNITS).toEqual({ USD: 2, UZS: 2, KRW: 0, ILS: 2 })
    expect(FX_MINOR_UNITS.USD).toBe(CURRENCY_MINOR_UNITS.USD)
    expect(FX_MINOR_UNITS.UZS).toBe(CURRENCY_MINOR_UNITS.UZS)
  })

  it('lists the six requested directions', () => {
    expect(FX_DIRECTIONS.map((direction) => direction.id)).toEqual(['UZS-USD', 'USD-UZS', 'KRW-USD', 'USD-KRW', 'ILS-USD', 'USD-ILS'])
  })
})

describe('snapshot validation', () => {
  it('accepts the recorded snapshot and keeps official strings verbatim', () => {
    expect(uzs).toMatchObject({ quote: 'UZS', rate: '11806.97', source: 'CBU', method: 'official', previous: { rate: '11825.40' } })
    expect(krw).toMatchObject({ quote: 'KRW', rate: '1357.92757954', source: 'ECB', method: 'cross' })
    expect(crossVia(krw.legs!)).toBe('EUR')
    expect(ils).toMatchObject({ quote: 'ILS', rate: '3.066', source: 'BOI', method: 'official' })
    expect(snapshot.checks.every((check) => check.passed)).toBe(true)
  })

  it('detects tampering through the digest', () => {
    expect(() => parseSnapshot(SNAPSHOT_TEXT.replace('"11806.97"', '"11806.98"'))).toThrow(/digest/)
    expect(() => parseSnapshot(SNAPSHOT_TEXT.slice(0, -20))).toThrow(/JSON/)
  })

  it('rejects rates that are numbers instead of decimal strings', () => {
    expect(() => parseSnapshot(resealed((draft) => ((draft.quotes[0] as unknown as { rate: number }).rate = 11806.97)))).toThrow(/plain decimal string/)
  })

  it('enforces sanity bounds on current and previous rates', () => {
    expect(() => parseSnapshot(resealed((draft) => (draft.quotes[0].rate = '118.06')))).toThrow(/sanity range/)
    expect(() => parseSnapshot(resealed((draft) => (draft.quotes[2].rate = '30.1')))).toThrow(/sanity range/)
    expect(() => parseSnapshot(resealed((draft) => (draft.quotes[0].previous = { rate: '999', date: '2026-09-26' })))).toThrow(/sanity range/)
  })

  it('requires cross rates to match their legs', () => {
    expect(() => parseSnapshot(resealed((draft) => (draft.quotes[1].rate = '1357.93')))).toThrow(/legs/)
  })

  it('rejects inconsistent dates, pairs, schemas, and failed checks', () => {
    expect(() => parseSnapshot(resealed((draft) => (draft.quotes[0].date = '2026-10-20')))).toThrow(/future/)
    expect(() => parseSnapshot(resealed((draft) => (draft.quotes[0].date = '2026-02-30')))).toThrow(/YYYY-MM-DD/)
    expect(() => parseSnapshot(resealed((draft) => (draft.quotes[0].previous = { rate: '11825.40', date: '2026-09-29' })))).toThrow(/precede/)
    expect(() => parseSnapshot(resealed((draft) => draft.quotes.reverse()))).toThrow(/unexpected pair/)
    expect(() => parseSnapshot(resealed((draft) => draft.quotes.pop()))).toThrow(/3 quotes/)
    expect(() => parseSnapshot(resealed((draft) => ((draft as { schema: number }).schema = 2)))).toThrow(/schema/)
    expect(() => parseSnapshot(resealed((draft) => (draft.checks[0].passed = false)))).toThrow(/did not pass/)
    expect(() => parseSnapshot(resealed((draft) => (draft.fetches[0].sha256 = 'abc')))).toThrow(/sha256/)
  })
})

describe('staleness', () => {
  it('counts weekdays after the rate date', () => {
    expect(businessDaysBetween('2026-09-25', '2026-09-28')).toBe(1)
    expect(businessDaysBetween('2026-09-24', '2026-09-28')).toBe(2)
    expect(businessDaysBetween('2026-09-23', '2026-09-28')).toBe(3)
    expect(businessDaysBetween('2026-09-30', '2026-09-29')).toBe(0)
  })

  it('marks rates stale after two business days', () => {
    expect(isStale('2026-09-25', '2026-09-28')).toBe(false)
    expect(isStale('2026-09-24', '2026-09-28')).toBe(false)
    expect(isStale('2026-09-23', '2026-09-28')).toBe(true)
    expect(isStale('2026-09-25', '2026-09-27')).toBe(false)
    expect(isStale('2026-09-30', '2026-09-29')).toBe(false)
  })
})

describe('exact conversion', () => {
  const amount = (text: string) => Decimal.parse(text)
  const run = (text: string, quote: FxQuote, inverse: boolean) => {
    const result = convert(amount(text), quote, inverse)
    return { rounded: result.rounded.toString(), exact: result.exact.toString(), currency: result.currency }
  }

  it('converts USD to UZS by exact multiplication with half-even rounding', () => {
    expect(run('100', uzs, false)).toEqual({ rounded: '1180697.00', exact: '1180697', currency: 'UZS' })
    expect(run('1234.5', uzs, false)).toEqual({ rounded: '14575704.46', exact: '14575704.465', currency: 'UZS' })
  })

  it('converts UZS to USD by dividing once, not by multiplying a rounded inverse', () => {
    expect(run('1000000', uzs, true)).toEqual({ rounded: '84.70', exact: '84.695734807490829569', currency: 'USD' })
  })

  it('rounds KRW to whole won and computes cross conversions from the official legs', () => {
    expect(run('1', krw, false)).toEqual({ rounded: '1358', exact: '1357.9275795394621199', currency: 'KRW' })
    expect(run('1000000000', krw, false).rounded).toBe('1357927579539')
    expect(Decimal.parse('1000000000').multiply(Decimal.parse(krw.rate)).setScale(0).toString()).toBe('1357927579540')
    expect(run('250000', krw, true)).toEqual({ rounded: '184.10', exact: '184.10407430180253066', currency: 'USD' })
  })

  it('converts ILS both ways', () => {
    expect(run('100', ils, true)).toEqual({ rounded: '32.62', exact: '32.61578604044357469', currency: 'USD' })
    expect(run('10', ils, false)).toEqual({ rounded: '30.66', exact: '30.66', currency: 'ILS' })
  })
})

describe('display helpers', () => {
  it('shows official rates verbatim and derived rates to six significant digits', () => {
    expect(displayRate(uzs, false).toString()).toBe('11806.97')
    expect(displayRate(uzs, true).toString()).toBe('0.0000846957')
    expect(displayRate(krw, false).toString()).toBe('1357.93')
    expect(displayRate(krw, true).toString()).toBe('0.000736416')
    expect(displayRate(ils, false).toString()).toBe('3.066')
    expect(displayRate(ils, true).toString()).toBe('0.326158')
  })

  it('scales tiny inverse rates to a readable nominal', () => {
    expect(scaledNominal(uzs, true)?.toString()).toBe('100000')
    expect(scaledNominal(krw, true)?.toString()).toBe('10000')
    expect(scaledNominal(ils, true)).toBeNull()
    expect(scaledNominal(uzs, false)).toBeNull()
  })

  it('computes the change against the previous official rate in both directions', () => {
    expect(changePercent(uzs, false)?.toString()).toBe('-0.16')
    expect(changePercent(uzs, true)?.toString()).toBe('0.16')
    expect(changePercent(ils, false)?.toString()).toBe('1.09')
    expect(changePercent({ ...uzs, previous: null }, false)).toBeNull()
  })
})
