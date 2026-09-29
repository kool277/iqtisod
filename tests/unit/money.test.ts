import { describe, expect, it } from 'vitest'
import { AppError } from '../../src/domain/errors'
import {
  MAX_AMOUNT_MINOR,
  formatMoney,
  legacyAmountToMinor,
  minorToDecimal,
  minorToFixed,
  parseAmount,
  percentOf,
  toMajor,
} from '../../src/lib/money'

function codeOf(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (error) {
    return error instanceof AppError ? error.code : 'unexpected'
  }
}

describe('money', () => {
  it('parses decimal text into exact minor units', () => {
    expect(parseAmount('1000', 'USD')).toBe(100_000)
    expect(parseAmount('0.10', 'USD')).toBe(10)
    expect(parseAmount('0,2', 'EUR')).toBe(20)
    expect(parseAmount('1 234.56', 'USD')).toBe(123_456)
    expect(parseAmount('1\u00a0234,5', 'RUB')).toBe(123_450)
    expect(parseAmount('12.340', 'USD')).toBe(1234)
    expect(parseAmount(' 7 ', 'UZS')).toBe(700)
    expect(parseAmount('9999999999999.99', 'USD')).toBe(MAX_AMOUNT_MINOR)
  })

  it('rejects amounts it cannot store exactly', () => {
    expect(codeOf(() => parseAmount('12.345', 'USD'))).toBe('AMOUNT_PRECISION')
    expect(codeOf(() => parseAmount('10000000000000', 'USD'))).toBe('AMOUNT_LIMIT')
    for (const bad of ['', '0', '0.00', '-5', '+5', '1e3', '1.2.3', '1,000.50', 'abc', 'NaN', 'Infinity', '.5']) {
      expect(codeOf(() => parseAmount(bad, 'USD')), bad).toBe('AMOUNT')
    }
    expect(codeOf(() => parseAmount('5', 'XYZ'))).toBe('CURRENCY')
  })

  it('converts 1.0.0 floating-point amounts to minor units at 15 significant digits', () => {
    expect(legacyAmountToMinor(19.99, 2)).toBe(1999)
    expect(legacyAmountToMinor(0.1, 2)).toBe(10)
    expect(legacyAmountToMinor(0.1 + 0.2, 2)).toBe(30)
    expect(legacyAmountToMinor(2.68, 2)).toBe(268)
    expect(legacyAmountToMinor(1234.56, 2)).toBe(123_456)
    expect(legacyAmountToMinor(12_500_000.75, 2)).toBe(1_250_000_075)
    expect(legacyAmountToMinor(999_999.99, 2)).toBe(99_999_999)
    expect(legacyAmountToMinor(2.675, 2)).toBe(268)
    expect(legacyAmountToMinor(2.665, 2)).toBe(266)
    expect(legacyAmountToMinor(5, 0)).toBe(5)
    expect(() => legacyAmountToMinor(Number.NaN, 2)).toThrow()
    expect(() => legacyAmountToMinor(1e300, 2)).toThrow()
  })

  it('renders minor units without floating-point drift', () => {
    expect(minorToFixed(100_000, 'USD')).toBe('1000.00')
    expect(minorToFixed(5, 'USD')).toBe('0.05')
    expect(minorToFixed(-1050, 'USD')).toBe('-10.50')
    expect(minorToDecimal(100_000, 'USD')).toBe('1000')
    expect(minorToDecimal(1050, 'USD')).toBe('10.5')
    expect(minorToDecimal(MAX_AMOUNT_MINOR, 'USD')).toBe('9999999999999.99')
    expect(toMajor(123_456, 'USD')).toBe(1234.56)
    expect(formatMoney(123_456, 'USD', 'en')).toBe('$1,234.56')
    expect(formatMoney(100_000, 'USD', 'en')).toBe('$1,000')
    expect(formatMoney(1050, 'USD', 'en')).toBe('$10.50')
  })

  it('computes percentages exactly with banker’s rounding', () => {
    expect(percentOf(292_464, 420_001)).toBe(69.6)
    expect(percentOf(1, 3)).toBe(33.3)
    expect(percentOf(2, 3)).toBe(66.7)
    expect(percentOf(1, 8)).toBe(12.5)
    expect(percentOf(1, 16)).toBe(6.2)
    expect(percentOf(3, 16)).toBe(18.8)
    expect(percentOf(-1, 4)).toBe(-25)
    expect(percentOf(5, 0)).toBe(0)
    expect(percentOf(MAX_AMOUNT_MINOR - 1, MAX_AMOUNT_MINOR)).toBe(100)
  })
})
