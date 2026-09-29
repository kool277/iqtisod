import { describe, expect, it } from 'vitest'
import {
  applyView,
  buildSearchIndex,
  compareMoney,
  dateKey,
  filterMatcher,
  fold,
  isFilterActive,
  localDate,
  makeCollator,
  nextSort,
  pageWindow,
  parseBound,
  searchTerms,
  sortRows,
  type ColumnModel,
  type Money,
} from '../../src/components/table/model'

type Row = { id: number; name: string; amount: Money | null; date: string | null; kind: string; count?: number }

const columns: ColumnModel<Row>[] = [
  { id: 'name', sort: { type: 'text', value: (row) => row.name }, search: (row) => row.name, filter: { kind: 'text', value: (row) => row.name } },
  { id: 'amount', sort: { type: 'money', value: (row) => row.amount }, filter: { kind: 'money', value: (row) => row.amount } },
  { id: 'date', sort: { type: 'date', value: (row) => row.date }, filter: { kind: 'date', value: (row) => row.date } },
  { id: 'kind', sort: { type: 'text', value: (row) => row.kind }, search: (row) => row.kind, filter: { kind: 'select', value: (row) => row.kind, options: [] } },
  { id: 'count', sort: { type: 'number', value: (row) => row.count }, filter: { kind: 'number', value: (row) => row.count ?? null } },
]

const usd = (minor: number | bigint): Money => ({ minor, currency: 'USD' })

const rows: Row[] = [
  { id: 1, name: 'Oziq-ovqat', amount: usd(25_050), date: '2026-09-15', kind: 'EXPENSE', count: 3 },
  { id: 2, name: 'Ўзбекча дарс', amount: usd(100_000), date: '2026-09-01', kind: 'INCOME', count: 10 },
  { id: 3, name: 'Café', amount: null, date: null, kind: 'EXPENSE' },
  { id: 4, name: 'Qarz', amount: usd(-500), date: '2026-10-02 08:00:00', kind: 'EXPENSE', count: 2 },
  { id: 5, name: 'Ёлка', amount: usd(25_050), date: '2026-09-15T23:30:00.000Z', kind: 'INCOME', count: 2.5 },
]

const ids = (list: Row[]) => list.map((row) => row.id)

describe('search folding', () => {
  it('folds case, diacritics, apostrophes, and Uzbek Cyrillic onto Uzbek Latin', () => {
    expect(fold('Oʻzbekcha')).toBe('ozbekcha')
    expect(fold("O'ZBEKCHA")).toBe('ozbekcha')
    expect(fold('Ўзбекча')).toBe('ozbekcha')
    expect(fold('Ҳисоб-китоб')).toBe('hisob-kitob')
    expect(fold('Қарз')).toBe(fold('Qarz'))
    expect(fold('Ғалла')).toBe('galla')
    expect(fold('Café  crème')).toBe('cafe creme')
    expect(fold('Ёлка')).toBe('yolka')
    expect(fold(null)).toBe('')
    expect(searchTerms('  Ўзбек   ДАРС ')).toEqual(['ozbek', 'dars'])
  })

  it('matches every term across searchable columns in either script', () => {
    const index = buildSearchIndex(rows, columns)
    const view = (search: string) => ids(applyView(rows, columns, { search, filters: {}, sort: [] }, makeCollator('en'), index))
    expect(view('ozbekcha')).toEqual([2])
    expect(view('Oʻzbekcha dars')).toEqual([2])
    expect(view('қарз')).toEqual([4])
    expect(view('cafe')).toEqual([3])
    expect(view('income yolka')).toEqual([5])
    expect(view('')).toEqual([1, 2, 3, 4, 5])
    expect(view('nothing-like-this')).toEqual([])
  })
})

