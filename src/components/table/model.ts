import { toIsoDate } from '../../lib/dates'
import { CURRENCY_MINOR_UNITS } from '../../lib/money'

export type SortType = 'text' | 'number' | 'money' | 'date'
export type Money = { minor: number | bigint; currency: string }
export type SortValue = string | number | bigint | boolean | Money | null | undefined
export type SortRule = { id: string; desc: boolean }

export type FilterOption = { value: string; label: string }

export type FilterSpec<T> =
  | { kind: 'text'; value: (row: T) => string | null }
  | { kind: 'select'; value: (row: T) => string; options: FilterOption[] }
  | { kind: 'date'; value: (row: T) => string | null }
  | { kind: 'number'; value: (row: T) => number | null }
  | { kind: 'money'; value: (row: T) => Money | null }

export type FilterValue =
  | { kind: 'text'; text: string }
  | { kind: 'select'; values: string[] }
  | { kind: 'date'; from: string; to: string }
  | { kind: 'range'; min: string; max: string }

export type FilterState = Record<string, FilterValue>

export type ColumnModel<T> = {
  id: string
  sort?: { type: SortType; value: (row: T) => SortValue }
  search?: (row: T) => string | null
  filter?: FilterSpec<T>
}

const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l',
  м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'sh', ъ: '', ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya', ў: 'o', қ: 'q', ғ: 'g', ҳ: 'h', і: 'i', є: 'e',
}

const CYRILLIC_CHAR = /[\u0400-\u04ff]/g
const MARKS = /\p{M}/gu
const APOSTROPHES = /['`´ʹʻʼʽ‘’‛]/g
const SPACES = /\s+/g

/**
 * Folds case, diacritics, and script so that "Oʻzbekcha", "ozbekcha", and "Ўзбекча" all match.
 * Cyrillic is mapped to the Uzbek Latin alphabet before marks are stripped, so й and ў keep their letters.
 */
export function fold(text: string | null | undefined): string {
  if (!text) return ''
  return text
    .toLowerCase()
    .replace(CYRILLIC_CHAR, (char) => CYRILLIC[char] ?? char)
    .normalize('NFKD')
    .replace(MARKS, '')
    .replace(APOSTROPHES, '')
    .replace(SPACES, ' ')
    .trim()
}

export function searchTerms(query: string): string[] {
  const folded = fold(query)
  return folded ? folded.split(' ') : []
}

export function matchesTerms(haystack: string, terms: readonly string[]): boolean {
  for (const term of terms) if (!haystack.includes(term)) return false
  return true
}

function exponentOf(currency: string): number {
  return (CURRENCY_MINOR_UNITS as Record<string, number | undefined>)[currency] ?? 2
}

function isMoney(value: SortValue): value is Money {
  return typeof value === 'object' && value !== null && 'minor' in value
}

/** Compares exact minor units across currencies with different exponents; equal amounts order by currency code. */
export function compareMoney(a: Money, b: Money): number {
  const ea = exponentOf(a.currency)
  const eb = exponentOf(b.currency)
  const scale = Math.max(ea, eb)
  const left = BigInt(a.minor) * 10n ** BigInt(scale - ea)
  const right = BigInt(b.minor) * 10n ** BigInt(scale - eb)
  if (left !== right) return left < right ? -1 : 1
  return a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0
}

/** Milliseconds for ISO dates (`2026-10-01`), ISO timestamps, and SQLite `YYYY-MM-DD HH:MM:SS` UTC text. */
export function dateKey(value: string): number | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number)
    return Date.UTC(year, month - 1, day)
  }
  const time = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
  return Number.isNaN(time) ? null : time
}

/** The calendar date a value falls on in this browser's time zone. */
export function localDate(value: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const time = dateKey(value)
  return time == null ? null : toIsoDate(new Date(time))
}

type Key = string | number | bigint | Money

