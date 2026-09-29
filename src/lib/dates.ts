import type { DateRange } from '../domain/types'

export type PeriodPreset = 'day' | 'week' | 'month' | 'lastMonth' | 'ytd' | 'custom'

export function toIsoDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
}

function startOfWeek(date: Date): Date {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const weekday = copy.getDay()
  const mondayOffset = weekday === 0 ? 6 : weekday - 1
  copy.setDate(copy.getDate() - mondayOffset)
  return copy
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  copy.setDate(copy.getDate() + days)
  return copy
}

export function rangeForPreset(preset: PeriodPreset, now = new Date(), custom?: DateRange): DateRange {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (preset === 'custom') {
    if (!custom || !isIsoDate(custom.start) || !isIsoDate(custom.end)) {
      return rangeForPreset('month', today)
    }
    return custom.start <= custom.end ? custom : { start: custom.end, end: custom.start }
  }
  if (preset === 'day') {
    const iso = toIsoDate(today)
    return { start: iso, end: iso }
  }
  if (preset === 'week') {
    const start = startOfWeek(today)
    return { start: toIsoDate(start), end: toIsoDate(addDays(start, 6)) }
  }
  if (preset === 'month') {
    const start = new Date(today.getFullYear(), today.getMonth(), 1)
    const end = new Date(today.getFullYear(), today.getMonth() + 1, 0)
    return { start: toIsoDate(start), end: toIsoDate(end) }
  }
  if (preset === 'lastMonth') {
    const start = new Date(today.getFullYear(), today.getMonth() - 1, 1)
    const end = new Date(today.getFullYear(), today.getMonth(), 0)
    return { start: toIsoDate(start), end: toIsoDate(end) }
  }
  return { start: `${today.getFullYear()}-01-01`, end: toIsoDate(today) }
}

export function eachMonth(start: string, end: string): string[] {
  const [startYear, startMonth] = start.split('-').map(Number)
  const [endYear, endMonth] = end.split('-').map(Number)
  const months: string[] = []
  let year = startYear
  let month = startMonth
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push(`${year}-${String(month).padStart(2, '0')}`)
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return months
}
