import type { Locale } from '../i18n'

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

export function formatMoney(amount: number, currency: string, locale: Locale): string {
  const tag = intlLocale(locale)
  try {
    return new Intl.NumberFormat(tag, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(amount)
  } catch {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 2,
    }).format(amount)
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

export function roundMoney(amount: number): number {
  return Math.round(amount * 100) / 100
}
