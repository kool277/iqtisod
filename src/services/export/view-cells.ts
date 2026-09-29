import { translate, type Locale } from '../../i18n'

export type ViewKind = 'text' | 'number' | 'money' | 'date' | 'when' | 'boolean'
export type ViewColumn = { id: string; header: string; kind: ViewKind }
export type ViewMoney = { money: number; currency: string }
export type ViewCell = string | number | boolean | ViewMoney | null

export function isViewMoney(value: ViewCell | undefined): value is ViewMoney {
  return typeof value === 'object' && value !== null && Number.isSafeInteger(value.money) && typeof value.currency === 'string'
}

export function currencyHeader(column: ViewColumn, locale: Locale): string {
  return `${column.header} · ${translate(locale, 'common.currency')}`
}
