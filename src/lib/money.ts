import { ValidationError } from '../domain/errors'
import type { CurrencyCode } from '../domain/types'
import type { Locale } from '../i18n'

export const CURRENCY_MINOR_UNITS: Readonly<Record<CurrencyCode, number>> = {
  USD: 2,
  UZS: 2,
  EUR: 2,
  RUB: 2,
}

export const MAX_AMOUNT_MINOR = 999_999_999_999_999

export function minorUnitOf(currency: string): number {
  const exponent = (CURRENCY_MINOR_UNITS as Record<string, number | undefined>)[currency]
  if (exponent === undefined) throw new ValidationError('CURRENCY')
  return exponent
}

export function roundHalfEven(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n
  const n = numerator < 0n ? -numerator : numerator
  const d = denominator < 0n ? -denominator : denominator
  let quotient = n / d
  const twice = (n % d) * 2n
  if (twice > d || (twice === d && quotient % 2n === 1n)) quotient += 1n
  return negative ? -quotient : quotient
}

export function parseAmount(text: string, currency: string): number {
  const exponent = minorUnitOf(currency)
  const compact = text.replace(/[\s\u00a0\u202f]/g, '')
  const match = /^(\d+)(?:[.,](\d+))?$/.exec(compact)
  if (!match) throw new ValidationError('AMOUNT')
  const fraction = (match[2] ?? '').replace(/0+$/, '')
  if (fraction.length > exponent) throw new ValidationError('AMOUNT_PRECISION')
  const minor = BigInt(match[1]) * 10n ** BigInt(exponent) + BigInt(fraction.padEnd(exponent, '0') || '0')
  if (minor <= 0n) throw new ValidationError('AMOUNT')
  if (minor > BigInt(MAX_AMOUNT_MINOR)) throw new ValidationError('AMOUNT_LIMIT')
  return Number(minor)
}

export function legacyAmountToMinor(value: number, exponent: number): number {
  if (!Number.isFinite(value)) throw new Error(`Amount ${value} is not finite`)
  const [mantissa, power] = value.toExponential(14).split('e')
  const negative = mantissa.startsWith('-')
  const digits = BigInt(mantissa.replace(/[-.]/g, ''))
  const scale = Number(power) - 14 + exponent
  const magnitude = scale >= 0 ? digits * 10n ** BigInt(scale) : roundHalfEven(digits, 10n ** BigInt(-scale))
  const minor = negative ? -magnitude : magnitude
  if (minor > BigInt(Number.MAX_SAFE_INTEGER) || minor < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Amount ${value} exceeds the exact integer range`)
  }
  return Number(minor)
}

function splitMinor(minor: number, exponent: number): { sign: string; whole: string; fraction: string } {
  const digits = Math.abs(minor).toString().padStart(exponent + 1, '0')
  return {
    sign: minor < 0 ? '-' : '',
    whole: digits.slice(0, digits.length - exponent),
    fraction: digits.slice(digits.length - exponent),
  }
}

export function minorToFixed(minor: number, currency: string): string {
  const exponent = minorUnitOf(currency)
  const { sign, whole, fraction } = splitMinor(minor, exponent)
  return exponent === 0 ? `${sign}${whole}` : `${sign}${whole}.${fraction}`
}

export function minorToDecimal(minor: number, currency: string): string {
  const exponent = minorUnitOf(currency)
  const { sign, whole, fraction } = splitMinor(minor, exponent)
  const trimmed = fraction.replace(/0+$/, '')
  return trimmed ? `${sign}${whole}.${trimmed}` : `${sign}${whole}`
}

export function toMajor(minor: number, currency: string): number {
  return minor / 10 ** minorUnitOf(currency)
}

export function percentOf(numerator: number, denominator: number, decimals = 1): number {
  if (denominator === 0) return 0
  const scale = 10n ** BigInt(decimals)
  const scaled = roundHalfEven(BigInt(numerator) * 100n * scale, BigInt(denominator))
  return Number(scaled) / Number(scale)
}

export function intlLocale(locale: Locale): string {
  switch (locale) {
    case 'ru':
      return 'ru-RU'
    case 'uz-Latn':
      return 'uz-Latn-UZ'
    case 'uz-Cyrl':
      return 'uz-Cyrl-UZ'
    default:
      return 'en-US'
  }
}

export function formatMoney(minor: number, currency: string, locale: Locale): string {
  const exponent = (CURRENCY_MINOR_UNITS as Record<string, number | undefined>)[currency] ?? 2
  const fraction = minor % 10 ** exponent === 0 ? 0 : exponent
  const value = minor / 10 ** exponent
  try {
    return new Intl.NumberFormat(intlLocale(locale), {
      style: 'currency',
      currency,
      minimumFractionDigits: fraction,
      maximumFractionDigits: exponent,
    }).format(value)
  } catch {
    return `${minorToDecimal(minor, 'USD')} ${currency}`
  }
}

export function formatIsoDate(iso: string, locale: Locale): string {
  const [year, month, day] = iso.split('-').map(Number)
  const date = new Date(year, (month ?? 1) - 1, day ?? 1)
  return new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: 'medium' }).format(date)
}

export function formatWhen(value: string, locale: Locale): string {
  const date = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z')
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}
