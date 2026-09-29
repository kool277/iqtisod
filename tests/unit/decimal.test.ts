import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Decimal, formatDecimal, type RoundingMode } from '../../src/lib/decimal'

const d = (text: string) => Decimal.parse(text)

function random(seed: number) {
  let state = seed
  return (max: bigint) => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    let value = BigInt(state)
    for (let index = 0; index < 4; index += 1) {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
      value = value * 2_147_483_648n + BigInt(state)
    }
    return value % max
  }
}

describe('Decimal parsing', () => {
  it('accepts plain decimal strings and keeps their scale', () => {
    expect(d('11825.40').toString()).toBe('11825.40')
    expect(d('11825.40').scale).toBe(2)
    expect(d('-0.001').toString()).toBe('-0.001')
    expect(d('+7').toString()).toBe('7')
    expect(d('000123.4500').toString()).toBe('123.4500')
  })

  it('rejects numbers and anything that is not a plain decimal', () => {
    expect(() => Decimal.parse(0.1 as unknown as string)).toThrow(TypeError)
    expect(() => Decimal.of(5 as unknown as bigint)).toThrow(TypeError)
    for (const bad of ['', '1.', '.5', '1e5', '1,5', 'NaN', 'Infinity', ' 1', '0x10', '1_000']) {
      expect(() => d(bad), bad).toThrow(SyntaxError)
    }
  })
})

describe('Decimal arithmetic', () => {
  it('adds, subtracts, and multiplies exactly', () => {
    expect(d('0.1').add(d('0.2')).equals(d('0.3'))).toBe(true)
    expect(d('0.3').subtract(d('0.1')).toString()).toBe('0.2')
    expect(d('1.1').multiply(d('1.1')).toString()).toBe('1.21')
    expect(d('11806.97').multiply(d('1234.5')).toString()).toBe('14575704.465')
    expect(d('99999999999999999999.99').add(d('0.01')).toString()).toBe('100000000000000000000.00')
  })

  it('compares values independent of scale', () => {
    expect(d('1.50').compareTo(d('1.5'))).toBe(0)
    expect(d('1.500001').compareTo(d('1.5'))).toBe(1)
    expect(d('-2').compareTo(d('1'))).toBe(-1)
    expect(d('1.2300').stripTrailingZeros().toString()).toBe('1.23')
    expect(d('0.000').stripTrailingZeros().toString()).toBe('0')
  })

  it('rounds half to even by default', () => {
    const cases: [string, number, string][] = [
      ['0.125', 2, '0.12'],
      ['0.135', 2, '0.14'],
      ['-0.125', 2, '-0.12'],
      ['2.5', 0, '2'],
      ['3.5', 0, '4'],
      ['-3.5', 0, '-4'],
      ['1357.5', 0, '1358'],
      ['1356.5', 0, '1356'],
      ['14575704.465', 2, '14575704.46'],
      ['0.1251', 2, '0.13'],
    ]
    for (const [input, scale, expected] of cases) expect(d(input).setScale(scale).toString(), input).toBe(expected)
  })

  it('supports half-up and truncation when asked explicitly', () => {
    const modes: [RoundingMode, string][] = [
      ['HALF_EVEN', '2'],
      ['HALF_UP', '3'],
      ['DOWN', '2'],
    ]
    for (const [mode, expected] of modes) expect(d('2.5').setScale(0, mode).toString()).toBe(expected)
    expect(d('-2.9').setScale(0, 'DOWN').toString()).toBe('-2')
  })

  it('divides to a fixed scale or to significant digits', () => {
    expect(d('1').divideToPrecision(d('3'), 20).toString()).toBe('0.33333333333333333333')
    expect(d('2').divideToPrecision(d('3'), 20).toString()).toBe('0.66666666666666666667')
    expect(d('1').divideToPrecision(d('11806.97'), 20).toString()).toBe('0.000084695734807490829569')
    expect(d('1').divideToPrecision(d('11806.97'), 6).toString()).toBe('0.0000846957')
    expect(d('1545.05').divideToPrecision(d('1.1378'), 12).toString()).toBe('1357.92757954')
    expect(d('1000000').divide(d('11806.97'), 2).toString()).toBe('84.70')
    expect(d('10').divide(d('4'), 0).toString()).toBe('2')
    expect(d('-1').divide(d('8'), 2).toString()).toBe('-0.12')
    expect(() => d('1').divide(Decimal.ZERO, 2)).toThrow(RangeError)
  })

  it('handles carries into a new digit when rounding to significant digits', () => {
    expect(d('9.9999').roundToPrecision(3).toString()).toBe('10.0')
    expect(d('999.96').roundToPrecision(4).toString()).toBe('1000')
    expect(d('99999.5').roundToPrecision(5).equals(d('100000'))).toBe(true)
    expect(d('19999').divideToPrecision(d('2'), 3).equals(d('10000'))).toBe(true)
    expect(d('857231352795226369').divideToPrecision(d('442285753857'), 1).toString()).toBe('2000000')
    expect(d('857231352795226369').divideToPrecision(d('442285753857'), 2).toString()).toBe('1900000')
    expect(d('2000000').roundToPrecision(1).toString()).toBe('2000000')
  })

  it('always returns the correctly rounded quotient (checked with exact integer arithmetic)', () => {
    const next = random(20260929)
    for (let round = 0; round < 2000; round += 1) {
      const a = Decimal.of(next(10n ** 18n) + 1n, Number(next(12n)))
      const b = Decimal.of(next(10n ** 12n) + 1n, Number(next(8n)))
      const precision = 1 + Number(next(25n))
      const q = a.divideToPrecision(b, precision)
      expect(q.unscaled.toString().replace(/0+$/, '').length).toBeLessThanOrEqual(precision)
      const ulpExponent = q.adjustedExponent() - precision + 1
      const difference = q.unscaled * b.unscaled * 10n ** BigInt(a.scale) - a.unscaled * 10n ** BigInt(q.scale + b.scale)
      const twiceError = (difference < 0n ? -difference : difference) * 2n
      const shift = ulpExponent + q.scale + a.scale
      const withinHalfUlp = shift >= 0 ? twiceError <= b.unscaled * 10n ** BigInt(shift) : twiceError * 10n ** BigInt(-shift) <= b.unscaled
      expect(withinHalfUlp, `${a} / ${b} @${precision} = ${q}`).toBe(true)
    }
  })

  it('converts to integer minor units with ISO exponents', () => {
    expect(d('1357.5').toMinorUnits(0)).toBe(1358n)
    expect(d('84.695').toMinorUnits(2)).toBe(8470n)
    expect(d('84.685').toMinorUnits(2)).toBe(8468n)
    expect(d('12').toMinorUnits(2)).toBe(1200n)
  })
})

describe('formatDecimal', () => {
  it('groups digits for the locale without passing through floating point', () => {
    expect(formatDecimal(d('11806.97'), 'en-US')).toBe('11,806.97')
    expect(formatDecimal(d('12345678901234567890.123456789012'), 'en-US')).toBe('12,345,678,901,234,567,890.123456789012')
    expect(formatDecimal(d('-0.0000846957'), 'en-US')).toBe('-0.0000846957')
    expect(formatDecimal(d('1234'), 'en-US')).toBe('1,234')
    expect(formatDecimal(d('11806.97'), 'ru-RU')).toMatch(/^11\s806,97$/u)
    expect(formatDecimal(d('11806.97'), 'uz-Latn-UZ')).toMatch(/^11\s806,97$/u)
  })
})