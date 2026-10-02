import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectLocale, LOCALE_KEY } from '../../src/i18n'
import { readPreference, writePreference } from '../../src/lib/preference'

afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(globalThis, 'localStorage')
})

describe('display preferences', () => {
  it('reads and writes through localStorage', () => {
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) })
    writePreference(LOCALE_KEY, 'ru')
    expect(readPreference(LOCALE_KEY)).toBe('ru')
    expect(detectLocale()).toBe('ru')
  })

  it('keeps working when storage is blocked or full', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      },
    })
    expect(readPreference('moliya.theme')).toBeNull()
    expect(() => writePreference('moliya.theme', 'dark')).not.toThrow()
    expect(() => detectLocale()).not.toThrow()

    Reflect.deleteProperty(globalThis, 'localStorage')
    const full = () => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    }
    vi.stubGlobal('localStorage', { getItem: full, setItem: full })
    expect(readPreference('moliya.sidebar')).toBeNull()
    expect(() => writePreference('moliya.sidebar', 'collapsed')).not.toThrow()
  })
})