describe('typed sorting', () => {
  const collator = makeCollator('en')

  it('compares money exactly in minor units, beyond double precision', () => {
    expect(compareMoney(usd(100), usd(99))).toBe(1)
    expect(compareMoney(usd(9_007_199_254_740_993n), usd(9_007_199_254_740_992n))).toBe(1)
    expect(compareMoney(usd(-1), usd(0))).toBe(-1)
    expect(compareMoney({ minor: 5, currency: 'EUR' }, { minor: 5, currency: 'USD' })).toBe(-1)
    expect(compareMoney(usd(5), usd(5))).toBe(0)
  })

  it('sorts money, dates, numbers, and text, keeping empty values last both ways', () => {
    expect(ids(sortRows(rows, [{ id: 'amount', desc: false }], columns, collator))).toEqual([4, 1, 5, 2, 3])
    expect(ids(sortRows(rows, [{ id: 'amount', desc: true }], columns, collator))).toEqual([2, 1, 5, 4, 3])
    expect(ids(sortRows(rows, [{ id: 'date', desc: false }], columns, collator))).toEqual([2, 1, 5, 4, 3])
    expect(ids(sortRows(rows, [{ id: 'count', desc: true }], columns, collator))).toEqual([2, 1, 5, 4, 3])
  })

  it('breaks ties with a second rule and otherwise keeps the original order', () => {
    expect(ids(sortRows(rows, [{ id: 'kind', desc: false }, { id: 'count', desc: true }], columns, collator))).toEqual([1, 4, 3, 2, 5])
    expect(ids(sortRows(rows, [{ id: 'kind', desc: false }], columns, collator))).toEqual([1, 3, 4, 2, 5])
    expect(ids(sortRows(rows, [{ id: 'unknown', desc: false }], columns, collator))).toEqual([1, 2, 3, 4, 5])
  })

  it('orders text with the active locale collator', () => {
    const words: Row[] = ['Яблоко', 'арбуз', 'Ёж', 'ёлка', 'Жук'].map((name, index) => ({ id: index, name, amount: null, date: null, kind: '' }))
    const names = (locale: string) => sortRows(words, [{ id: 'name', desc: false }], columns, makeCollator(locale)).map((row) => row.name)
    expect(names('ru-RU')).toEqual(['арбуз', 'Ёж', 'ёлка', 'Жук', 'Яблоко'])
    const numbered: Row[] = ['Item 10', 'item 2', 'Item 1'].map((name, index) => ({ id: index, name, amount: null, date: null, kind: '' }))
    expect(sortRows(numbered, [{ id: 'name', desc: false }], columns, makeCollator('uz-Latn-UZ')).map((row) => row.name)).toEqual(['Item 1', 'item 2', 'Item 10'])
  })

  it('reads ISO dates, ISO timestamps, and SQLite UTC text', () => {
    expect(dateKey('2026-09-15')).toBe(Date.UTC(2026, 8, 15))
    expect(dateKey('2026-09-15 10:00:00')).toBe(Date.UTC(2026, 8, 15, 10))
    expect(dateKey('2026-09-15T10:00:00.000Z')).toBe(Date.UTC(2026, 8, 15, 10))
    expect(dateKey('not a date')).toBeNull()
  })

  it('cycles a column through ascending, descending, and off; shift adds up to three columns', () => {
    expect(nextSort([], 'a', false)).toEqual([{ id: 'a', desc: false }])
    expect(nextSort([{ id: 'a', desc: false }], 'a', false)).toEqual([{ id: 'a', desc: true }])
    expect(nextSort([{ id: 'a', desc: true }], 'a', false)).toEqual([])
    expect(nextSort([{ id: 'a', desc: false }], 'b', false)).toEqual([{ id: 'b', desc: false }])
    const multi = nextSort(nextSort([{ id: 'a', desc: false }], 'b', true), 'c', true)
    expect(multi).toEqual([{ id: 'a', desc: false }, { id: 'b', desc: false }, { id: 'c', desc: false }])
    expect(nextSort(multi, 'd', true)).toEqual([{ id: 'b', desc: false }, { id: 'c', desc: false }, { id: 'd', desc: false }])
    expect(nextSort(multi, 'b', true)).toEqual([{ id: 'a', desc: false }, { id: 'b', desc: true }, { id: 'c', desc: false }])
    expect(nextSort([{ id: 'a', desc: false }, { id: 'b', desc: true }], 'b', true)).toEqual([{ id: 'a', desc: false }])
    expect(nextSort([{ id: 'a', desc: false }, { id: 'b', desc: true }], 'a', false)).toEqual([{ id: 'a', desc: false }])
  })
})

