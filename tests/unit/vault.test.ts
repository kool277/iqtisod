import { afterEach, describe, expect, it } from 'vitest'
import { PBKDF2_ITERATIONS } from '../../src/crypto/crypto.service'
import { AuthError, ForbiddenError } from '../../src/domain/errors'
import type { OpenVault } from '../../src/domain/types'
import { permissionsForRole } from '../../src/rbac'
import { backupToVault, parseBackup, vaultToBackup } from '../../src/services/backup.service'
import { createVault, sealVault, unlockVault } from '../../src/services/auth.service'
import { createTransaction, listCategories, listTransactions, loadDashboard } from '../../src/services/finance.service'
import { listGroups } from '../../src/services/group.service'
import { createUser } from '../../src/services/user.service'

const open: OpenVault[] = []

afterEach(() => {
  for (const vault of open) vault.db.close()
  open.length = 0
})

describe('vault', () => {
  it('seals the ledger, scopes a viewer, and restores a backup', async () => {
    const created = await createVault({
      email: 'Admin@Example.com',
      password: 'correct-horse',
      displayName: 'Home',
      currency: 'USD',
    })
    open.push(created.vault)
    expect(created.record.kdf.iterations).toBe(PBKDF2_ITERATIONS)
    expect(created.vault.user.email).toBe('admin@example.com')
    expect(created.vault.user.permissions).toEqual(permissionsForRole('Admin'))

    const groups = listGroups(created.vault)
    const categories = listCategories(created.vault)
    const income = categories.find((category) => category.nameEn === 'Salary')
    const expense = categories.find((category) => category.nameEn === 'Food')
    expect(income).toBeTruthy()
    expect(expense).toBeTruthy()
    const range = { start: '2026-09-01', end: '2026-09-30' }
    const base = {
      currency: 'USD',
      groupId: groups[0].id,
      date: '2026-09-15',
      notes: '',
      receiptData: null,
    }
    createTransaction(created.vault, { ...base, type: 'INCOME', amount: 1000, categoryId: income!.id })
    createTransaction(created.vault, { ...base, type: 'EXPENSE', amount: 250, categoryId: expense!.id })
    const dashboard = loadDashboard(created.vault, range, 'en')
    expect(dashboard.income).toBe(1000)
    expect(dashboard.expense).toBe(250)
    expect(dashboard.net).toBe(750)
    expect(dashboard.savingsRate).toBe(75)
    expect(dashboard.categories[0]?.label).toBe('Food')

    await createUser(created.vault, {
      email: 'viewer@example.com',
      password: 'viewer-password',
      roleName: 'Viewer',
      groupId: groups[0].id,
    })
    const sealed = await sealVault(created.vault)
    await expect(unlockVault(sealed, 'admin@example.com', 'nope-nope')).rejects.toBeInstanceOf(AuthError)

    const restored = await unlockVault(backupToVault(vaultToBackup(sealed)), 'admin@example.com', 'correct-horse')
    open.push(restored)
    expect(loadDashboard(restored, range, 'uz-Latn').net).toBe(750)
    expect(loadDashboard(restored, range, 'uz-Latn').categories[0]?.label).toBe('Oziq-ovqat')

    const viewer = await unlockVault(sealed, 'viewer@example.com', 'viewer-password')
    open.push(viewer)
    expect(viewer.user.permissions).toEqual(permissionsForRole('Viewer'))
    expect(listTransactions(viewer, range)).toHaveLength(2)
    expect(() =>
      createTransaction(viewer, { ...base, type: 'EXPENSE', amount: 10, categoryId: expense!.id }),
    ).toThrow(ForbiddenError)
    expect(() => parseBackup('{')).toThrow()
  })
})
