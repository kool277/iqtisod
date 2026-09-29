import { MAX_AMOUNT_MINOR, roundHalfEven } from '../lib/money'
import { ValidationError } from './errors'
import {
  BILLING_CYCLES,
  SAFE_LIMITS,
  SUBSCRIPTION_STATUSES,
  normalizeText,
  type BillingCycle,
  type SecureItem,
  type SubscriptionFields,
  type SubscriptionItem,
} from './safes'
import { CURRENCIES, isCurrency, type CurrencyCode } from './types'

const DAY_MS = 86_400_000
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = ISO_DATE.exec(value)
  if (!match) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function toUtc(iso: string): number {
  const [year, month, day] = iso.split('-').map(Number)
  return Date.UTC(year, month - 1, day)
}

function fromUtc(time: number): string {
  return new Date(time).toISOString().slice(0, 10)
}

export function addDays(iso: string, days: number): string {
  return fromUtc(toUtc(iso) + days * DAY_MS)
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / DAY_MS)
}

export function addMonthsClamped(iso: string, months: number): string {
  const [year, month, day] = iso.split('-').map(Number)
  const index = year * 12 + (month - 1) + months
  const targetYear = Math.floor(index / 12)
  const targetMonth = index - targetYear * 12
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate()
  return fromUtc(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay)))
}

const CYCLE_MONTHS: Partial<Record<BillingCycle, number>> = { MONTHLY: 1, QUARTERLY: 3, YEARLY: 12 }

function cycleDays(cycle: BillingCycle, customDays: number | null): number {
  if (cycle === 'WEEKLY') return 7
  return Math.max(1, customDays ?? 1)
}

export function nextRenewal(anchorDate: string, cycle: BillingCycle, customDays: number | null, today: string): string {
  if (anchorDate >= today) return anchorDate
  const months = CYCLE_MONTHS[cycle]
  if (months === undefined) {
    const step = cycleDays(cycle, customDays)
    return addDays(anchorDate, Math.ceil(daysBetween(anchorDate, today) / step) * step)
  }
  const [ay, am] = anchorDate.split('-').map(Number)
  const [ty, tm] = today.split('-').map(Number)
  let n = Math.max(0, Math.floor(((ty - ay) * 12 + (tm - am)) / months) - 1)
  while (addMonthsClamped(anchorDate, n * months) < today) n += 1
  return addMonthsClamped(anchorDate, n * months)
}

const DAYS_PER_YEAR_NUM = 3_652_425n
const DAYS_PER_YEAR_DEN = 10_000n

export function monthlyMinor(amountMinor: number, cycle: BillingCycle, customDays: number | null): number {
  const amount = BigInt(amountMinor)
  switch (cycle) {
    case 'WEEKLY':
      return Number(roundHalfEven(amount * 52n, 12n))
    case 'MONTHLY':
      return amountMinor
    case 'QUARTERLY':
      return Number(roundHalfEven(amount, 3n))
    case 'YEARLY':
      return Number(roundHalfEven(amount, 12n))
    case 'CUSTOM':
      return Number(roundHalfEven(amount * DAYS_PER_YEAR_NUM, 12n * DAYS_PER_YEAR_DEN * BigInt(cycleDays(cycle, customDays))))
  }
}

export function yearlyMinor(amountMinor: number, cycle: BillingCycle, customDays: number | null): number {
  const amount = BigInt(amountMinor)
  switch (cycle) {
    case 'WEEKLY':
      return amountMinor * 52
    case 'MONTHLY':
      return amountMinor * 12
    case 'QUARTERLY':
      return amountMinor * 4
    case 'YEARLY':
      return amountMinor
    case 'CUSTOM':
      return Number(roundHalfEven(amount * DAYS_PER_YEAR_NUM, DAYS_PER_YEAR_DEN * BigInt(cycleDays(cycle, customDays))))
  }
}

export type SubscriptionTotal = { currency: CurrencyCode; monthlyMinor: number; yearlyMinor: number; active: number }
export type UpcomingPayment = {
  itemId: string
  safeId: string
  title: string
  date: string
  daysLeft: number
  amountMinor: number
  currency: CurrencyCode
  soon: boolean
}

