import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { LOCALE_KEY, detectLocale, htmlLang, translate, type Locale, type MessageKey } from '../i18n'

type I18nApi = {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: MessageKey) => string
}

const I18nContext = createContext<I18nApi | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => detectLocale())

  const setLocale = useCallback((next: Locale) => {
    localStorage.setItem(LOCALE_KEY, next)
    setLocaleState(next)
  }, [])

  useEffect(() => {
    document.documentElement.lang = htmlLang(locale)
    document.title = 'Moliya'
  }, [locale])

  const t = useCallback((key: MessageKey) => translate(locale, key), [locale])
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nApi {
  const value = useContext(I18nContext)
  if (!value) throw new Error('I18n provider is missing')
  return value
}
