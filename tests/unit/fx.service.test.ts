import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { ValidationError } from '../../src/domain/errors'
import { FxDataError, sealSnapshot, type FxSnapshot } from '../../src/domain/fx'
import {
  FX_CACHE_KEY,
  FX_FUTURE_SKEW_MS,
  cacheSnapshot,
  fetchLatestSnapshot,
  parseAmountInput,
  preferNewer,
  readCachedSnapshot,
} from '../../src/services/fx.service'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const TEXT = readFileSync(resolve(ROOT, 'tests/fixtures/fx/snapshot.json'), 'utf8')
const BASE = 'https://kool277.github.io/iqtisod/'

class MemoryStorage implements Storage {
  private items = new Map<string, string>()
  failWrites = false
  get length() {
    return this.items.size
  }
  clear() {
    this.items.clear()
  }
  getItem(key: string) {
    return this.items.get(key) ?? null
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null
  }
  removeItem(key: string) {
    this.items.delete(key)
  }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new DOMException('quota', 'QuotaExceededError')
    this.items.set(key, value)
  }
}

function later(generatedAt: string): string {
  const { digest: _digest, ...body } = JSON.parse(TEXT) as FxSnapshot
  return JSON.stringify(sealSnapshot({ ...body, generatedAt }))
}

describe('fetchLatestSnapshot', () => {
  it('fetches the same-origin snapshot without caching and verifies it', async () => {
    const fetcher = vi.fn(async () => new Response(TEXT, { status: 200 }))
    const loaded = await fetchLatestSnapshot(fetcher as unknown as typeof fetch, BASE)
    expect(loaded.snapshot.quotes.map((quote) => quote.rate)).toEqual(['11806.97', '1357.92757954', '3.066'])
    expect(loaded.text).toBe(TEXT)
    expect(fetcher).toHaveBeenCalledWith(new URL('https://kool277.github.io/iqtisod/rates/latest.json'), { cache: 'no-cache', credentials: 'same-origin' })
  })

  it('rejects HTTP errors and tampered payloads', async () => {
    const notFound = vi.fn(async () => new Response('missing', { status: 404 }))
    await expect(fetchLatestSnapshot(notFound as unknown as typeof fetch, BASE)).rejects.toThrow(FxDataError)
    const tampered = vi.fn(async () => new Response(TEXT.replace('"3.066"', '"3.166"'), { status: 200 }))
    await expect(fetchLatestSnapshot(tampered as unknown as typeof fetch, BASE)).rejects.toThrow(/digest/)
  })
})

describe('snapshot cache', () => {
  it('stores the verified text outside the vault and reads it back', () => {
    const storage = new MemoryStorage()
    expect(readCachedSnapshot(storage)).toBeNull()
    cacheSnapshot({ snapshot: JSON.parse(TEXT) as FxSnapshot, text: TEXT }, storage)
    expect(storage.getItem(FX_CACHE_KEY)).toBe(TEXT)
    expect(readCachedSnapshot(storage)?.snapshot.digest).toBe((JSON.parse(TEXT) as FxSnapshot).digest)
  })

  it('refuses a snapshot dated beyond a small skew ahead of this device, so it cannot pin old rates', async () => {
    const generatedAt = (JSON.parse(TEXT) as FxSnapshot).generatedAt
    const now = Date.parse(generatedAt)
    const storage = new MemoryStorage()
    const soon = later(new Date(now + FX_FUTURE_SKEW_MS - 1000).toISOString())
    storage.setItem(FX_CACHE_KEY, soon)
    expect(readCachedSnapshot(storage, now)?.text).toBe(soon)

    const future = later('2099-01-01T00:00:00.000Z')
    storage.setItem(FX_CACHE_KEY, future)
    expect(readCachedSnapshot(storage, now)).toBeNull()
    expect(storage.getItem(FX_CACHE_KEY)).toBeNull()
    const fetcher = vi.fn(async () => new Response(future, { status: 200 }))
    await expect(fetchLatestSnapshot(fetcher as unknown as typeof fetch, BASE, now)).rejects.toThrow(/future/)
  })

  it('reads nothing when storage itself is blocked', () => {
    const blocked = { getItem: () => { throw new DOMException('denied', 'SecurityError') } } as unknown as Storage
    expect(readCachedSnapshot(blocked)).toBeNull()
  })

  it('discards a corrupted cache entry', () => {
    const storage = new MemoryStorage()
    storage.setItem(FX_CACHE_KEY, TEXT.replace('11806.97', '99999.99'))
    expect(readCachedSnapshot(storage)).toBeNull()
    expect(storage.getItem(FX_CACHE_KEY)).toBeNull()
  })

  it('keeps working when storage refuses writes', () => {
    const storage = new MemoryStorage()
    storage.failWrites = true
    expect(() => cacheSnapshot({ snapshot: JSON.parse(TEXT) as FxSnapshot, text: TEXT }, storage)).not.toThrow()
  })

  it('never replaces a newer cached snapshot with an older response', () => {
    const cached = { snapshot: JSON.parse(later('2026-09-30T03:17:00.000Z')) as FxSnapshot, text: '' }
    const older = { snapshot: JSON.parse(TEXT) as FxSnapshot, text: TEXT }
    expect(preferNewer(cached, older)).toBe(cached)
    expect(preferNewer(older, cached)).toBe(cached)
    expect(preferNewer(null, older)).toBe(older)
  })
})

describe('parseAmountInput', () => {
  it('accepts grouped input with either decimal separator', () => {
    expect(parseAmountInput('1 000 000', 'UZS').toString()).toBe('1000000')
    expect(parseAmountInput('1\u00a0234,50', 'USD').toString()).toBe('1234.5')
    expect(parseAmountInput('0012.30', 'ILS').toString()).toBe('12.3')
    expect(parseAmountInput('250000', 'KRW').toString()).toBe('250000')
  })

  it('enforces ISO minor units, positivity, and size', () => {
    const code = (text: string, currency: 'USD' | 'UZS' | 'KRW' | 'ILS') => {
      try {
        parseAmountInput(text, currency)
        return null
      } catch (error) {
        return error instanceof ValidationError ? error.code : 'unexpected'
      }
    }
    expect(code('1.5', 'KRW')).toBe('AMOUNT_PRECISION')
    expect(code('1.50', 'USD')).toBeNull()
    expect(code('1.505', 'USD')).toBe('AMOUNT_PRECISION')
    expect(code('0', 'USD')).toBe('AMOUNT')
    expect(code('-5', 'USD')).toBe('AMOUNT')
    expect(code('1e3', 'USD')).toBe('AMOUNT')
    expect(code('', 'USD')).toBe('AMOUNT')
    expect(code('1234567890123456', 'UZS')).toBe('AMOUNT_LIMIT')
  })
})
