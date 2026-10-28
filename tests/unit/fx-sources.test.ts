import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SourceFormatError, cbrDateUrl, decodeRaw, parseBoi, parseCbr, parseCbu, parseEcb, shown } from '../../tools/fx-sources'

const fixture = (name: string) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/fx', name), 'utf8')

describe('Central Bank of Uzbekistan JSON', () => {
  it('reads UZS per unit for the currencies Jaybi needs', () => {
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

describe('upstream text in error messages', () => {
  const messageOf = (fn: () => unknown) => {
    try {
      fn()
    } catch (error) {
      return (error as Error).message
    }
    throw new Error('expected a failure')
  }

  it('is quoted, printable, and short', () => {
    expect(shown('29.09.2026\n::error::forged')).toBe('"29.09.2026\\n::error::forged"')
    expect(shown('\u2028x\u0007')).toBe('"?x\\u0007"')
    expect(shown('x'.repeat(100))).toBe(`"${'x'.repeat(40)}?"`)
    expect(shown(7)).toBe('"7"')
  })

  it('cannot start a new log line or workflow command from any parser', () => {
    const forged = '\r\n::error title=x::forged%0A'
    const cbu = (patch: Record<string, string>) => JSON.stringify([{ Ccy: 'USD', Rate: '1', Nominal: '1', Date: '29.09.2026', ...patch }])
    const ecb = fixture('ecb.csv')
    const boi = fixture('boi.csv')
    const cbr = fixture('cbr.xml')
    const messages = [
      messageOf(() => parseCbu(cbu({ Date: `29.09.2026${forged}` }))),
      messageOf(() => parseCbu(cbu({ Nominal: `1${forged}` }))),
      messageOf(() => parseEcb(ecb.replace('2026-09-25', '2026-09-25\u2028::error::x'))),
      messageOf(() => parseEcb(ecb.replace(',EUR,', ',GBP,').replace('EXR.D.ILS', 'EXR\u0085::error::x'))),
      messageOf(() => parseBoi(boi.replaceAll('RER_USD_ILS', 'RER\u2029::error::x'))),
      messageOf(() => parseCbr(cbr.replace('Date="29.09.2026"', `Date="29.09.2026${forged}"`))),
      messageOf(() => parseCbr(cbr.replace('<CharCode>UZS</CharCode><Nominal>10000</Nominal>', `<CharCode>UZS</CharCode><Nominal>1${forged}</Nominal>`))),
      messageOf(() => parseCbr(cbr.replace('<Value>84,4075</Value>', `<Value>84,4075\u2028${forged}</Value>`))),
    ]
    for (const message of messages) {
      expect(message, message).not.toMatch(/[\r\n\u0085\u2028\u2029]/)
      expect(message, message).toMatch(/^[\x20-\x7e…]*$/)
    }
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

describe('Bank of Russia daily XML', () => {
  const table = (date: string, rows: string) => `<?xml version="1.0" encoding="windows-1251"?><ValCurs Date="${date}" name="Foreign Currency Market">${rows}</ValCurs>`
  const row = (code: string, nominal: string, value: string) =>
    `<Valute ID="R0"><NumCode>000</NumCode><CharCode>${code}</CharCode><Nominal>${nominal}</Nominal><Name>x</Name><Value>${value}</Value><VunitRate>1</VunitRate></Valute>`
  const usd = row('USD', '1', '84,4075')
  const uzs = row('UZS', '10000', '71,3781')

  it('reads RUB per unit for USD and UZS, dividing by the nominal exactly', () => {
    const latest = parseCbr(fixture('cbr.xml'))
    expect(latest.date).toBe('2026-09-29')
    expect(Object.fromEntries([...latest.rates].map(([code, rate]) => [code, rate.toString()]))).toEqual({ USD: '84.4075', UZS: '0.00713781' })
    const previous = parseCbr(fixture('cbr-previous.xml'))
    expect(previous.date).toBe('2026-09-26')
    expect(previous.rates.get('UZS')?.toString()).toBe('0.00712893')
    expect(parseCbr(table('29.09.2026', `${usd}\n${row('UZS', '10000', '71')}`)).rates.get('UZS')?.toString()).toBe('0.0071')
  })

  it('decodes windows-1251 and asks for a day as DD/MM/YYYY', () => {
    const russian = new Uint8Array([0xc4, 0xee, 0xeb, 0xeb, 0xe0, 0xf0])
    expect(decodeRaw('cbr', russian)).toBe('Доллар')
    expect(() => decodeRaw('cbu-latest', russian)).toThrow(TypeError)
    expect(cbrDateUrl('2026-09-28')).toBe('https://www.cbr.ru/scripts/XML_daily_eng.asp?date_req=28/09/2026')
  })

  it('rejects malformed responses', () => {
    expect(() => parseCbr('<html>maintenance</html>')).toThrow(SourceFormatError)
    expect(() => parseCbr('<?xml version="1.0" encoding="windows-1251"?><ValCurs>\nError in parameters\n</ValCurs>')).toThrow(/invalid date/)
    expect(() => parseCbr(table('01.12.2029', ''))).toThrow(/USD rate is missing/)
    expect(() => parseCbr(table('29.09.2026', usd))).toThrow(/UZS rate is missing/)
    expect(() => parseCbr(table('31.02.2026', usd + uzs))).toThrow(/invalid date/)
    expect(() => parseCbr(table('29.09.2026', usd + row('UZS', '3', '71,3781')))).toThrow(/power of ten/)
    expect(() => parseCbr(table('29.09.2026', usd + row('UZS', '10000', '71.3781')))).toThrow(/not a decimal/)
    expect(() => parseCbr(table('29.09.2026', usd + row('UZS', '10000', '0,0000')))).toThrow(/positive/)
    expect(() => parseCbr(table('29.09.2026', usd + usd + uzs))).toThrow(/listed twice/)
    expect(() => parseCbr(table('29.09.2026', usd + row('uzs', '10000', '71,3781')))).toThrow(/invalid currency code/)
  })
})
