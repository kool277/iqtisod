import { describe, expect, it } from 'vitest'
import { parseRecoveryCode } from '../../src/crypto/safe-crypto'
import { checkCardNumber, digitsOnly, luhnValid } from '../../src/domain/cards'
import { isUniqueViolation } from '../../src/domain/errors'
import { isIsoDate as isSubscriptionDate } from '../../src/domain/subscriptions'
import { normalizeAccessCode } from '../../src/lib/access-code'
import { isIsoDate } from '../../src/lib/dates'
import { isEmail } from '../../src/lib/email'
import { minorToDecimal, parseAmount } from '../../src/lib/money'
import { passwordProblem } from '../../src/lib/password-policy'
import { assertReceipt } from '../../src/lib/receipt'
import { base32Decode, isTotpCode } from '../../src/lib/totp'
import { csvCell } from '../../src/services/export/csv'
import { normalizeRecoveryCode } from '../../src/services/totp.service'

const SIZE = 100_000
const BUDGET_MS = 50

function timed(run: () => unknown): number {
  const started = performance.now()
  try {
    const result = run()
    if (result instanceof Promise) result.catch(() => undefined)
  } catch {
    // Rejecting the input is fine; only the time matters here.
  }
  return performance.now() - started
}

const adversarial: [string, () => unknown][] = [
  ['email: many dots then an invalid end', () => isEmail(`a@${'a.'.repeat(SIZE / 2)}!`)],
  ['email: many at signs', () => isEmail('@'.repeat(SIZE))],
  ['email: long local part without a domain', () => isEmail(`${'a'.repeat(SIZE)}@`)],
  ['amount: long fraction of zeros ending in a digit', () => parseAmount(`1.${'0'.repeat(SIZE)}1`, 'USD')],
  ['amount: long fraction of zeros', () => parseAmount(`1.${'0'.repeat(SIZE)}`, 'USD')],
  ['amount: digits then a letter', () => parseAmount(`${'1'.repeat(SIZE)}x`, 'USD')],
  ['amount: spaces between digits', () => parseAmount('1 '.repeat(SIZE / 2), 'UZS')],
  ['amount display', () => minorToDecimal(Number.MAX_SAFE_INTEGER, 'USD')],
  ['csv: leading whitespace before a formula sign', () => csvCell(`${' '.repeat(SIZE)}=1`)],
  ['csv: many quotes and newlines', () => csvCell('"\n'.repeat(SIZE / 2))],
  ['access code: dashes and spaces', () => normalizeAccessCode('- '.repeat(SIZE / 2))],
  ['recovery code: dashes and spaces', () => normalizeRecoveryCode('- '.repeat(SIZE / 2))],
  ['safe recovery code: dashes', () => parseRecoveryCode('-'.repeat(SIZE))],
  ['totp code: spaces', () => isTotpCode(' '.repeat(SIZE))],
  ['base32: padding and dashes', () => base32Decode('=-'.repeat(SIZE / 2))],
  ['receipt: base64 then an invalid end', () => assertReceipt(`data:image/png;base64,${'A'.repeat(SIZE)}!`)],
  ['receipt: base64 with too much padding', () => assertReceipt(`data:image/png;base64,${'A'.repeat(SIZE)}===`)],
  ['date: digits', () => isIsoDate('1'.repeat(SIZE))],
  ['subscription date: digits', () => isSubscriptionDate('1'.repeat(SIZE))],
  ['card digits', () => digitsOnly('1 '.repeat(SIZE / 2))],
  ['card check digit', () => luhnValid('1'.repeat(SIZE))],
  ['card number check', () => checkCardNumber('4'.repeat(SIZE), 'VISA')],
  ['unique violation message', () => isUniqueViolation(new Error('x'.repeat(SIZE)))],
]

describe('regular expressions stay fast on hostile input', () => {
  it.each(adversarial)('%s', (_name, run) => {
    timed(run)
    expect(timed(run)).toBeLessThan(BUDGET_MS)
  })

  it('rejects an over-long password before any pattern runs', async () => {
    const started = performance.now()
    await expect(passwordProblem(`${'!'.repeat(SIZE)}a`)).resolves.toBe('PASSWORD_LONG')
    expect(performance.now() - started).toBeLessThan(BUDGET_MS)
  })

  it('still trims trailing zeros correctly', () => {
    expect(parseAmount('12.500', 'USD')).toBe(1250)
    expect(parseAmount('7,000', 'USD')).toBe(700)
    expect(() => parseAmount('1.001', 'USD')).toThrow()
    expect(minorToDecimal(1250, 'USD')).toBe('12.5')
    expect(minorToDecimal(1200, 'USD')).toBe('12')
  })
})
