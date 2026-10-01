import { describe, expect, it } from 'vitest'
import { LOCALES, hasLocale, loadLocale, translate } from '../../src/i18n'
import { en } from '../../src/i18n/en'

describe('core catalogs', () => {
  it('ship only English at startup and fall back to it until a language loads', async () => {
    expect(hasLocale('en')).toBe(true)
    for (const locale of LOCALES.filter((locale) => locale !== 'en')) {
      expect(hasLocale(locale)).toBe(false)
      expect(translate(locale, 'nav.dashboard')).toBe(en.nav.dashboard)
    }

    await Promise.all(LOCALES.map(loadLocale))

    for (const locale of LOCALES.filter((locale) => locale !== 'en')) {
      expect(hasLocale(locale)).toBe(true)
      expect(translate(locale, 'nav.dashboard')).not.toBe(en.nav.dashboard)
    }
  })
})
