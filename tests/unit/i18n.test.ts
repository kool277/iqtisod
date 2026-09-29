import { describe, expect, it } from 'vitest'
import { LOCALES, catalogFor, flattenMessages, loadExportMessages } from '../../src/i18n'

await Promise.all(LOCALES.map(loadExportMessages))

describe('translations', () => {
  it('keeps the same keys in uz-Latn, uz-Cyrl, ru, and en', () => {
    const english = flattenMessages(catalogFor('en'))
    const englishKeys = Object.keys(english).sort()
    expect(englishKeys.length).toBeGreaterThan(40)
    expect(englishKeys).toContain('export.errors.passwordReused')
    for (const locale of LOCALES) {
      const messages = flattenMessages(catalogFor(locale))
      expect(Object.keys(messages).sort()).toEqual(englishKeys)
      for (const value of Object.values(messages)) {
        expect(value.trim().length).toBeGreaterThan(0)
      }
    }
  })
})

describe('export strings', () => {
  it('load on demand and translate like the rest of the catalog', async () => {
    const { hasExportMessages, translate } = await import('../../src/i18n')
    for (const locale of LOCALES) {
      expect(hasExportMessages(locale)).toBe(true)
      expect(translate(locale, 'export.title')).toBe(catalogFor(locale).export.title)
      expect(translate(locale, 'export.title')).not.toBe('export.title')
    }
  })
})
