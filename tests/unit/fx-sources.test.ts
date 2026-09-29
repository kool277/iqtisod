import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SourceFormatError, parseBoi, parseCbu, parseEcb } from '../../tools/fx-sources'

const fixture = (name: string) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/fx', name), 'utf8')

describe('Central Bank of Uzbekistan JSON', () => {
  it('reads UZS per unit for the currencies Moliya needs', () => {
    const table = parseCbu(fixture('cbu-latest.json'))
    expect(table.date).toBe('2026-09-29')
    expect(Object.fromEntries([...table.rates].map(([code, rate]) => [code, rate.toString()]))).toEqual({
      USD: '11806.97',
      EUR: '13430.43',
      ILS: '3849.05',
      KRW: '8.68',
    })
    const previous = parseCbu(fixture('cbu-previous.json'))
    expect(previous.date).toBe('2026-09-26')
    expect(previous.rates.get('USD')?.toString()).toBe('11825.40')
  })

  it('divides by the nominal exactly', () => {
    const table = parseCbu('[{"Ccy":"USD","Rate":"11806.97","Nominal":"1","Date":"29.09.2026"},{"Ccy":"KRW","Rate":"86.80","Nominal":"10","Date":"29.09.2026"}]')
    expect(table.rates.get('KRW')?.toString()).toBe('8.680')
  })

  it('rejects malformed responses', () => {
    const row = (patch: Record<string, string>) => JSON.stringify([{ Ccy: 'USD', Rate: '11806.97', Nominal: '1', Date: '29.09.2026', ...patch }])
    expect(() => parseCbu('<html>maintenance</html>')).toThrow(SourceFormatError)
    expect(() => parseCbu('[]')).toThrow(/non-empty/)
    expect(() => parseCbu(row({ Rate: '11 806,97' }))).toThrow(/plain decimal/)
    expect(() => parseCbu(row({ Nominal: '3' }))).toThrow(/power of ten/)
    expect(() => parseCbu(row({ Date: '2026-09-29' }))).toThrow(/invalid date/)
    expect(() => parseCbu(JSON.stringify([{ Ccy: 'EUR', Rate: '1', Nominal: '1', Date: '29.09.2026' }]))).toThrow(/USD rate is missing/)
    expect(() => parseCbu(JSON.stringify([{ Ccy: 'USD', Rate: 11806.97, Nominal: '1', Date: '29.09.2026' }]))).toThrow(/not a string/)
  })
})

describe('European Central Bank SDMX CSV', () => {
  it('reads both observations for each series with CRLF line endings', () => {
    const series = parseEcb(fixture('ecb.csv'))
    expect(series.get('USD')).toEqual([
      { rate: '1.1403', date: '2026-09-25' },
      { rate: '1.1378', date: '2026-09-28' },
    ])
    expect(series.get('KRW')?.at(-1)).toEqual({ rate: '1545.05', date: '2026-09-28' })
    expect(series.get('ILS')?.at(-1)).toEqual({ rate: '3.4854', date: '2026-09-28' })
  })

  it('rejects unexpected series and missing columns', () => {
    expect(() => parseEcb(fixture('ecb.csv').replaceAll(',EUR,', ',GBP,'))).toThrow(/unexpected series/)
    expect(() => parseEcb('KEY,FREQ\r\nEXR,D\r\n')).toThrow(/missing column/)
    expect(() => parseEcb(fixture('ecb.csv').replace('1.1378', 'NaN'))).toThrow(/plain decimal/)
  })
})

describe('Bank of Israel SDMX CSV', () => {
  it('reads the official representative USD/ILS rate', () => {
    expect(parseBoi(fixture('boi.csv'))).toEqual([
      { rate: '3.033', date: '2026-09-25' },
      { rate: '3.066', date: '2026-09-28' },
    ])
  })

  it('applies the unit multiplier exactly and rejects other series', () => {
    const multiplied = fixture('boi.csv').replace(',0,,2026-09-28,3.066,', ',2,,2026-09-28,306.6,')
    expect(parseBoi(multiplied).at(-1)).toEqual({ rate: '3.066', date: '2026-09-28' })
    expect(() => parseBoi(fixture('boi.csv').replaceAll('RER_USD_ILS', 'RER_EUR_ILS'))).toThrow(/unexpected series/)
  })
})