describe('column filters', () => {
  const run = (column: string, value: Parameters<typeof filterMatcher>[1]) => {
    const spec = columns.find((item) => item.id === column)!.filter!
    const matcher = filterMatcher(spec, value)
    return matcher ? ids(rows.filter(matcher)) : ids(rows)
  }

  it('parses typed bounds exactly, with spaces and either decimal mark', () => {
    expect(parseBound('1 250,5')).toEqual({ digits: 12505n, scale: 1 })
    expect(parseBound('-0.01')).toEqual({ digits: -1n, scale: 2 })
    expect(parseBound('12e3')).toBeNull()
    expect(parseBound('')).toBeNull()
    expect(parseBound('1'.repeat(41))).toBeNull()
  })

  it('filters money by an inclusive range in major units without floating point', () => {
    expect(run('amount', { kind: 'range', min: '250.50', max: '' })).toEqual([1, 2, 5])
    expect(run('amount', { kind: 'range', min: '', max: '250,5' })).toEqual([1, 4, 5])
    expect(run('amount', { kind: 'range', min: '250.51', max: '999.99' })).toEqual([])
    expect(run('amount', { kind: 'range', min: '-5', max: '-5' })).toEqual([4])
    expect(run('amount', { kind: 'range', min: 'abc', max: '' })).toEqual([1, 2, 3, 4, 5])
  })

  it('filters numbers, dates (either order, local calendar day), text, and select values', () => {
    expect(run('count', { kind: 'range', min: '2.5', max: '3' })).toEqual([1, 5])
    const lateDay = localDate('2026-09-15T23:30:00.000Z')!
    expect(run('date', { kind: 'date', from: '2026-09-15', to: '2026-09-01' })).toEqual(lateDay === '2026-09-15' ? [1, 2, 5] : [1, 2])
    expect(run('date', { kind: 'date', from: lateDay, to: lateDay })).toContain(5)
    expect(run('date', { kind: 'date', from: '2026-10-01', to: '' })).toContain(4)
    expect(run('name', { kind: 'text', text: 'ЎЗБЕК' })).toEqual([2])
    expect(run('kind', { kind: 'select', values: ['INCOME'] })).toEqual([2, 5])
    expect(run('kind', { kind: 'select', values: [] })).toEqual([1, 2, 3, 4, 5])
    expect(isFilterActive({ kind: 'range', min: 'x', max: '' })).toBe(false)
    expect(isFilterActive({ kind: 'date', from: '', to: '2026-01-01' })).toBe(true)
  })

  it('combines search, filters, and sort into one view', () => {
    const view = applyView(
      rows,
      columns,
      { search: 'a', filters: { kind: { kind: 'select', values: ['EXPENSE'] } }, sort: [{ id: 'amount', desc: true }] },
      makeCollator('en'),
    )
    expect(ids(view)).toEqual([1, 4, 3])
  })
})

describe('pagination', () => {
  it('clamps pages and shows everything for page size 0', () => {
    expect(pageWindow(95, 25, 0)).toEqual({ page: 0, pages: 4, start: 0, end: 25 })
    expect(pageWindow(95, 25, 3)).toEqual({ page: 3, pages: 4, start: 75, end: 95 })
    expect(pageWindow(95, 25, 9)).toEqual({ page: 3, pages: 4, start: 75, end: 95 })
    expect(pageWindow(95, 0, 2)).toEqual({ page: 0, pages: 1, start: 0, end: 95 })
    expect(pageWindow(0, 10, 0)).toEqual({ page: 0, pages: 1, start: 0, end: 0 })
  })
})
