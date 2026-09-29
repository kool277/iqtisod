import { ValidationError } from './errors'
import type { CurrencyCode } from './types'

export const SAFE_COLORS = ['pine', 'brass', 'clay', 'slate'] as const
export type SafeColor = (typeof SAFE_COLORS)[number]

export const SAFE_ICONS = ['vault', 'credit-card', 'wallet', 'briefcase', 'home', 'plane', 'heart', 'shield'] as const
export type SafeIcon = (typeof SAFE_ICONS)[number]

export const AUTO_LOCK_MINUTES = [1, 5, 15, 30] as const
export const CLIPBOARD_SECONDS = [10, 30, 60] as const
export const REVEAL_SECONDS = [15, 30, 60] as const
export type AutoLockMinutes = (typeof AUTO_LOCK_MINUTES)[number]
export type ClipboardSeconds = (typeof CLIPBOARD_SECONDS)[number]
export type RevealSeconds = (typeof REVEAL_SECONDS)[number]

export type SafeMeta = {
  v: 1
  name: string
  description: string
  icon: SafeIcon
  color: SafeColor
  archived: boolean
  requirePassword: boolean
  createdAt: string
  updatedAt: string
}

export type SafePrefs = {
  autoLockMinutes: AutoLockMinutes
  clipboardSeconds: ClipboardSeconds
  revealSeconds: RevealSeconds
}

export type UserSafeMeta = SafePrefs & {
  v: 1
  order: string[]
  defaultSafeId: string
}

export const DEFAULT_PREFS: SafePrefs = { autoLockMinutes: 5, clipboardSeconds: 30, revealSeconds: 15 }

export const CARD_BRANDS = ['VISA', 'MASTERCARD', 'AMEX', 'UNIONPAY', 'UZCARD', 'HUMO', 'MIR', 'OTHER'] as const
export type CardBrand = (typeof CARD_BRANDS)[number]

export const BILLING_CYCLES = ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY', 'CUSTOM'] as const
export type BillingCycle = (typeof BILLING_CYCLES)[number]

export const SUBSCRIPTION_STATUSES = ['ACTIVE', 'PAUSED', 'CANCELLED'] as const
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number]

export const ITEM_KINDS = ['CARD', 'SUBSCRIPTION', 'NOTE'] as const
export type ItemKind = (typeof ITEM_KINDS)[number]

export type CardFields = {
  kind: 'CARD'
  cardholder: string
  number: string
  brand: CardBrand
  expMonth: number
  expYear: number
  cvv: string | null
  bank: string
  notes: string
}

export type SubscriptionFields = {
  kind: 'SUBSCRIPTION'
  url: string
  amountMinor: number
  currency: CurrencyCode
  cycle: BillingCycle
  customDays: number | null
  anchorDate: string
  status: SubscriptionStatus
  trialEndsOn: string | null
  remindDaysBefore: number
  cardItemId: string | null
  account: string
  notes: string
}

export type NoteFields = { kind: 'NOTE'; body: string }

export type ItemFields = CardFields | SubscriptionFields | NoteFields

type Common = { v: 1; title: string; favorite: boolean; createdAt: string; updatedAt: string }

export type CardPayload = Common & CardFields
export type SubscriptionPayload = Common & SubscriptionFields
export type NotePayload = Common & NoteFields
export type SecureItemPayload = CardPayload | SubscriptionPayload | NotePayload

export type SecureItemInput = ItemFields & { title: string; favorite?: boolean }

type Stored = { id: string; safeId: string; rev: number; deletedAt: string | null }
export type SecureItem = SecureItemPayload & Stored
export type CardItem = CardPayload & Stored
export type SubscriptionItem = SubscriptionPayload & Stored
export type NoteItem = NotePayload & Stored

export const SAFE_EVENT_TYPES = [
  'SAFES_INITIALIZED',
  'SAFES_UNLOCKED',
  'SAFE_CREATED',
  'SAFE_UPDATED',
  'SAFE_TRASHED',
  'SAFE_RESTORED',
  'SAFE_PURGED',
  'SAFE_KEY_ROTATED',
  'ITEM_CREATED',
  'ITEM_UPDATED',
  'ITEM_MOVED',
  'ITEM_COPIED',
  'ITEM_TRASHED',
  'ITEM_RESTORED',
  'ITEM_PURGED',
  'RECOVERY_CREATED',
  'PASSWORD_REWRAPPED',
] as const
export type SafeEventType = (typeof SAFE_EVENT_TYPES)[number]

export type SafeEvent = { v: 1; type: SafeEventType; at: string; safeId: string | null; itemId: string | null; count?: number }

export const SAFE_LIMITS = {
  safesPerUser: 50,
  itemsPerSafe: 1000,
  itemsPerUser: 5000,
  safeName: 60,
  description: 500,
  title: 100,
  cardholder: 80,
  bank: 80,
  url: 2048,
  account: 2000,
  notes: 2000,
  noteBody: 10000,
  customDays: 3650,
  remindDays: 30,
  events: 500,
} as const

export const TRASH_DAYS = 30
export const RECENT_AUTH_MS = 120_000

export type SafeInput = Pick<SafeMeta, 'name' | 'description' | 'icon' | 'color' | 'requirePassword'>

export function normalizeText(value: unknown, max: number, options: { required?: boolean; multiline?: boolean } = {}): string {
  if (typeof value !== 'string') {
    if (options.required) throw new ValidationError('REQUIRED')
    return ''
  }
  const text = value.normalize('NFC').trim()
  const cleaned = options.multiline ? text : text.replace(/\s+/g, ' ')
  if (options.required && cleaned.length === 0) throw new ValidationError('REQUIRED')
  if (cleaned.length > max) throw new ValidationError('TOO_LONG')
  return cleaned
}

export function validateSafeInput(input: SafeInput): SafeInput {
  const icon = (SAFE_ICONS as readonly string[]).includes(input.icon) ? input.icon : 'vault'
  const color = (SAFE_COLORS as readonly string[]).includes(input.color) ? input.color : 'pine'
  return {
    name: normalizeText(input.name, SAFE_LIMITS.safeName, { required: true }),
    description: normalizeText(input.description, SAFE_LIMITS.description, { multiline: true }),
    icon,
    color,
    requirePassword: input.requirePassword === true,
  }
}

export function sameName(left: string, right: string): boolean {
  return left.normalize('NFC').trim() === right.normalize('NFC').trim()
}
