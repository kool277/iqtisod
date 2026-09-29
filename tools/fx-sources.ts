import { Decimal } from '../src/lib/decimal.ts'
import { isIsoDate, parseRate, type FxObservation, type FxSourceId } from '../src/domain/fx.ts'

export type RawKey = 'cbu-latest' | 'cbu-previous' | 'ecb' | 'boi'

export type RawResponse = { key: RawKey; source: FxSourceId; url: string; body: Uint8Array; fetchedAt: string }

export const RAW_FILES: Readonly<Record<RawKey, string>> = {
  'cbu-latest': 'cbu-latest.json',
  'cbu-previous': 'cbu-previous.json',
  ecb: 'ecb.csv',
  boi: 'boi.csv',
}

export const RAW_SOURCES: Readonly<Record<RawKey, FxSourceId>> = {
  'cbu-latest': 'CBU',
  'cbu-previous': 'CBU',
  ecb: 'ECB',
  boi: 'BOI',
}

export const CBU_LATEST_URL = 'https://cbu.uz/uz/arkhiv-kursov-valyut/json/'
export const ECB_URL =
  'https://data-api.ecb.europa.eu/service/data/EXR/D.USD+KRW+ILS.EUR.SP00.A?lastNObservations=2&detail=dataonly&format=csvdata'
export const BOI_URL =
  'https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/EXR/1.0/RER_USD_ILS?lastNObservations=2&format=csv'

export function cbuDateUrl(date: string): string {
  return `https://cbu.uz/uz/arkhiv-kursov-valyut/json/all/${date}/`
}

export class SourceFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SourceFormatError'
  }
}

function fail(message: string): never {
  throw new SourceFormatError(message)
}

function rate(text: string, label: string): Decimal {
  try {
    return parseRate(text, label)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

function perUnit(value: Decimal, powerOfTen: number): Decimal {
  return Decimal.of(value.unscaled, value.scale + powerOfTen)
}

export type CbuTable = { date: string; rates: Map<string, Decimal> }

const CBU_CURRENCIES = ['USD', 'EUR', 'KRW', 'ILS']

export function parseCbu(text: string): CbuTable {
  let rows: unknown
  try {
    rows = JSON.parse(text)
  } catch {
    fail('CBU: response is not JSON')
  }
  if (!Array.isArray(rows) || rows.length === 0) fail('CBU: expected a non-empty array')
  const rates = new Map<string, Decimal>()
  let date: string | null = null
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) fail('CBU: row is not an object')
    const { Ccy, Rate, Nominal, Date: day } = row as Record<string, unknown>
    if (typeof Ccy !== 'string' || !/^[A-Z]{3}$/.test(Ccy)) fail('CBU: invalid currency code')
    if (!CBU_CURRENCIES.includes(Ccy)) continue
    if (typeof Rate !== 'string') fail(`CBU ${Ccy}: rate is not a string`)
    if (typeof Nominal !== 'string' || !/^10*$/.test(Nominal)) fail(`CBU ${Ccy}: nominal ${String(Nominal)} is not a power of ten`)
    const match = typeof day === 'string' ? /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(day) : null
    const iso = match ? `${match[3]}-${match[2]}-${match[1]}` : null
    if (!isIsoDate(iso)) fail(`CBU ${Ccy}: invalid date ${String(day)}`)
    if (date !== null && date !== iso) fail('CBU: rows carry different dates')
    date = iso
    rates.set(Ccy, perUnit(rate(Rate, `CBU ${Ccy}`), Nominal.length - 1))
  }
  if (date === null || !rates.has('USD')) fail('CBU: USD rate is missing')
  return { date, rates }
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        cell += '"'
        index += 1
      } else if (char === '"') {
        quoted = false
      } else {
        cell += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      cells.push(cell)
      cell = ''
    } else {
      cell += char
    }
  }
  cells.push(cell)
  return cells
}

function parseCsv(text: string, label: string, required: string[]): Record<string, string>[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length < 2) fail(`${label}: no data rows`)
  const header = splitCsvLine(lines[0])
  for (const column of required) if (!header.includes(column)) fail(`${label}: missing column ${column}`)
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line)
    if (cells.length !== header.length) fail(`${label}: row has ${cells.length} cells, expected ${header.length}`)
    return Object.fromEntries(header.map((column, index) => [column, cells[index]]))
  })
}

function sortedObservations(observations: FxObservation[], label: string): FxObservation[] {
  const sorted = [...observations].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].date === sorted[index - 1].date) fail(`${label}: duplicate observation for ${sorted[index].date}`)
  }
  return sorted
}

export function parseEcb(text: string): Map<string, FxObservation[]> {
  const rows = parseCsv(text, 'ECB', ['FREQ', 'CURRENCY', 'CURRENCY_DENOM', 'EXR_TYPE', 'TIME_PERIOD', 'OBS_VALUE'])
  const series = new Map<string, FxObservation[]>()
  for (const row of rows) {
    const label = `ECB ${row.CURRENCY}`
    if (row.FREQ !== 'D' || row.CURRENCY_DENOM !== 'EUR' || row.EXR_TYPE !== 'SP00') fail(`${label}: unexpected series ${row.KEY ?? ''}`)
    if (!/^[A-Z]{3}$/.test(row.CURRENCY)) fail('ECB: invalid currency code')
    if (!isIsoDate(row.TIME_PERIOD)) fail(`${label}: invalid date ${row.TIME_PERIOD}`)
    rate(row.OBS_VALUE, label)
    series.set(row.CURRENCY, [...(series.get(row.CURRENCY) ?? []), { rate: row.OBS_VALUE, date: row.TIME_PERIOD }])
  }
  for (const [currency, observations] of series) series.set(currency, sortedObservations(observations, `ECB ${currency}`))
  return series
}

export function parseBoi(text: string): FxObservation[] {
  const rows = parseCsv(text, 'BOI', ['SERIES_CODE', 'BASE_CURRENCY', 'COUNTER_CURRENCY', 'UNIT_MULT', 'TIME_PERIOD', 'OBS_VALUE'])
  const observations = rows.map((row): FxObservation => {
    if (row.SERIES_CODE !== 'RER_USD_ILS' || row.BASE_CURRENCY !== 'USD' || row.COUNTER_CURRENCY !== 'ILS') {
      fail(`BOI: unexpected series ${row.SERIES_CODE}`)
    }
    if (!/^\d$/.test(row.UNIT_MULT)) fail(`BOI: invalid unit multiplier ${row.UNIT_MULT}`)
    if (!isIsoDate(row.TIME_PERIOD)) fail(`BOI: invalid date ${row.TIME_PERIOD}`)
    const value = perUnit(rate(row.OBS_VALUE, 'BOI USD/ILS'), '0123456789'.indexOf(row.UNIT_MULT))
    return { rate: value.toString(), date: row.TIME_PERIOD }
  })
  return sortedObservations(observations, 'BOI USD/ILS')
}
