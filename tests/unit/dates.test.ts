import { describe, expect, it } from 'vitest'
import { rangeForPreset } from '../../src/lib/dates'

const september = new Date(2026, 8, 16)

describe('rangeForPreset', () => {
  it('builds day, week, month, last month, and year-to-date ranges', () => {
    expect(rangeForPreset('day', september)).toEqual({ start: '2026-09-16', end: '2026-09-16' })
    expect(rangeForPreset('week', september)).toEqual({ start: '2026-09-14', end: '2026-09-20' })
    expect(rangeForPreset('month', september)).toEqual({ start: '2026-09-01', end: '2026-09-30' })
    expect(rangeForPreset('lastMonth', september)).toEqual({ start: '2026-08-01', end: '2026-08-31' })
    expect(rangeForPreset('ytd', september)).toEqual({ start: '2026-01-01', end: '2026-09-16' })
  })

  it('keeps a week that starts in the previous month', () => {
    expect(rangeForPreset('week', new Date(2026, 8, 1))).toEqual({ start: '2026-08-31', end: '2026-09-06' })
  })

  it('orders a custom range when the dates are reversed', () => {
    expect(rangeForPreset('custom', september, { start: '2026-09-20', end: '2026-09-02' })).toEqual({
      start: '2026-09-02',
      end: '2026-09-20',
    })
  })
})
