import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ForbiddenError } from '../../src/domain/errors'
import { summarizeGroups, type SummaryRow } from '../../src/domain/group-summary'
import type { OpenVault, TransactionInput } from '../../src/domain/types'
import { formatMinorExact, minorToPlainDecimal } from '../../src/lib/money-exact'
import { MAX_AMOUNT_MINOR } from '../../src/lib/money'
import { permissionsForRole } from '../../src/rbac'
import { createVault } from '../../src/services/auth.service'
import { createTransaction, deleteTransaction, listCategories, loadDashboard, updateTransaction } from '../../src/services/finance.service'
import { createGroup, listGroups } from '../../src/services/group.service'
import { loadGroupSummaries } from '../../src/services/group-summary.service'

describe('summarizeGroups', () => {
  const groups = [
    { id: 1, name: 'Alpha' },
    { id: 2, name: 'Beta' },
  ]
  const row = (groupId: number, currency: string, type: 'INCOME' | 'EXPENSE', totalMinor: bigint, count: number, lastDate: string): SummaryRow => ({
    groupId,
    currency,
    type,
    totalMinor,
    count,
    lastDate,
  })

  it('keeps currencies apart and derives net per currency', () => {
    const report = summarizeGroups(
      groups,
      [
        row(1, 'USD', 'INCOME', 10_000n, 2, '2026-09-10'),
        row(1, 'USD', 'EXPENSE', 2_500n, 1, '2026-09-12'),
        row(1, 'EUR', 'EXPENSE', 700n, 1, '2026-09-20'),
        row(2, 'UZS', 'INCOME', 5_000_000n, 1, '2026-09-01'),
      ],
      'USD',
    )
    const alpha = report.groups[0]
    expect(alpha.currencies.map((line) => line.currency)).toEqual(['USD', 'EUR'])
    expect(alpha.currencies[0]).toMatchObject({ incomeMinor: 10_000n, expenseMinor: 2_500n, netMinor: 7_500n, count: 3, lastDate: '2026-09-12' })
    expect(alpha.currencies[1]).toMatchObject({ incomeMinor: 0n, expenseMinor: 700n, netMinor: -700n, count: 1 })
    expect(alpha).toMatchObject({ count: 4, lastDate: '2026-09-20' })
    expect(report.total.currencies.map((line) => line.currency)).toEqual(['USD', 'EUR', 'UZS'])
    expect(report.total.currencies.find((line) => line.currency === 'UZS')?.incomeMinor).toBe(5_000_000n)
    expect(report.total).toMatchObject({ count: 5, lastDate: '2026-09-20' })
  })

  it('reports empty groups and never counts rows for groups it was not given', () => {
    const report = summarizeGroups(groups, [row(3, 'USD', 'INCOME', 99n, 1, '2026-09-01')], 'USD')
    expect(report.groups.map((group) => group.count)).toEqual([0, 0])
    expect(report.groups[1]).toMatchObject({ currencies: [], lastDate: null })
    expect(report.total).toEqual({ currencies: [], count: 0, lastDate: null })
  })
})

describe('money-exact', () => {
  it('formats totals beyond 2^53 without rounding', () => {
    const minor = BigInt(MAX_AMOUNT_MINOR) * 10n + 7n
    expect(minor > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true)
    expect(minorToPlainDecimal(minor, 'USD')).toBe('99999999999999.97')
    expect(formatMinorExact(minor, 'USD', 'en')).toBe('99,999,999,999,999.97 USD')
    expect(formatMinorExact(-123_456n, 'USD', 'en')).toBe('-$1,234.56')
    expect(minorToPlainDecimal(120_000n, 'EUR')).toBe('1200')
  })
})

