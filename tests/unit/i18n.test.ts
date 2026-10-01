import { describe, expect, it } from 'vitest'
import { LOCALES, catalogFor, flattenMessages, hasHealthMessages, hasHelpMessages, hasTableMessages, loadExportMessages, loadHealthMessages, loadHelpMessages, translate } from '../../src/i18n'

const tableBefore = hasTableMessages()
const untranslated = translate('en', 'table.search')
const healthBefore = LOCALES.some(hasHealthMessages) || LOCALES.some(hasHelpMessages)
const healthUntranslated = translate('en', 'health.title')
const { registerTableCatalog } = await import('../../src/i18n/table')
registerTableCatalog()
await Promise.all([...LOCALES.map(loadExportMessages), ...LOCALES.map(loadHealthMessages), ...LOCALES.map(loadHelpMessages)])

describe('translations', () => {
  it('keeps the same keys in uz-Latn, uz-Cyrl, ru, and en', () => {
    const english = flattenMessages(catalogFor('en'))
    const englishKeys = Object.keys(english).sort()
    expect(englishKeys.length).toBeGreaterThan(40)
    expect(englishKeys).toContain('export.errors.passwordReused')
    expect(englishKeys).toContain('table.col.recordedBy')
    expect(englishKeys).toContain('health.checks.storedVault.fix')
    expect(englishKeys).toContain('help.search')
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

describe('table strings', () => {
  it('stay out of the core catalogs until the table chunk registers them', () => {
    expect(tableBefore).toBe(false)
    expect(untranslated).toBe('table.search')
    for (const locale of LOCALES) {
      expect(translate(locale, 'table.search')).toBe(catalogFor(locale).table.search)
      expect(translate(locale, 'table.search')).not.toBe('table.search')
    }
  })
})

describe('health and help strings', () => {
  it('load on demand, outside the startup bundle', () => {
    expect(healthBefore).toBe(false)
    expect(healthUntranslated).toBe('health.title')
    for (const locale of LOCALES) {
      expect(translate(locale, 'health.title')).toBe(catalogFor(locale).health.title)
      expect(translate(locale, 'help.search')).toBe(catalogFor(locale).help.search)
    }
  })

  it('are translated rather than copied from English', () => {
    const english = { ...flattenMessages(catalogFor('en').health), ...flattenMessages(catalogFor('en').help) }
    for (const locale of LOCALES.filter((item) => item !== 'en')) {
      const messages = { ...flattenMessages(catalogFor(locale).health), ...flattenMessages(catalogFor(locale).help) }
      const same = Object.entries(english).filter(([key, text]) => messages[key] === text && /\p{L}{4}/u.test(text) && !/^[\p{Lu}\w .()-]+$/u.test(text))
      expect(same, locale).toEqual([])
    }
  })
})
