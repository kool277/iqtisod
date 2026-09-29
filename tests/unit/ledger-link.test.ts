import { describe, expect, it } from 'vitest'
import { ledgerPathForGroup, linkedGroup } from '../../src/lib/ledger-link'

const groups = [{ id: 1 }, { id: 7 }]

describe('ledger group links', () => {
  it('builds the ledger path for a group', () => {
    expect(ledgerPathForGroup(7)).toBe('/app/transactions?group=7')
  })

  it('accepts only groups the reader can see', () => {
    expect(linkedGroup('7', groups)).toBe(7)
    expect(linkedGroup('1', groups)).toBe(1)
    expect(linkedGroup('2', groups)).toBeNull()
    expect(linkedGroup('7', [])).toBeNull()
  })

  it('ignores missing and malformed values', () => {
    for (const value of [null, '', '0', '-1', '07', '7.0', '1e1', ' 7', '7 ', 'abc', '99999999999999999999', '7&group=1']) {
      expect(linkedGroup(value, groups)).toBeNull()
    }
  })
})
