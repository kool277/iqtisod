import { readPreference } from '../lib/preference'
import { en, type CoreMessages, type Messages } from './en'
import type { ExportMessages } from './export/en'
import type { HealthMessages } from './health/en'
import type { HelpMessages } from './help/en'
import type { TableMessages } from './table/en'

export type { Messages }

type Join<Prefix extends string, Key extends string> = Prefix extends '' ? Key : `${Prefix}.${Key}`

type Leaves<T, Prefix extends string = ''> = {
  [Key in keyof T & string]: T[Key] extends string ? Join<Prefix, Key> : Leaves<T[Key], Join<Prefix, Key>>
}[keyof T & string]

export type MessageKey = Leaves<Messages>

export const LOCALES = ['uz-Latn', 'uz-Cyrl', 'ru', 'en'] as const
export type Locale = (typeof LOCALES)[number]

export const LOCALE_KEY = 'moliya.locale'

const catalogs: Partial<Record<Locale, CoreMessages>> = { en }

const coreLoaders: Record<Exclude<Locale, 'en'>, () => Promise<CoreMessages>> = {
  ru: () => import('./ru').then((module) => module.ru),
  'uz-Latn': () => import('./uz-Latn').then((module) => module.uzLatn),
  'uz-Cyrl': () => import('./uz-Cyrl').then((module) => module.uzCyrl),
}

const coreLoads: Partial<Record<Locale, Promise<void>>> = {}

/** Only English ships in the startup bundle; other languages load before the first render or on switching, and fall back to English until then. */
export function loadLocale(locale: Locale): Promise<void> {
  if (locale === 'en') return Promise.resolve()
  coreLoads[locale] ??= coreLoaders[locale]().then(
    (messages) => {
      catalogs[locale] = messages
    },
    (error: unknown) => {
      delete coreLoads[locale]
      throw error
    },
  )
  return coreLoads[locale]
}

export function hasLocale(locale: Locale): boolean {
  return catalogs[locale] !== undefined
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
  return Promise.all([exportLoads[locale], loadLocale(locale)]).then(() => undefined)
}

export function hasExportMessages(locale: Locale): boolean {
  return exportCatalogs[locale] !== undefined
}

type LazyHead = 'health' | 'help'
type LazyMessages = { health: HealthMessages; help: HelpMessages }

const lazyLoaders: { [Head in LazyHead]: Record<Locale, () => Promise<LazyMessages[Head]>> } = {
  health: {
    en: () => import('./health/en').then((module) => module.healthEn),
    ru: () => import('./health/ru').then((module) => module.healthRu),
    'uz-Latn': () => import('./health/uz-Latn').then((module) => module.healthUzLatn),
    'uz-Cyrl': () => import('./health/uz-Cyrl').then((module) => module.healthUzCyrl),
  },
  help: {
    en: () => import('./help/en').then((module) => module.helpEn),
    ru: () => import('./help/ru').then((module) => module.helpRu),
    'uz-Latn': () => import('./help/uz-Latn').then((module) => module.helpUzLatn),
    'uz-Cyrl': () => import('./help/uz-Cyrl').then((module) => module.helpUzCyrl),
  },
}

const lazyCatalogs: { [Head in LazyHead]: Partial<Record<Locale, LazyMessages[Head]>> } = { health: {}, help: {} }
const lazyLoads: Record<LazyHead, Partial<Record<Locale, Promise<void>>>> = { health: {}, help: {} }

function loadLazy<Head extends LazyHead>(head: Head, locale: Locale): Promise<void> {
  lazyLoads[head][locale] ??= lazyLoaders[head][locale]().then(
    (messages) => {
      lazyCatalogs[head][locale] = messages
    },
    (error: unknown) => {
      delete lazyLoads[head][locale]
      throw error
    },
  )
  return Promise.all([lazyLoads[head][locale], loadLocale(locale)]).then(() => undefined)
}

/** The `health.*` strings load with the health check; until this resolves they translate to their keys. */
export function loadHealthMessages(locale: Locale): Promise<void> {
  return loadLazy('health', locale)
}

export function hasHealthMessages(locale: Locale): boolean {
  return lazyCatalogs.health[locale] !== undefined && hasLocale(locale)
}

/** The `help.*` strings load with the help pages; until this resolves they translate to their keys. */
export function loadHelpMessages(locale: Locale): Promise<void> {
  return loadLazy('help', locale)
}

export function hasHelpMessages(locale: Locale): boolean {
  return lazyCatalogs.help[locale] !== undefined && hasLocale(locale)
}

let tableCatalogs: Record<Locale, TableMessages> | null = null

/** The `table.*` strings ship with the table chunk, which registers them before any table renders. */
export function registerTableMessages(messages: Record<Locale, TableMessages>): void {
  tableCatalogs ??= messages
}

export function hasTableMessages(): boolean {
  return tableCatalogs !== null
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

export function detectLocale(): Locale {
  const saved = readPreference(LOCALE_KEY)
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
  const lazy = head === 'export' || head === 'table' || head === 'health' || head === 'help'
  const parts = lazy ? rest : [head, ...rest]
  let current: unknown =
    head === 'export'
      ? exportCatalogs[locale]
      : head === 'table'
        ? tableCatalogs?.[locale]
        : head === 'health' || head === 'help'
          ? lazyCatalogs[head][locale]
          : (catalogs[locale] ?? en)
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

/** `export`, `health` and `help` are missing until their loaders have resolved, and `table` until the table chunk has loaded. */
export function catalogFor(locale: Locale): Messages {
  const exportMessages = exportCatalogs[locale]
  const tableMessages = tableCatalogs?.[locale]
  const healthMessages = lazyCatalogs.health[locale]
  const helpMessages = lazyCatalogs.help[locale]
  return {
    ...(catalogs[locale] ?? en),
    ...(exportMessages ? { export: exportMessages } : {}),
    ...(tableMessages ? { table: tableMessages } : {}),
    ...(healthMessages ? { health: healthMessages } : {}),
    ...(helpMessages ? { help: helpMessages } : {}),
  } as Messages
}

export function htmlLang(locale: Locale): string {
  if (locale === 'uz-Latn') return 'uz-Latn'
  if (locale === 'uz-Cyrl') return 'uz-Cyrl'
  if (locale === 'ru') return 'ru'
  return 'en'
}
