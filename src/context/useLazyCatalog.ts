import { useEffect, useState } from 'react'
import type { Locale } from '../i18n'
import { useI18n } from './I18nContext'

export type CatalogState = 'ready' | 'loading' | 'failed'

/** Loads a lazy string catalog for the current language and re-renders once it is there. */
export function useLazyCatalog(load: (locale: Locale) => Promise<void>, has: (locale: Locale) => boolean): CatalogState {
  const { locale } = useI18n()
  const [, setLoaded] = useState<Locale | null>(null)
  const [failed, setFailed] = useState<Locale | null>(null)
  const ready = has(locale)
  useEffect(() => {
    if (ready) return
    let cancelled = false
    load(locale).then(
      () => {
        if (!cancelled) setLoaded(locale)
      },
      () => {
        if (!cancelled) setFailed(locale)
      },
    )
    return () => {
      cancelled = true
    }
  }, [locale, ready, load])
  if (ready) return 'ready'
  return failed === locale ? 'failed' : 'loading'
}
