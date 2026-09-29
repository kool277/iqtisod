import { ValidationError } from './errors'
import { CARD_BRANDS, SAFE_LIMITS, normalizeText, type CardBrand, type CardFields } from './safes'

type BrandRule = { brand: Exclude<CardBrand, 'OTHER'>; ranges: [string, string][]; lengths: number[] }

const BRAND_RULES: BrandRule[] = [
  { brand: 'VISA', ranges: [['4', '4']], lengths: [13, 16, 19] },
  { brand: 'MASTERCARD', ranges: [['51', '55'], ['2221', '2720']], lengths: [16] },
  { brand: 'AMEX', ranges: [['34', '34'], ['37', '37']], lengths: [15] },
  { brand: 'UNIONPAY', ranges: [['62', '62']], lengths: [16, 17, 18, 19] },
  { brand: 'UZCARD', ranges: [['8600', '8600'], ['5614', '5614']], lengths: [16] },
  { brand: 'HUMO', ranges: [['9860', '9860']], lengths: [16] },
  { brand: 'MIR', ranges: [['2200', '2204']], lengths: [16, 17, 18, 19] },
]

const STRICT_LUHN: ReadonlySet<CardBrand> = new Set(['VISA', 'MASTERCARD', 'AMEX', 'MIR'])

export const PAN_LENGTH = { min: 12, max: 19 } as const
export const EXPIRY_SOON_DAYS = 60

export function digitsOnly(text: string): string {
  return text.replace(/\D/g, '')
}

export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false
  let sum = 0
  let double = false
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = digits.charCodeAt(index) - 48
    if (double) {
      value *= 2
      if (value > 9) value -= 9
    }
    sum += value
    double = !double
  }
  return sum % 10 === 0
}

export function detectBrand(digits: string): CardBrand {
  let best: { brand: CardBrand; length: number } = { brand: 'OTHER', length: 0 }
  for (const rule of BRAND_RULES) {
    for (const [from, to] of rule.ranges) {
      const size = from.length
      if (digits.length < size || size <= best.length) continue
      const head = digits.slice(0, size)
      if (head >= from && head <= to) best = { brand: rule.brand, length: size }
    }
  }
  return best.brand
}

export function isCardBrand(value: unknown): value is CardBrand {
  return typeof value === 'string' && (CARD_BRANDS as readonly string[]).includes(value)
}

export type NumberCheck = { valid: boolean; luhnWarning: boolean }

export function checkCardNumber(digits: string, brand: CardBrand): NumberCheck {
  if (!/^\d+$/.test(digits) || digits.length < PAN_LENGTH.min || digits.length > PAN_LENGTH.max) {
    return { valid: false, luhnWarning: false }
  }
  const rule = BRAND_RULES.find((item) => item.brand === brand)
  if (rule && !rule.lengths.includes(digits.length)) return { valid: false, luhnWarning: false }
  const luhn = luhnValid(digits)
  if (!luhn && STRICT_LUHN.has(brand)) return { valid: false, luhnWarning: false }
  return { valid: true, luhnWarning: !luhn }
}

export function formatPan(digits: string, brand: CardBrand): string {
  if (brand === 'AMEX') return [digits.slice(0, 4), digits.slice(4, 10), digits.slice(10)].filter(Boolean).join(' ')
  return digits.match(/.{1,4}/g)?.join(' ') ?? ''
}

export function lastFour(digits: string): string {
  return digits.slice(-4)
}

export function maskPan(digits: string): string {
  return `•••• ${lastFour(digits)}`
}

export function expiryLabel(expMonth: number, expYear: number): string {
  return `${String(expMonth).padStart(2, '0')}/${String(expYear % 100).padStart(2, '0')}`
}

function lastDayOfMonthUtc(year: number, month: number): number {
  return Date.UTC(year, month, 0)
}

function isoToUtc(iso: string): number {
  const [year, month, day] = iso.split('-').map(Number)
  return Date.UTC(year, month - 1, day)
}

export type ExpiryStatus = 'OK' | 'SOON' | 'EXPIRED'

export function expiryStatus(expMonth: number, expYear: number, today: string): ExpiryStatus {
  const end = lastDayOfMonthUtc(expYear, expMonth)
  const now = isoToUtc(today)
  if (now > end) return 'EXPIRED'
  return (end - now) / 86_400_000 <= EXPIRY_SOON_DAYS ? 'SOON' : 'OK'
}

export type CardInput = Omit<CardFields, 'kind' | 'cvv'> & { cvv: string | null }

export function validateCard(input: CardInput): Omit<CardFields, 'kind'> {
  const number = digitsOnly(String(input.number ?? ''))
  if (!isCardBrand(input.brand)) throw new ValidationError('CARD_NUMBER')
  if (!checkCardNumber(number, input.brand).valid) throw new ValidationError('CARD_NUMBER')
  const expMonth = Number(input.expMonth)
  const expYear = Number(input.expYear)
  if (!Number.isInteger(expMonth) || expMonth < 1 || expMonth > 12 || !Number.isInteger(expYear) || expYear < 2000 || expYear > 2099) {
    throw new ValidationError('CARD_EXPIRY')
  }
  const cvvText = input.cvv == null ? '' : String(input.cvv).trim()
  if (cvvText && !/^\d{3,4}$/.test(cvvText)) throw new ValidationError('CVV')
  return {
    cardholder: normalizeText(input.cardholder, SAFE_LIMITS.cardholder),
    number,
    brand: input.brand,
    expMonth,
    expYear,
    cvv: cvvText || null,
    bank: normalizeText(input.bank, SAFE_LIMITS.bank),
    notes: normalizeText(input.notes, SAFE_LIMITS.notes, { multiline: true }),
  }
}
