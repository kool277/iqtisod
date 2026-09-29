import { ValidationError } from '../domain/errors'
import { FX_MINOR_UNITS, FxDataError, parseSnapshot, type FxCurrency, type FxSnapshot } from '../domain/fx'
import { Decimal } from '../lib/decimal'

export const FX_CACHE_KEY = 'moliya.fx.snapshot.v1'
export const FX_SNAPSHOT_PATH = 'rates/latest.json'

const MAX_INTEGER_DIGITS = 15

export type LoadedSnapshot = { snapshot: FxSnapshot; text: string }

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function readCachedSnapshot(storage: Storage | null = defaultStorage()): LoadedSnapshot | null {
  const text = storage?.getItem(FX_CACHE_KEY)
  if (!text) return null
  try {
    return { snapshot: parseSnapshot(text), text }
  } catch {
    storage?.removeItem(FX_CACHE_KEY)
    return null
  }
}

export function cacheSnapshot(loaded: LoadedSnapshot, storage: Storage | null = defaultStorage()): void {
  try {
    storage?.setItem(FX_CACHE_KEY, loaded.text)
  } catch {
    /* quota or privacy mode: the panel still works from memory */
  }
}

export async function fetchLatestSnapshot(fetcher: typeof fetch = fetch, base: string = document.baseURI): Promise<LoadedSnapshot> {
  const response = await fetcher(new URL(FX_SNAPSHOT_PATH, base), { cache: 'no-cache', credentials: 'same-origin' })
  if (!response.ok) throw new FxDataError(`HTTP ${response.status}`)
  const text = await response.text()
  return { snapshot: parseSnapshot(text), text }
}

export function preferNewer(current: LoadedSnapshot | null, incoming: LoadedSnapshot): LoadedSnapshot {
  return current && current.snapshot.generatedAt > incoming.snapshot.generatedAt ? current : incoming
}

export function parseAmountInput(text: string, currency: FxCurrency): Decimal {
  const compact = text.replace(/[\s\u00a0\u202f']/g, '')
  const match = /^(\d+)(?:[.,](\d*))?$/.exec(compact)
  if (!match) throw new ValidationError('AMOUNT')
  const whole = match[1].replace(/^0+(?=\d)/, '')
  const fraction = (match[2] ?? '').replace(/0+$/, '')
  if (whole.length > MAX_INTEGER_DIGITS) throw new ValidationError('AMOUNT_LIMIT')
  if (fraction.length > FX_MINOR_UNITS[currency]) throw new ValidationError('AMOUNT_PRECISION')
  const amount = Decimal.parse(fraction ? `${whole}.${fraction}` : whole)
  if (amount.sign() <= 0) throw new ValidationError('AMOUNT')
  return amount
}
