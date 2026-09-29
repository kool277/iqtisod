import { en, type CoreMessages, type Messages } from './en'
import type { ExportMessages } from './export/en'
import { ru } from './ru'
import { uzCyrl } from './uz-Cyrl'
import { uzLatn } from './uz-Latn'

export type { Messages }

type Join<Prefix extends string, Key extends string> = Prefix extends '' ? Key : `${Prefix}.${Key}`

type Leaves<T, Prefix extends string = ''> = {
  [Key in keyof T & string]: T[Key] extends string ? Join<Prefix, Key> : Leaves<T[Key], Join<Prefix, Key>>
}[keyof T & string]

export type MessageKey = Leaves<Messages>

export const LOCALES = ['uz-Latn', 'uz-Cyrl', 'ru', 'en'] as const
export type Locale = (typeof LOCALES)[number]

export const LOCALE_KEY = 'moliya.locale'

const catalogs: Record<Locale, CoreMessages> = {
  en,
  ru,
  'uz-Latn': uzLatn,
  'uz-Cyrl': uzCyrl,
}

const exportLoaders: Record<Locale, () => Promise<ExportMessages>> = {
  en: () => import('./export/en').then((module) => module.exportEn),
  ru: () => import('./export/ru').then((module) => module.exportRu),
  'uz-Latn': () => import('./export/uz-Latn').then((module) => module.exportUzLatn),
  'uz-Cyrl': () => import('./export/uz-Cyrl').then((module) => module.exportUzCyrl),
}

const exportCatalogs: Partial<Record<Locale, ExportMessages>> = {}
const exportLoads: Partial<Record<Locale, Promise<void>>> = {}

/** The `export.*` strings stay out of the startup bundle; until this resolves they translate to their keys. */
export function loadExportMessages(locale: Locale): Promise<void> {
  exportLoads[locale] ??= exportLoaders[locale]().then(
    (messages) => {
      exportCatalogs[locale] = messages
    },
    (error: unknown) => {
      delete exportLoads[locale]
      throw error
    },
  )
  return exportLoads[locale]
}

export function hasExportMessages(locale: Locale): boolean {
  return exportCatalogs[locale] !== undefined
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

export function detectLocale(): Locale {
  if (typeof localStorage === 'undefined') return 'en'
  const saved = localStorage.getItem(LOCALE_KEY)
  if (isLocale(saved)) return saved
  if (typeof navigator === 'undefined') return 'en'
  const language = navigator.language.toLowerCase()
  if (language.includes('cyrl') && language.startsWith('uz')) return 'uz-Cyrl'
  if (language.startsWith('uz')) return 'uz-Latn'
  if (language.startsWith('ru')) return 'ru'
  return 'en'
}

export function translate(locale: Locale, key: MessageKey): string {
  const [head, ...rest] = key.split('.')
  const parts = head === 'export' ? rest : [head, ...rest]
  let current: unknown = head === 'export' ? exportCatalogs[locale] : catalogs[locale]
  for (const part of parts) {
    if (typeof current !== 'object' || current === null || !(part in current)) return key
    current = (current as Record<string, unknown>)[part]
  }
  return typeof current === 'string' ? current : key
}

export function flattenMessages(tree: unknown, prefix = ''): Record<string, string> {
  if (typeof tree === 'string') return prefix ? { [prefix]: tree } : {}
  if (typeof tree !== 'object' || tree === null) return {}
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key
    Object.assign(result, flattenMessages(value, path))
  }
  return result
}

/** `export` is missing until `loadExportMessages(locale)` has resolved. */
export function catalogFor(locale: Locale): Messages {
  const exportMessages = exportCatalogs[locale]
  return (exportMessages ? { ...catalogs[locale], export: exportMessages } : catalogs[locale]) as Messages
}

export function htmlLang(locale: Locale): string {
  if (locale === 'uz-Latn') return 'uz-Latn'
  if (locale === 'uz-Cyrl') return 'uz-Cyrl'
  if (locale === 'ru') return 'ru'
  return 'en'
}
