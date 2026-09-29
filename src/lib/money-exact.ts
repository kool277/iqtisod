import type { Locale } from '../i18n'
import { Decimal, formatDecimal } from './decimal'
import { formatMoney, intlLocale, minorUnitOf } from './money'

const SAFE = BigInt(Number.MAX_SAFE_INTEGER)

/** `formatMoney` for bigint totals; beyond 2^53 it falls back to exact digits plus the currency code. */
export function formatMinorExact(minor: bigint, currency: string, locale: Locale): string {
  if (minor <= SAFE && minor >= -SAFE) return formatMoney(Number(minor), currency, locale)
  return `${formatDecimal(Decimal.of(minor, minorUnitOf(currency)), intlLocale(locale))} ${currency}`
}

/** Plain decimal without trailing zeros, like `minorToDecimal`, for any bigint. */
export function minorToPlainDecimal(minor: bigint, currency: string): string {
  return Decimal.of(minor, minorUnitOf(currency)).stripTrailingZeros().toString()
}
