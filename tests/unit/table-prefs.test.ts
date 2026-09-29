import { describe, expect, it } from 'vitest'
import { completeOrder, parsePrefs, prefsKey, serializePrefs, type PrefsShape, type TablePrefs } from '../../src/components/table/prefs'

const shape: PrefsShape = { columnIds: ['date', 'amount', 'notes', 'user'], hideable: ['amount', 'notes', 'user'], sortable: ['date', 'amount'] }
const defaults: TablePrefs = { hidden: ['user'], order: ['date', 'amount', 'notes', 'user'], pageSize: 25, sort: [{ id: 'date', desc: true }], dense: false }

describe('table layout preferences', () => {
  it('round-trips the layout and nothing else', () => {
    const prefs: TablePrefs = { hidden: ['notes'], order: ['amount', 'date', 'notes', 'user'], pageSize: 100, sort: [{ id: 'amount', desc: false }], dense: true }
    const text = serializePrefs(prefs)
    expect(JSON.parse(text)).toEqual({ v: 1, ...prefs })
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['dense', 'hidden', 'order', 'pageSize', 'sort', 'v'])
    expect(parsePrefs(text, shape, defaults)).toEqual(prefs)
  })

  it('stores under the moliya.table prefix and refuses odd table ids', () => {
    expect(prefsKey('transactions')).toBe('moliya.table.transactions')
    expect(prefsKey('safe-items')).toBe('moliya.table.safe-items')
    for (const id of ['', 'Upper', '../x', 'a.b', 'x'.repeat(42), '__proto__']) expect(() => prefsKey(id)).toThrow()
  })

  it('falls back to the defaults for missing, broken, oversized, or other-version data', () => {
    for (const raw of [null, '', '{', '[]', 'null', '42', '{"v":2,"hidden":["notes"]}', '{"hidden":["notes"]}', `{"v":1,"pad":"${'x'.repeat(5000)}"}`]) {
      expect(parsePrefs(raw, shape, defaults)).toEqual(defaults)
    }
    const deep = `{"v":1,"hidden":[[[[[["notes"]]]]]]}`
    expect(parsePrefs(deep, shape, defaults)).toEqual(defaults)
  })

  it('drops unknown or locked columns, bad page sizes, and invalid or duplicate sort rules', () => {
    const raw = JSON.stringify({
      v: 1,
      hidden: ['date', 'ghost', 'notes', 'notes', 7],
      order: ['user', 'ghost', 'user', 'date'],
      pageSize: 33,
      sort: [{ id: 'amount', desc: 'yes' }, { id: 'notes', desc: true }, { id: 'date', desc: false }, { id: 'date', desc: true }, null],
      dense: 'yes',
    })
    expect(parsePrefs(raw, shape, defaults)).toEqual({
      hidden: ['notes'],
      order: ['user', 'date', 'amount', 'notes'],
      pageSize: 25,
      sort: [{ id: 'date', desc: false }],
      dense: false,
    })
    expect(parsePrefs(JSON.stringify({ v: 1, pageSize: 0 }), shape, defaults).pageSize).toBe(0)
  })

  it('rejects stored data carrying prototype keys', () => {
    const raw = '{"v":1,"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"hidden":["notes"]}'
    expect(parsePrefs(raw, shape, defaults)).toEqual(defaults)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('keeps new columns at the end of a stored order', () => {
    expect(completeOrder(['notes', 'date'], ['date', 'amount', 'notes', 'user'])).toEqual(['notes', 'date', 'amount', 'user'])
    expect(completeOrder(['gone'], ['date'])).toEqual(['date'])
  })
})
