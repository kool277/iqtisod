import type { KdfParams, WRAP_AAD_V1 } from '../crypto/crypto.service'
import type { SqlDatabase } from '../db/sqlite'

export type RoleName = 'Admin' | 'Manager' | 'Viewer'
export type EntryType = 'INCOME' | 'EXPENSE'
export type CurrencyCode = 'USD' | 'UZS' | 'EUR' | 'RUB'

export const CURRENCIES: readonly CurrencyCode[] = ['USD', 'UZS', 'EUR', 'RUB']

export function isCurrency(value: string): value is CurrencyCode {
  return (CURRENCIES as readonly string[]).includes(value)
}

export function isRoleName(value: string): value is RoleName {
  return value === 'Admin' || value === 'Manager' || value === 'Viewer'
}

export type SessionUser = {
  id: string
  email: string
  roleName: string
  roleId: number
  groupId: number | null
  permissions: string[]
  mustChangePassword: boolean
}

export type UserWrap = {
  userId: string
  email: string
  kdf: KdfParams
  salt: Uint8Array
  iv: Uint8Array
  wrappedDek: ArrayBuffer
  /** Present on wraps written from 1.4.2: the wrap's AAD binds its `userId`. */
  aad?: typeof WRAP_AAD_V1
}

export type GrantWrap = {
  id: string
  kind: 'INVITE' | 'RESET'
  email: string
  kdf: KdfParams
  salt: Uint8Array
  iv: Uint8Array
  wrappedDek: ArrayBuffer
  /** Present on grants issued from 1.4.2, in plain text and bound into the grant's AAD. */
  expiresAt?: string
}

export type OpenVault = {
  db: SqlDatabase
  dek: CryptoKey
  wraps: UserWrap[]
  grants: GrantWrap[]
  user: SessionUser
  currency: string
  vaultName: string
  createdAt: string | null
  lastBackupAt: string | null
  needsSave: boolean
}

export type Category = {
  id: number
  type: EntryType
  icon: string | null
  nameEn: string
  nameUzLatn: string
  nameUzCyrl: string
  nameRu: string
}

export type Group = {
  id: number
  name: string
  createdAt: string
}

export type VaultUser = {
  id: string
  email: string
  displayName: string | null
  roleName: string
  groupId: number | null
  groupName: string | null
  createdAt: string
  updatedAt: string | null
  status: 'ACTIVE' | 'SUSPENDED' | 'FORMER'
  /** Records this person entered that the caller may see. */
  records: number
  /** Always false for viewers without MANAGE_USERS: who has a sign-in check is not disclosed to them. */
  signInCheck: boolean
  /** The fields below are only filled for people managers; everyone else gets null, false, or 'UNKNOWN'. */
  lastSignInAt: string | null
  mustChange: boolean
  /** PASSWORD: holds a password copy; CODE: waits for an open reset code; NONE: cannot sign in at all. */
  access: 'PASSWORD' | 'CODE' | 'NONE' | 'UNKNOWN'
  /** The password copy predates the 1.4.2 binding or uses an older key stretch, so it is rewritten at the next password change. */
  legacyWrap: boolean
}

export type LedgerEntry = {
  id: string
  type: EntryType
  amountMinor: number
  currency: string
  categoryId: number
  userId: string
  userEmail: string
  groupId: number
  groupName: string
  date: string
  notes: string | null
  receiptData: string | null
  createdAt: string
  updatedAt: string
  nameEn: string
  nameUzLatn: string
  nameUzCyrl: string
  nameRu: string
}

export type TransactionInput = {
  type: EntryType
  amount: string
  currency: string
  categoryId: number
  groupId: number
  date: string
  notes: string
  receiptData: string | null
}

export type DateRange = {
  start: string
  end: string
}

export type AuditEntry = {
  id: string
  actorId: string | null
  actorEmail: string | null
  action: string
  entityType: string | null
  entityId: string | null
  details: string | null
  createdAt: string
}

export type DashboardData = {
  income: number
  expense: number
  net: number
  savingsRate: number
  months: string[]
  incomeByMonth: number[]
  expenseByMonth: number[]
  categories: { label: string; total: number }[]
  trend: { date: string; total: number }[]
  breakdown: { label: string; total: number }[]
  breakdownMode: 'group' | 'user'
  otherCurrencies: { currency: string; income: number; expense: number }[]
}
