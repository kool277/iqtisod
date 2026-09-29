export type RoundingMode = 'HALF_EVEN' | 'HALF_UP' | 'DOWN'

const PLAIN_DECIMAL = /^([+-]?)(\d+)(?:\.(\d+))?$/

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent)
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value
}

function digitCount(value: bigint): number {
  return abs(value).toString().length
}

function divideRounded(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) throw new RangeError('Division by zero')
  const negative = numerator < 0n !== denominator < 0n
  const n = abs(numerator)
  const d = abs(denominator)
  let quotient = n / d
  const twice = (n % d) * 2n
  if (mode !== 'DOWN' && (twice > d || (twice === d && (mode === 'HALF_UP' || quotient % 2n === 1n)))) quotient += 1n
  return negative ? -quotient : quotient
}

function assertScale(scale: number): void {
  if (!Number.isSafeInteger(scale) || scale < -1000 || scale > 1000) throw new RangeError(`Invalid scale ${scale}`)
}

function assertPrecision(precision: number): void {
  if (!Number.isSafeInteger(precision) || precision < 1 || precision > 1000) throw new RangeError(`Invalid precision ${precision}`)
}

export class Decimal {
  readonly unscaled: bigint
  readonly scale: number

  private constructor(unscaled: bigint, scale: number) {
    this.unscaled = unscaled
    this.scale = scale
  }

  static readonly ZERO = new Decimal(0n, 0)
  static readonly ONE = new Decimal(1n, 0)

  static parse(text: string): Decimal {
    if (typeof text !== 'string') throw new TypeError('Decimal.parse accepts decimal strings only')
    const match = PLAIN_DECIMAL.exec(text)
    if (!match) throw new SyntaxError(`Not a plain decimal: ${JSON.stringify(text)}`)
    const fraction = match[3] ?? ''
    const magnitude = BigInt(match[2] + fraction)
    return new Decimal(match[1] === '-' ? -magnitude : magnitude, fraction.length)
  }

  static of(unscaled: bigint, scale = 0): Decimal {
    if (typeof unscaled !== 'bigint') throw new TypeError('Decimal.of accepts a bigint unscaled value')
    assertScale(scale)
    return Decimal.scaled(unscaled, scale)
  }

  private static scaled(unscaled: bigint, scale: number): Decimal {
    return scale >= 0 ? new Decimal(unscaled, scale) : new Decimal(unscaled * pow10(-scale), 0)
  }

  sign(): -1 | 0 | 1 {
    return this.unscaled === 0n ? 0 : this.unscaled < 0n ? -1 : 1
  }

  isZero(): boolean {
    return this.unscaled === 0n
  }

  negate(): Decimal {
    return new Decimal(-this.unscaled, this.scale)
  }

  abs(): Decimal {
    return this.unscaled < 0n ? this.negate() : this
  }

  precision(): number {
    return digitCount(this.unscaled)
  }

  adjustedExponent(): number {
    return this.isZero() ? 0 : this.precision() - 1 - this.scale
  }

  private aligned(other: Decimal): [bigint, bigint, number] {
    const scale = Math.max(this.scale, other.scale)
    return [this.unscaled * pow10(scale - this.scale), other.unscaled * pow10(scale - other.scale), scale]
  }

  add(other: Decimal): Decimal {
    const [a, b, scale] = this.aligned(other)
    return new Decimal(a + b, scale)
  }

  subtract(other: Decimal): Decimal {
    return this.add(other.negate())
  }

  multiply(other: Decimal): Decimal {
    return new Decimal(this.unscaled * other.unscaled, this.scale + other.scale)
  }

  private quotientAt(divisor: Decimal, scale: number, mode: RoundingMode): bigint {
    if (divisor.isZero()) throw new RangeError('Division by zero')
    const shift = scale - this.scale + divisor.scale
    const numerator = shift >= 0 ? this.unscaled * pow10(shift) : this.unscaled
    const denominator = shift >= 0 ? divisor.unscaled : divisor.unscaled * pow10(-shift)
    return divideRounded(numerator, denominator, mode)
  }

