import { describe, expect, it } from 'vitest'
import { LOCALES, catalogFor, flattenMessages } from '../../src/i18n'

describe('translations', () => {
  it('keeps the same keys in uz-Latn, uz-Cyrl, ru, and en', () => {
    const english = flattenMessages(catalogFor('en'))
    const englishKeys = Object.keys(english).sort()
    expect(englishKeys.length).toBeGreaterThan(40)
    for (const locale of LOCALES) {
      const messages = flattenMessages(catalogFor(locale))
      expect(Object.keys(messages).sort()).toEqual(englishKeys)
      for (const value of Object.values(messages)) {
        expect(value.trim().length).toBeGreaterThan(0)
      }
    }
  })
})
