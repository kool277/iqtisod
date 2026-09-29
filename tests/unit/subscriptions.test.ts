import { describe, expect, it } from 'vitest'
import { ValidationError } from '../../src/domain/errors'
import type { SecureItem, SubscriptionItem } from '../../src/domain/safes'
import {
  addMonthsClamped,
  monthlyMinor,
  nextRenewal,
  safeUrl,
  subscriptionSummary,
  validateSubscription,
  yearlyMinor,
  type SubscriptionInput,
} from '../../src/domain/subscriptions'

const input: SubscriptionInput = {
  url: '',
  amountMinor: 999,
  currency: 'USD',
  cycle: 'MONTHLY',
  customDays: null,
  anchorDate: '2026-01-31',
  status: 'ACTIVE',
  trialEndsOn: null,
  remindDaysBefore: 3,
  cardItemId: null,
  account: '',
  notes: '',
}

let seq = 0
function sub(overrides: Partial<SubscriptionItem>): SecureItem {
  seq += 1
  return {
    v: 1,
    kind: 'SUBSCRIPTION',
    title: `Sub ${seq}`,
    favorite: false,
    createdAt: '',
    updatedAt: '',
    id: `item-${seq}`,
    safeId: 'safe-1',
    rev: 1,
    deletedAt: null,
    ...input,
    ...overrides,
  } as SecureItem
}

function codeOf(run: () => unknown): string | null {
  try {
    run()
    return null
  } catch (error) {
    return error instanceof ValidationError ? error.code : 'OTHER'
  }
}

describe('subscriptions', () => {
  it('normalises to monthly and yearly amounts with exact half-even rounding', () => {
    expect(monthlyMinor(999, 'MONTHLY', null)).toBe(999)
    expect(monthlyMinor(9900, 'YEARLY', null)).toBe(825)
    expect(monthlyMinor(1000, 'QUARTERLY', null)).toBe(333)
    expect(monthlyMinor(500, 'WEEKLY', null)).toBe(2167)
    expect(monthlyMinor(30, 'YEARLY', null)).toBe(2)
    expect(monthlyMinor(18, 'YEARLY', null)).toBe(2)
    expect(monthlyMinor(6, 'YEARLY', null)).toBe(0)
    expect(monthlyMinor(1000, 'CUSTOM', 30)).toBe(1015)
    expect(yearlyMinor(999, 'MONTHLY', null)).toBe(11_988)
    expect(yearlyMinor(500, 'WEEKLY', null)).toBe(26_000)
    expect(yearlyMinor(1000, 'CUSTOM', 30)).toBe(12_175)
    expect(monthlyMinor(999_999_999_999_999, 'WEEKLY', null)).toBe(4_333_333_333_333_329)
  })

  it('clamps renewals to the end of short months', () => {
    expect(addMonthsClamped('2028-01-31', 1)).toBe('2028-02-29')
    expect(addMonthsClamped('2028-01-31', 2)).toBe('2028-03-31')
    expect(nextRenewal('2028-01-31', 'MONTHLY', null, '2028-02-10')).toBe('2028-02-29')
    expect(nextRenewal('2028-01-31', 'MONTHLY', null, '2028-03-01')).toBe('2028-03-31')
    expect(nextRenewal('2027-02-28', 'YEARLY', null, '2027-03-01')).toBe('2028-02-28')
    expect(nextRenewal('2026-09-01', 'WEEKLY', null, '2026-09-09')).toBe('2026-09-15')
    expect(nextRenewal('2026-09-01', 'CUSTOM', 10, '2026-09-11')).toBe('2026-09-11')
    expect(nextRenewal('2026-12-25', 'MONTHLY', null, '2026-09-29')).toBe('2026-12-25')
    expect(nextRenewal('2026-06-30', 'QUARTERLY', null, '2026-09-30')).toBe('2026-09-30')
  })

  it('groups totals per currency and leaves paused, cancelled, and trashed ones out', () => {
    const items = [
      sub({ amountMinor: 999, cycle: 'MONTHLY', anchorDate: '2026-09-05' }),
      sub({ amountMinor: 9900, cycle: 'YEARLY', anchorDate: '2026-10-10' }),
      sub({ amountMinor: 50_000_00, currency: 'UZS', cycle: 'MONTHLY', anchorDate: '2026-09-30' }),
      sub({ amountMinor: 700, status: 'PAUSED' }),
      sub({ amountMinor: 700, status: 'CANCELLED' }),
      sub({ amountMinor: 700, deletedAt: '2026-09-01T00:00:00.000Z' }),
      { ...sub({}), kind: 'NOTE', body: '' } as SecureItem,
    ]
    const summary = subscriptionSummary(items, '2026-09-29')
    expect(summary.totals).toEqual([
      { currency: 'USD', monthlyMinor: 1824, yearlyMinor: 21_888, active: 2 },
      { currency: 'UZS', monthlyMinor: 5_000_000, yearlyMinor: 60_000_000, active: 1 },
    ])
    expect(summary.upcoming.map((entry) => [entry.date, entry.daysLeft, entry.soon])).toEqual([
      ['2026-09-30', 1, true],
      ['2026-10-05', 6, false],
      ['2026-10-10', 11, false],
    ])
  })

  it('validates subscription input', () => {
    expect(validateSubscription({ ...input, url: 'https://example.com', trialEndsOn: '' }).trialEndsOn).toBeNull()
    expect(codeOf(() => validateSubscription({ ...input, currency: 'GBP' as never }))).toBe('CURRENCY')
    expect(codeOf(() => validateSubscription({ ...input, amountMinor: 0 }))).toBe('AMOUNT')
    expect(codeOf(() => validateSubscription({ ...input, amountMinor: 1.5 }))).toBe('AMOUNT')
    expect(codeOf(() => validateSubscription({ ...input, amountMinor: 1_000_000_000_000_000 }))).toBe('AMOUNT_LIMIT')
    expect(codeOf(() => validateSubscription({ ...input, cycle: 'CUSTOM', customDays: 0 }))).toBe('CUSTOM_DAYS')
    expect(codeOf(() => validateSubscription({ ...input, anchorDate: '2026-02-30' }))).toBe('DATE')
    expect(codeOf(() => validateSubscription({ ...input, remindDaysBefore: 31 }))).toBe('REMIND_DAYS')
    expect(codeOf(() => validateSubscription({ ...input, url: 'javascript:alert(1)' }))).toBe('URL')
    expect(safeUrl('ftp://example.com')).toBeNull()
    expect(safeUrl('http://example.com/a')).toBe('http://example.com/a')
  })
})