function normalize(type: SortType, value: SortValue): Key | null {
  if (value == null) return null
  switch (type) {
    case 'money':
      return isMoney(value) ? value : null
    case 'date':
      return typeof value === 'string' ? dateKey(value) : typeof value === 'number' && Number.isFinite(value) ? value : null
    case 'number':
      if (typeof value === 'bigint') return value
      if (typeof value === 'boolean') return value ? 1 : 0
      return typeof value === 'number' && !Number.isNaN(value) ? value : null
    case 'text':
      return typeof value === 'string' ? value : isMoney(value) ? null : String(value)
  }
}

export function comparatorFor(type: SortType, collator: Intl.Collator): (a: Key, b: Key) => number {
  switch (type) {
    case 'money':
      return (a, b) => compareMoney(a as Money, b as Money)
    case 'text':
      return (a, b) => collator.compare(a as string, b as string)
    default:
      return (a, b) => {
        const left = a as number | bigint
        const right = b as number | bigint
        return left < right ? -1 : left > right ? 1 : 0
      }
  }
}

export function makeCollator(locale: string): Intl.Collator {
  return new Intl.Collator(locale, { sensitivity: 'base', numeric: true, ignorePunctuation: false })
}

/** Stable multi-column sort. Empty values always sort last, whichever direction is chosen. */
export function sortRows<T>(rows: readonly T[], rules: readonly SortRule[], columns: readonly ColumnModel<T>[], collator: Intl.Collator): T[] {
  const active = rules
    .map((rule) => ({ rule, column: columns.find((column) => column.id === rule.id) }))
    .filter((entry): entry is { rule: SortRule; column: ColumnModel<T> & { sort: NonNullable<ColumnModel<T>['sort']> } } => Boolean(entry.column?.sort))
  if (active.length === 0) return [...rows]
  const compare = active.map(({ column }) => comparatorFor(column.sort.type, collator))
  const decorated = rows.map((row, index) => ({
    row,
    index,
    keys: active.map(({ column }) => normalize(column.sort.type, column.sort.value(row))),
  }))
  decorated.sort((a, b) => {
    for (let position = 0; position < active.length; position += 1) {
      const left = a.keys[position]
      const right = b.keys[position]
      if (left === right) continue
      if (left == null) return 1
      if (right == null) return -1
      const result = compare[position](left, right)
      if (result !== 0) return active[position].rule.desc ? -result : result
    }
    return a.index - b.index
  })
  return decorated.map((entry) => entry.row)
}

/** Toggles ascending → descending → off. With `multi` the column is added to, flipped in, or removed from the existing rules. */
export function nextSort(rules: readonly SortRule[], id: string, multi: boolean, limit = 3): SortRule[] {
  const existing = rules.find((rule) => rule.id === id)
  if (!multi) {
    if (!existing || rules.length > 1) return [{ id, desc: existing && rules.length === 1 ? !existing.desc : false }]
    return existing.desc ? [] : [{ id, desc: true }]
  }
  if (!existing) return [...rules, { id, desc: false }].slice(-limit)
  if (!existing.desc) return rules.map((rule) => (rule.id === id ? { id, desc: true } : rule))
  return rules.filter((rule) => rule.id !== id)
}

const DECIMAL = /^(-)?(\d+)(?:[.,](\d+))?$/