describe('loadGroupSummaries', () => {
  const range = { start: '2026-09-01', end: '2026-09-30' }
  let admin: OpenVault
  let alpha: number
  let beta: number
  let salary: number
  let food: number

  function add(input: Partial<TransactionInput> & Pick<TransactionInput, 'type' | 'amount'>): string {
    return createTransaction(admin, {
      currency: 'USD',
      categoryId: input.type === 'INCOME' ? salary : food,
      groupId: alpha,
      date: '2026-09-15',
      notes: '',
      receiptData: null,
      ...input,
    })
  }

  function as(role: 'Manager' | 'Viewer', groupId: number | null): OpenVault {
    return { ...admin, user: { ...admin.user, id: `${role}-${groupId}`, roleName: role, roleId: 0, groupId, permissions: permissionsForRole(role) } }
  }

  beforeEach(async () => {
    admin = (await createVault({ email: 'owner@example.com', password: 'correct-horse', displayName: 'Home', currency: 'USD' })).vault
    createGroup(admin, 'Alpha')
    createGroup(admin, 'Beta')
    const groups = listGroups(admin)
    alpha = groups.find((group) => group.name === 'Alpha')!.id
    beta = groups.find((group) => group.name === 'Beta')!.id
    const categories = listCategories(admin)
    salary = categories.find((category) => category.nameEn === 'Salary')!.id
    food = categories.find((category) => category.nameEn === 'Food')!.id
  })

  afterEach(() => admin.db.close())

  it('sums income, expenses and net per group and currency', () => {
    add({ type: 'INCOME', amount: '1000' })
    add({ type: 'EXPENSE', amount: '250.50', date: '2026-09-20' })
    add({ type: 'EXPENSE', amount: '40', currency: 'EUR', date: '2026-09-05' })
    add({ type: 'INCOME', amount: '300', groupId: beta, date: '2026-09-02' })
    add({ type: 'EXPENSE', amount: '500', groupId: beta })

    const report = loadGroupSummaries(admin, range)
    const byName = Object.fromEntries(report.groups.map((group) => [group.name, group]))
    expect(byName.Alpha.currencies).toEqual([
      { currency: 'USD', incomeMinor: 100_000n, expenseMinor: 25_050n, netMinor: 74_950n, count: 2, lastDate: '2026-09-20' },
      { currency: 'EUR', incomeMinor: 0n, expenseMinor: 4_000n, netMinor: -4_000n, count: 1, lastDate: '2026-09-05' },
    ])
    expect(byName.Alpha).toMatchObject({ count: 3, lastDate: '2026-09-20' })
    expect(byName.Beta.currencies).toEqual([
      { currency: 'USD', incomeMinor: 30_000n, expenseMinor: 50_000n, netMinor: -20_000n, count: 2, lastDate: '2026-09-15' },
    ])
    expect(report.total.currencies).toEqual([
      { currency: 'USD', incomeMinor: 130_000n, expenseMinor: 75_050n, netMinor: 54_950n, count: 4, lastDate: '2026-09-20' },
      { currency: 'EUR', incomeMinor: 0n, expenseMinor: 4_000n, netMinor: -4_000n, count: 1, lastDate: '2026-09-05' },
    ])

    const dashboard = loadDashboard(admin, range, 'en')
    expect(report.total.currencies[0]).toMatchObject({ incomeMinor: BigInt(dashboard.income), expenseMinor: BigInt(dashboard.expense) })
    expect(dashboard.otherCurrencies).toEqual([{ currency: 'EUR', income: 0, expense: 4_000 }])
  })

  it('includes both period bounds and nothing outside them', () => {
    add({ type: 'INCOME', amount: '1', date: '2026-08-31' })
    add({ type: 'INCOME', amount: '2', date: '2026-09-01' })
    add({ type: 'INCOME', amount: '4', date: '2026-09-30' })
    add({ type: 'INCOME', amount: '8', date: '2026-10-01' })
    const total = loadGroupSummaries(admin, range).total
    expect(total.currencies[0]).toMatchObject({ incomeMinor: 600n, count: 2, lastDate: '2026-09-30' })
    expect(loadGroupSummaries(admin, { start: '2026-09-02', end: '2026-09-29' }).total.count).toBe(0)
  })

  it('scopes managers and viewers to their own group, exactly like the dashboard', () => {
    add({ type: 'INCOME', amount: '1000' })
    add({ type: 'EXPENSE', amount: '10', currency: 'EUR' })
    add({ type: 'EXPENSE', amount: '500', groupId: beta })

    for (const role of ['Manager', 'Viewer'] as const) {
      const scoped = as(role, alpha)
      const report = loadGroupSummaries(scoped, range)
      expect(report.groups.map((group) => group.name)).toEqual(['Alpha'])
      expect(report.total.currencies).toEqual(report.groups[0].currencies)
      expect(report.total.currencies.map((line) => [line.currency, line.incomeMinor, line.expenseMinor])).toEqual([
        ['USD', 100_000n, 0n],
        ['EUR', 0n, 1_000n],
      ])
      const dashboard = loadDashboard(scoped, range, 'en')
      expect(report.total.currencies[0]).toMatchObject({ incomeMinor: BigInt(dashboard.income), expenseMinor: BigInt(dashboard.expense) })
    }

    const groupless = loadGroupSummaries(as('Manager', null), range)
    expect(groupless.groups).toEqual([])
    expect(groupless.total.count).toBe(0)
  })

  it('refuses callers without dashboard access', () => {
    const noDashboard = { ...admin, user: { ...admin.user, permissions: admin.user.permissions.filter((item) => item !== 'READ_DASHBOARD') } }
    expect(() => loadGroupSummaries(noDashboard, range)).toThrow(ForbiddenError)
  })

  it('follows edits and deletions, which remove transactions outright', () => {
    const kept = add({ type: 'EXPENSE', amount: '25' })
    const removed = add({ type: 'EXPENSE', amount: '75' })
    deleteTransaction(admin, removed)
    let alphaLine = loadGroupSummaries(admin, range).groups.find((group) => group.groupId === alpha)!
    expect(alphaLine.currencies[0]).toMatchObject({ expenseMinor: 2_500n, count: 1 })

    updateTransaction(admin, kept, {
      type: 'EXPENSE',
      amount: '25',
      currency: 'USD',
      categoryId: food,
      groupId: beta,
      date: '2026-09-15',
      notes: '',
      receiptData: null,
    })
    const report = loadGroupSummaries(admin, range)
    alphaLine = report.groups.find((group) => group.groupId === alpha)!
    expect(alphaLine.count).toBe(0)
    expect(report.groups.find((group) => group.groupId === beta)!.currencies[0]).toMatchObject({ expenseMinor: 2_500n })
  })

  it('stays exact when a total passes 2^53', () => {
    for (let index = 0; index < 10; index += 1) add({ type: 'INCOME', amount: '9999999999999.99' })
    const line = loadGroupSummaries(admin, range).total.currencies[0]
    expect(line.incomeMinor).toBe(BigInt(MAX_AMOUNT_MINOR) * 10n)
    expect(line.incomeMinor > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true)
  })
})
