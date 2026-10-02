import { ValidationError } from '../domain/errors'
import { FX_MINOR_UNITS, FxDataError, parseSnapshot, type FxCurrency, type FxSnapshot } from '../domain/fx'
import { Decimal } from '../lib/decimal'

export const FX_CACHE_KEY = 'moliya.fx.snapshot.v1'
export const FX_SNAPSHOT_PATH = 'rates/latest.json'

const MAX_INTEGER_DIGITS = 15
/** How far ahead of this device's clock a snapshot may claim to be; anything later would win over every real update. */
export const FX_FUTURE_SKEW_MS = 60 * 60 * 1000

export type LoadedSnapshot = { snapshot: FxSnapshot; text: string }

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function parseCurrent(text: string, now: number): FxSnapshot {
  const snapshot = parseSnapshot(text)
  if (Date.parse(snapshot.generatedAt) > now + FX_FUTURE_SKEW_MS) throw new FxDataError('snapshot is dated in the future')
  return snapshot
}

export function readCachedSnapshot(storage: Storage | null = defaultStorage(), now = Date.now()): LoadedSnapshot | null {
  try {
    const text = storage?.getItem(FX_CACHE_KEY)
    if (!text) return null
    try {
      return { snapshot: parseCurrent(text, now), text }
    } catch {
      storage?.removeItem(FX_CACHE_KEY)
      return null
    }
  } catch {
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

export async function fetchLatestSnapshot(fetcher: typeof fetch = fetch, base: string = document.baseURI, now = Date.now()): Promise<LoadedSnapshot> {
  const response = await fetcher(new URL(FX_SNAPSHOT_PATH, base), { cache: 'no-cache', credentials: 'same-origin' })
  if (!response.ok) throw new FxDataError(`HTTP ${response.status}`)
  const text = await response.text()
  return { snapshot: parseCurrent(text, now), text }
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