export function isSubscription(item: SecureItem): item is SubscriptionItem {
  return item.kind === 'SUBSCRIPTION'
}

export function subscriptionSummary(
  items: SecureItem[],
  today: string,
  horizonDays = 30,
): { totals: SubscriptionTotal[]; upcoming: UpcomingPayment[] } {
  const totals = new Map<CurrencyCode, SubscriptionTotal>()
  const upcoming: UpcomingPayment[] = []
  const horizon = addDays(today, horizonDays)
  for (const item of items) {
    if (!isSubscription(item) || item.deletedAt || item.status !== 'ACTIVE') continue
    const total = totals.get(item.currency) ?? { currency: item.currency, monthlyMinor: 0, yearlyMinor: 0, active: 0 }
    total.monthlyMinor += monthlyMinor(item.amountMinor, item.cycle, item.customDays)
    total.yearlyMinor += yearlyMinor(item.amountMinor, item.cycle, item.customDays)
    total.active += 1
    totals.set(item.currency, total)
    const date = nextRenewal(item.anchorDate, item.cycle, item.customDays, today)
    if (date > horizon) continue
    const daysLeft = daysBetween(today, date)
    const trialSoon = item.trialEndsOn !== null && item.trialEndsOn >= today && daysBetween(today, item.trialEndsOn) <= item.remindDaysBefore
    upcoming.push({
      itemId: item.id,
      safeId: item.safeId,
      title: item.title,
      date,
      daysLeft,
      amountMinor: item.amountMinor,
      currency: item.currency,
      soon: daysLeft <= item.remindDaysBefore || trialSoon,
    })
  }
  upcoming.sort((left, right) => left.date.localeCompare(right.date) || left.title.localeCompare(right.title))
  const ordered = CURRENCIES.flatMap((currency) => {
    const total = totals.get(currency)
    return total ? [total] : []
  })
  return { totals: ordered, upcoming }
}

export function safeUrl(value: string): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

export type SubscriptionInput = Omit<SubscriptionFields, 'kind'>

export function validateSubscription(input: SubscriptionInput): SubscriptionInput {
  if (!isCurrency(String(input.currency))) throw new ValidationError('CURRENCY')
  const amountMinor = Number(input.amountMinor)
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new ValidationError('AMOUNT')
  if (amountMinor > MAX_AMOUNT_MINOR) throw new ValidationError('AMOUNT_LIMIT')
  if (!(BILLING_CYCLES as readonly string[]).includes(input.cycle)) throw new ValidationError('REQUIRED')
  let customDays: number | null = null
  if (input.cycle === 'CUSTOM') {
    customDays = Number(input.customDays)
    if (!Number.isInteger(customDays) || customDays < 1 || customDays > SAFE_LIMITS.customDays) throw new ValidationError('CUSTOM_DAYS')
  }
  if (!isIsoDate(input.anchorDate)) throw new ValidationError('DATE')
  if (input.trialEndsOn != null && input.trialEndsOn !== '' && !isIsoDate(input.trialEndsOn)) throw new ValidationError('DATE')
  if (!(SUBSCRIPTION_STATUSES as readonly string[]).includes(input.status)) throw new ValidationError('REQUIRED')
  const remindDaysBefore = Number(input.remindDaysBefore)
  if (!Number.isInteger(remindDaysBefore) || remindDaysBefore < 0 || remindDaysBefore > SAFE_LIMITS.remindDays) {
    throw new ValidationError('REMIND_DAYS')
  }
  const url = normalizeText(input.url, SAFE_LIMITS.url)
  if (url && !safeUrl(url)) throw new ValidationError('URL')
  const cardItemId = typeof input.cardItemId === 'string' && input.cardItemId ? input.cardItemId : null
  return {
    url,
    amountMinor,
    currency: input.currency,
    cycle: input.cycle,
    customDays,
    anchorDate: input.anchorDate,
    status: input.status,
    trialEndsOn: input.trialEndsOn ? input.trialEndsOn : null,
    remindDaysBefore,
    cardItemId,
    account: normalizeText(input.account, SAFE_LIMITS.account),
    notes: normalizeText(input.notes, SAFE_LIMITS.notes, { multiline: true }),
  }
}
