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
}

export type UserWrap = {
  userId: string
  email: string
  salt: Uint8Array
  iv: Uint8Array
  wrappedDek: ArrayBuffer
}

export type OpenVault = {
  db: SqlDatabase
  dek: CryptoKey
  wraps: UserWrap[]
  user: SessionUser
  currency: string
  vaultName: string
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
  roleName: string
  groupId: number | null
  groupName: string | null
  createdAt: string
}

export type LedgerEntry = {
  id: string
  type: EntryType
  amount: number
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
  amount: number
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
}
