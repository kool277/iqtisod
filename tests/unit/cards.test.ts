import { describe, expect, it } from 'vitest'
import {
  checkCardNumber,
  detectBrand,
  expiryLabel,
  expiryStatus,
  formatPan,
  luhnValid,
  maskPan,
  validateCard,
} from '../../src/domain/cards'
import { ValidationError } from '../../src/domain/errors'

const base = { cardholder: ' Aziza  Karimova ', brand: 'VISA' as const, expMonth: 8, expYear: 2029, cvv: null, bank: '', notes: '' }

function codeOf(run: () => unknown): string | null {
  try {
    run()
    return null
  } catch (error) {
    return error instanceof ValidationError ? error.code : 'OTHER'
  }
}

describe('cards', () => {
  it('checks Luhn with known test numbers', () => {
    for (const number of ['4111111111111111', '5555555555554444', '378282246310005', '2221000000000009']) {
      expect(luhnValid(number), number).toBe(true)
    }
    expect(luhnValid('4111111111111112')).toBe(false)
    expect(luhnValid('41x1')).toBe(false)
  })

  it('detects every brand prefix and range boundary', () => {
    expect(detectBrand('4111111111111111')).toBe('VISA')
    expect(detectBrand('5105105105105100')).toBe('MASTERCARD')
    expect(detectBrand('5500000000000004')).toBe('MASTERCARD')
    expect(detectBrand('2220999999999999')).toBe('OTHER')
    expect(detectBrand('2221000000000009')).toBe('MASTERCARD')
    expect(detectBrand('2720990000000000')).toBe('MASTERCARD')
    expect(detectBrand('2721000000000000')).toBe('OTHER')
    expect(detectBrand('2200000000000004')).toBe('MIR')
    expect(detectBrand('2204999999999999')).toBe('MIR')
    expect(detectBrand('2205000000000000')).toBe('OTHER')
    expect(detectBrand('340000000000009')).toBe('AMEX')
    expect(detectBrand('378282246310005')).toBe('AMEX')
    expect(detectBrand('6200000000000005')).toBe('UNIONPAY')
    expect(detectBrand('8600123412341234')).toBe('UZCARD')
    expect(detectBrand('5614123412341234')).toBe('UZCARD')
    expect(detectBrand('9860123412341234')).toBe('HUMO')
    expect(detectBrand('')).toBe('OTHER')
  })

  it('is strict about Luhn for global schemes and lenient for local ones', () => {
    expect(checkCardNumber('4111111111111112', 'VISA')).toEqual({ valid: false, luhnWarning: false })
    expect(checkCardNumber('8600123412341234', 'UZCARD')).toEqual({ valid: true, luhnWarning: !luhnValid('8600123412341234') })
    expect(checkCardNumber('9860123412341234', 'HUMO').valid).toBe(true)
    expect(checkCardNumber('411111111111111', 'VISA').valid).toBe(false)
    expect(checkCardNumber('37828224631000', 'AMEX').valid).toBe(false)
    expect(checkCardNumber('12345678901', 'OTHER').valid).toBe(false)
  })

  it('masks and formats numbers without leaking more than the last four digits', () => {
    expect(maskPan('4111111111111111')).toBe('•••• 1111')
    expect(formatPan('4111111111111111', 'VISA')).toBe('4111 1111 1111 1111')
    expect(formatPan('378282246310005', 'AMEX')).toBe('3782 822463 10005')
    expect(expiryLabel(3, 2031)).toBe('03/31')
  })

  it('reports expiry status at month boundaries', () => {
    expect(expiryStatus(9, 2026, '2026-09-30')).toBe('SOON')
    expect(expiryStatus(9, 2026, '2026-10-01')).toBe('EXPIRED')
    expect(expiryStatus(11, 2026, '2026-09-29')).toBe('OK')
    expect(expiryStatus(11, 2026, '2026-10-01')).toBe('SOON')
    expect(expiryStatus(12, 2026, '2026-09-29')).toBe('OK')
    expect(expiryStatus(2, 2028, '2028-02-29')).toBe('SOON')
    expect(expiryStatus(2, 2028, '2028-03-01')).toBe('EXPIRED')
  })

  it('validates card input, keeps CVV optional, and never asks for a PIN', () => {
    const card = validateCard({ ...base, number: '4111 1111 1111 1111' })
    expect(card).toEqual({ ...base, cardholder: 'Aziza Karimova', number: '4111111111111111', cvv: null })
    expect(Object.keys(card)).not.toContain('pin')
    expect(validateCard({ ...base, number: '4111111111111111', cvv: ' 737 ' }).cvv).toBe('737')
    expect(validateCard({ ...base, number: '4111111111111111', cvv: '' }).cvv).toBeNull()
    expect(codeOf(() => validateCard({ ...base, number: '4111111111111112' }))).toBe('CARD_NUMBER')
    expect(codeOf(() => validateCard({ ...base, number: '4111111111111111', brand: 'BOGUS' as never }))).toBe('CARD_NUMBER')
    expect(codeOf(() => validateCard({ ...base, number: '4111111111111111', expMonth: 13 }))).toBe('CARD_EXPIRY')
    expect(codeOf(() => validateCard({ ...base, number: '4111111111111111', expYear: 1999 }))).toBe('CARD_EXPIRY')
    expect(codeOf(() => validateCard({ ...base, number: '4111111111111111', cvv: '12' }))).toBe('CVV')
    expect(codeOf(() => validateCard({ ...base, number: '4111111111111111', cvv: '12a' }))).toBe('CVV')
    expect(codeOf(() => validateCard({ ...base, number: '4111111111111111', cardholder: 'x'.repeat(81) }))).toBe('TOO_LONG')
  })
})
