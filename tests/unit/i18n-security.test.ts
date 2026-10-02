import { describe, expect, it } from 'vitest'
import { LOCALES, catalogFor, flattenMessages, loadExportMessages, loadHealthMessages, loadHelpMessages, loadPeopleMessages } from '../../src/i18n'

await Promise.all([...LOCALES.map(loadExportMessages), ...LOCALES.map(loadHealthMessages), ...LOCALES.map(loadHelpMessages), ...LOCALES.map(loadPeopleMessages)])

const uzLatn = flattenMessages(catalogFor('uz-Latn'))

describe('Uzbek Latin apostrophes', () => {
  it('writes oʻ and gʻ with U+02BB and never with ASCII or curly quotes', () => {
    for (const [key, value] of Object.entries(uzLatn)) {
      expect(value, key).not.toMatch(/[oOgG]['`‘’ʼ´]/)
    }
    const all = Object.values(uzLatn).join('\n')
    expect(all).toMatch(/[oOgG]\u02BB/)
  })

  it('uses U+02BB only after o or g', () => {
    for (const [key, value] of Object.entries(uzLatn)) {
      expect(value, key).not.toMatch(/[^oOgG]\u02BB|^\u02BB/)
    }
  })

  it('writes the tutuq belgisi with U+02BC and never puts other apostrophes between letters', () => {
    for (const [key, value] of Object.entries(uzLatn)) {
      expect(value, key).not.toMatch(/\p{L}['`‘’´]\p{L}/u)
    }
    expect(Object.values(uzLatn).join('\n')).toMatch(/maʼlumot/i)
  })
})

describe('security messages', () => {
  const english = catalogFor('en')

  it('translates every security error and audit label in every locale', () => {
    for (const section of ['securityErrors', 'securityAudit'] as const) {
      const keys = Object.keys(english[section]).sort()
      expect(keys.length, section).toBeGreaterThan(5)
      for (const locale of LOCALES) {
        const messages = catalogFor(locale)[section] as Record<string, string>
        expect(Object.keys(messages).sort(), `${locale}.${section}`).toEqual(keys)
        for (const key of keys) {
          expect(typeof messages[key], `${locale}.${section}.${key}`).toBe('string')
          expect(messages[key].trim().length, `${locale}.${section}.${key}`).toBeGreaterThan(0)
        }
      }
    }
  })

  it('has messages for the codes raised by the hardened libraries', () => {
    const codes = ['PASSWORD_LONG', 'PASSWORD_COMMON', 'PASSWORD_CONTEXT', 'INVITE_CODE', 'THROTTLED', 'TOTP_INVALID', 'RECEIPT_TYPE']
    for (const code of codes) expect(english.securityErrors, code).toHaveProperty(code)
  })

  it('does not reuse the English text in the other locales', () => {
    for (const locale of LOCALES.filter((item) => item !== 'en')) {
      const messages = catalogFor(locale).securityErrors as Record<string, string>
      const same = Object.entries(english.securityErrors).filter(([key, text]) => messages[key] === text)
      expect(same, locale).toEqual([])
    }
  })
})
