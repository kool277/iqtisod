import type { Locale } from '../i18n'
import { Decimal, formatDecimal } from './decimal'
import { CURRENCY_MINOR_UNITS, formatMoney, intlLocale } from './money'

const SAFE = BigInt(Number.MAX_SAFE_INTEGER)

function exponentOf(currency: string): number {
  return (CURRENCY_MINOR_UNITS as Record<string, number | undefined>)[currency] ?? 2
}

/** `formatMoney` for bigint totals; beyond 2^53 it falls back to exact digits plus the currency code. */
export function formatMinorExact(minor: bigint, currency: string, locale: Locale): string {
  if (minor <= SAFE && minor >= -SAFE) return formatMoney(Number(minor), currency, locale)
  return `${formatDecimal(Decimal.of(minor, exponentOf(currency)), intlLocale(locale))} ${currency}`
}

/** Plain decimal without trailing zeros, like `minorToDecimal`, for any bigint. */
export function minorToPlainDecimal(minor: bigint, currency: string): string {
  return Decimal.of(minor, exponentOf(currency)).stripTrailingZeros().toString()
}
