import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { VaultRecord } from '../../src/db/envelope'
import { ForbiddenError, ValidationError } from '../../src/domain/errors'
import type { OpenVault } from '../../src/domain/types'
import { parseGroupChoice } from '../../src/lib/dashboard-group'
import { createVault, sealVault, unlockVault } from '../../src/services/auth.service'
import { createTransaction, listCategories, loadDashboard } from '../../src/services/finance.service'
import { createGroup, listGroups } from '../../src/services/group.service'
import { createUser } from '../../src/services/user.service'
import { settlePassword } from '../support/access'

const open: OpenVault[] = []
const range = { start: '2026-09-01', end: '2026-09-30' }
const ADMIN = { email: 'admin@example.com', password: 'correct-horse-battery' }
const MANAGER = { email: 'manager@example.com', password: 'manager-password-1' }
let record: VaultRecord
let home: number
let shop: number

afterEach(() => {
  for (const vault of open.splice(0)) vault.db.close()
})

async function as(who: { email: string; password: string }): Promise<OpenVault> {
  const vault = await unlockVault(record, who.email, who.password)
  open.push(vault)
  return settlePassword(vault)
}

beforeAll(async () => {
  const { vault } = await createVault({ ...ADMIN, displayName: 'Home', currency: 'USD' })
  createGroup(vault, 'Shop')
  const groups = listGroups(vault)
  home = groups.find((group) => group.name !== 'Shop')!.id
  shop = groups.find((group) => group.name === 'Shop')!.id
  const categories = listCategories(vault)
  const salary = categories.find((category) => category.nameEn === 'Salary')!.id
  const food = categories.find((category) => category.nameEn === 'Food')!.id
  const base = { currency: 'USD', date: '2026-09-15', notes: '', receiptData: null }
  createTransaction(vault, { ...base, type: 'INCOME', amount: '1000', categoryId: salary, groupId: home })
  createTransaction(vault, { ...base, type: 'EXPENSE', amount: '200', categoryId: food, groupId: home })
  createTransaction(vault, { ...base, type: 'INCOME', amount: '500', categoryId: salary, groupId: shop })
  createTransaction(vault, { ...base, type: 'EXPENSE', amount: '50.25', categoryId: food, groupId: shop })
  createTransaction(vault, { ...base, currency: 'EUR', type: 'EXPENSE', amount: '7', categoryId: food, groupId: shop })
  await createUser(vault, { ...MANAGER, roleName: 'Manager', groupId: home })
  record = await sealVault(vault)
  vault.db.close()
})

describe('dashboard group filter', () => {
  it('sums every group for an admin until one is chosen', async () => {
    const admin = await as(ADMIN)
    const all = loadDashboard(admin, range, 'en')
    expect(all.income).toBe(150_000)
    expect(all.expense).toBe(25_025)
    expect(all.breakdownMode).toBe('group')
    const shopOnly = loadDashboard(admin, range, 'en', shop)
    expect(shopOnly.income).toBe(50_000)
    expect(shopOnly.expense).toBe(5_025)
    expect(shopOnly.net).toBe(44_975)
    expect(shopOnly.otherCurrencies).toEqual([{ currency: 'EUR', income: 0, expense: 700 }])
    expect(shopOnly.breakdownMode).toBe('user')
    expect(shopOnly.breakdown).toEqual([{ label: ADMIN.email, total: 5_025 }])
    const homeOnly = loadDashboard(admin, range, 'en', home)
    expect(homeOnly.income).toBe(100_000)
    expect(homeOnly.otherCurrencies).toEqual([])
  })

  it('keeps a manager inside their own group and refuses any other', async () => {
    const manager = await as(MANAGER)
    expect(listGroups(manager).map((group) => group.id)).toEqual([home])
    expect(loadDashboard(manager, range, 'en').income).toBe(100_000)
    expect(loadDashboard(manager, range, 'en', home).income).toBe(100_000)
    expect(() => loadDashboard(manager, range, 'en', shop)).toThrow(ForbiddenError)
    expect(() => loadDashboard(manager, range, 'en', 0)).toThrow(ValidationError)
    expect(() => loadDashboard(manager, range, 'en', 1.5)).toThrow(ValidationError)
  })

  it('only restores a stored choice the current reader may see', () => {
    const permitted = [{ id: 3 }, { id: 9 }]
    expect(parseGroupChoice('9', permitted)).toBe(9)
    expect(parseGroupChoice('4', permitted)).toBeNull()
    expect(parseGroupChoice(null, permitted)).toBeNull()
    for (const raw of ['', '0', '-3', '3.0', ' 3', '03', '1e1', '{"id":3}', '99999999999']) {
      expect(parseGroupChoice(raw, permitted)).toBeNull()
    }
    expect(parseGroupChoice('3', [])).toBeNull()
  })
})