/** Parses a user-typed bound such as "1 250,5" into an exact fraction; null when it is not a number. */
export function parseBound(text: string): { digits: bigint; scale: number } | null {
  const compact = text.replace(/[\s\u00a0\u202f']/g, '')
  if (compact.length > 40) return null
  const match = DECIMAL.exec(compact)
  if (!match) return null
  const fraction = match[3] ?? ''
  const digits = BigInt(`${match[2]}${fraction}`)
  return { digits: match[1] ? -digits : digits, scale: fraction.length }
}

function compareBound(minor: bigint, exponent: number, bound: { digits: bigint; scale: number }): number {
  const scale = Math.max(exponent, bound.scale)
  const left = minor * 10n ** BigInt(scale - exponent)
  const right = bound.digits * 10n ** BigInt(scale - bound.scale)
  return left < right ? -1 : left > right ? 1 : 0
}

export function isFilterActive(value: FilterValue | undefined): boolean {
  if (!value) return false
  switch (value.kind) {
    case 'text':
      return value.text.trim() !== ''
    case 'select':
      return value.values.length > 0
    case 'date':
      return value.from !== '' || value.to !== ''
    case 'range':
      return parseBound(value.min) != null || parseBound(value.max) != null
  }
}

type Matcher<T> = (row: T) => boolean

export function filterMatcher<T>(spec: FilterSpec<T>, value: FilterValue): Matcher<T> | null {
  if (!isFilterActive(value)) return null
  if (spec.kind === 'text' && value.kind === 'text') {
    const terms = searchTerms(value.text)
    return (row) => matchesTerms(fold(spec.value(row)), terms)
  }
  if (spec.kind === 'select' && value.kind === 'select') {
    const wanted = new Set(value.values)
    return (row) => wanted.has(spec.value(row))
  }
  if (spec.kind === 'date' && value.kind === 'date') {
    const { from, to } = value.from && value.to && value.from > value.to ? { from: value.to, to: value.from } : value
    return (row) => {
      const raw = spec.value(row)
      const day = raw == null ? null : localDate(raw)
      if (day == null) return false
      return (!from || day >= from) && (!to || day <= to)
    }
  }
  if ((spec.kind === 'number' || spec.kind === 'money') && value.kind === 'range') {
    const min = parseBound(value.min)
    const max = parseBound(value.max)
    if (spec.kind === 'number') {
      return (row) => {
        const number = spec.value(row)
        if (number == null || !Number.isFinite(number)) return false
        const bound = parseBound(String(number))
        if (!bound) return false
        const minor = bound.digits
        return (!min || compareBound(minor, bound.scale, min) >= 0) && (!max || compareBound(minor, bound.scale, max) <= 0)
      }
    }
    return (row) => {
      const money = spec.value(row)
      if (!money) return false
      const minor = BigInt(money.minor)
      const exponent = exponentOf(money.currency)
      return (!min || compareBound(minor, exponent, min) >= 0) && (!max || compareBound(minor, exponent, max) <= 0)
    }
  }
  return null
}

/** One folded string per row, built from the searchable columns. */
export function buildSearchIndex<T>(rows: readonly T[], columns: readonly ColumnModel<T>[]): string[] {
  const searchable = columns.filter((column) => column.search)
  return rows.map((row) => searchable.map((column) => fold(column.search!(row))).join('\u0001'))
}

export type ViewState = { search: string; filters: FilterState; sort: readonly SortRule[] }

export function applyView<T>(
  rows: readonly T[],
  columns: readonly ColumnModel<T>[],
  state: ViewState,
  collator: Intl.Collator,
  index: readonly string[] = buildSearchIndex(rows, columns),
): T[] {
  const terms = searchTerms(state.search)
  const matchers: Matcher<T>[] = []
  for (const column of columns) {
    const value = state.filters[column.id]
    if (!column.filter || !value) continue
    const matcher = filterMatcher(column.filter, value)
    if (matcher) matchers.push(matcher)
  }
  const kept: T[] = []
  rows.forEach((row, position) => {
    if (terms.length && !matchesTerms(index[position] ?? '', terms)) return
    for (const matcher of matchers) if (!matcher(row)) return
    kept.push(row)
  })
  return sortRows(kept, state.sort, columns, collator)
}

export type PageWindow = { page: number; pages: number; start: number; end: number }

/** `pageSize` 0 shows every row. Pages are zero-based and clamped to the rows that exist. */
export function pageWindow(total: number, pageSize: number, page: number): PageWindow {
  if (pageSize <= 0 || total === 0) return { page: 0, pages: 1, start: 0, end: total }
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const current = Math.min(Math.max(0, page), pages - 1)
  const start = current * pageSize
  return { page: current, pages, start, end: Math.min(total, start + pageSize) }
}

/** Options for a select filter built from the values present, labelled and sorted for the reader. */
export function optionsFrom<T>(rows: readonly T[], value: (row: T) => string, label: (value: string) => string, collator: Intl.Collator): FilterOption[] {
  const seen = new Set<string>()
  for (const row of rows) seen.add(value(row))
  return [...seen].map((item) => ({ value: item, label: label(item) })).sort((a, b) => collator.compare(a.label, b.label))
}

export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match))
}