  divide(divisor: Decimal, scale: number, mode: RoundingMode = 'HALF_EVEN'): Decimal {
    assertScale(scale)
    return Decimal.scaled(this.quotientAt(divisor, scale, mode), scale)
  }

  divideToPrecision(divisor: Decimal, precision: number, mode: RoundingMode = 'HALF_EVEN'): Decimal {
    assertPrecision(precision)
    if (divisor.isZero()) throw new RangeError('Division by zero')
    if (this.isZero()) return Decimal.ZERO
    let scale = precision - (this.adjustedExponent() - divisor.adjustedExponent())
    let unscaled = this.quotientAt(divisor, scale, mode)
    if (digitCount(unscaled) > precision) {
      scale -= 1
      unscaled = this.quotientAt(divisor, scale, mode)
    }
    if (digitCount(unscaled) > precision) {
      unscaled /= 10n
      scale -= 1
    }
    return Decimal.scaled(unscaled, scale)
  }

  setScale(scale: number, mode: RoundingMode = 'HALF_EVEN'): Decimal {
    assertScale(scale)
    if (scale >= this.scale) return new Decimal(this.unscaled * pow10(scale - this.scale), scale)
    return Decimal.scaled(divideRounded(this.unscaled, pow10(this.scale - scale), mode), scale)
  }

  roundToPrecision(precision: number, mode: RoundingMode = 'HALF_EVEN'): Decimal {
    assertPrecision(precision)
    const excess = this.precision() - precision
    if (excess <= 0) return this
    let unscaled = divideRounded(this.unscaled, pow10(excess), mode)
    let scale = this.scale - excess
    if (digitCount(unscaled) > precision) {
      unscaled /= 10n
      scale -= 1
    }
    return Decimal.scaled(unscaled, scale)
  }

  stripTrailingZeros(): Decimal {
    if (this.isZero()) return Decimal.ZERO
    let { unscaled, scale } = this
    while (scale > 0 && unscaled % 10n === 0n) {
      unscaled /= 10n
      scale -= 1
    }
    return new Decimal(unscaled, scale)
  }

  compareTo(other: Decimal): -1 | 0 | 1 {
    const [a, b] = this.aligned(other)
    return a === b ? 0 : a < b ? -1 : 1
  }

  equals(other: Decimal): boolean {
    return this.compareTo(other) === 0
  }

  toMinorUnits(exponent: number, mode: RoundingMode = 'HALF_EVEN'): bigint {
    return this.setScale(exponent, mode).unscaled
  }

  toString(): string {
    const digits = abs(this.unscaled).toString().padStart(this.scale + 1, '0')
    const sign = this.unscaled < 0n ? '-' : ''
    if (this.scale === 0) return `${sign}${digits}`
    return `${sign}${digits.slice(0, digits.length - this.scale)}.${digits.slice(digits.length - this.scale)}`
  }

  toJSON(): string {
    return this.toString()
  }
}

type Separators = { group: string; decimal: string; minus: string }

const separatorCache = new Map<string, Separators>()

function separatorsFor(locale: string): Separators {
  const cached = separatorCache.get(locale)
  if (cached) return cached
  const parts = new Intl.NumberFormat(locale, { useGrouping: true }).formatToParts(-1234567.5)
  const find = (type: string, fallback: string) => parts.find((part) => part.type === type)?.value ?? fallback
  const separators = { group: find('group', ','), decimal: find('decimal', '.'), minus: find('minusSign', '-') }
  separatorCache.set(locale, separators)
  return separators
}

export function formatDecimal(value: Decimal, locale: string): string {
  const { group, decimal, minus } = separatorsFor(locale)
  const [whole, fraction] = value.abs().toString().split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, group)
  return `${value.sign() < 0 ? minus : ''}${grouped}${fraction ? `${decimal}${fraction}` : ''}`
}
