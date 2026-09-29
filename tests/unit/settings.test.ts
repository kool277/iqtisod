import { afterEach, describe, expect, it } from 'vitest'
import { ForbiddenError, ValidationError } from '../../src/domain/errors'
import type { OpenVault } from '../../src/domain/types'
import { Permission, canUser, permissionsForRole } from '../../src/rbac'
import { createVault, sealVault, unlockVault } from '../../src/services/auth.service'
import { createTransaction, listCategories } from '../../src/services/finance.service'
import { listGroups } from '../../src/services/group.service'
import {
  createCategory,
  deleteCategory,
  updateCategory,
  updateVaultSettings,
} from '../../src/services/settings.service'
import { createUser } from '../../src/services/user.service'

const open: OpenVault[] = []

afterEach(() => {
  for (const vault of open) vault.db.close()
  open.length = 0
})

async function freshVault() {
  const created = await createVault({
    email: 'admin@example.com',
    password: 'correct-horse',
    displayName: 'Home',
    currency: 'USD',
  })
  open.push(created.vault)
  return created
}

function codeOf(action: () => void): string | undefined {
  try {
    action()
  } catch (error) {
    if (error instanceof ValidationError) return error.code
    throw error
  }
  return undefined
}

describe('settings', () => {
  it('renames the vault and changes the currency across a seal and unlock', async () => {
    const { vault } = await freshVault()
    updateVaultSettings(vault, { vaultName: '  Family  ', currency: 'UZS' })
    expect(vault.vaultName).toBe('Family')
    expect(vault.currency).toBe('UZS')
    expect(codeOf(() => updateVaultSettings(vault, { vaultName: ' ', currency: 'UZS' }))).toBe('REQUIRED')
    expect(codeOf(() => updateVaultSettings(vault, { vaultName: 'X', currency: 'ZZZ' }))).toBe('CURRENCY')

    const restored = await unlockVault(await sealVault(vault), 'admin@example.com', 'correct-horse')
    open.push(restored)
    expect(restored.vaultName).toBe('Family')
    expect(restored.currency).toBe('UZS')
  })

  it('adds, renames, and guards deletion of categories', async () => {
    const { vault } = await freshVault()
    createCategory(vault, { type: 'EXPENSE', nameEn: 'Pets', nameUzLatn: '', nameUzCyrl: '', nameRu: 'Питомцы' })
    const pets = listCategories(vault).find((category) => category.nameEn === 'Pets')
    expect(pets).toMatchObject({ type: 'EXPENSE', nameUzLatn: 'Pets', nameRu: 'Питомцы' })

    updateCategory(vault, pets!.id, { nameEn: 'Pet care', nameUzLatn: 'Uy hayvonlari', nameUzCyrl: '', nameRu: '' })
    expect(listCategories(vault).find((category) => category.id === pets!.id)?.nameUzLatn).toBe('Uy hayvonlari')

    createTransaction(vault, {
      type: 'EXPENSE',
      amount: '40',
      currency: 'USD',
      categoryId: pets!.id,
      groupId: listGroups(vault)[0].id,
      date: '2026-09-15',
      notes: '',
      receiptData: null,
    })
    expect(codeOf(() => deleteCategory(vault, pets!.id))).toBe('CATEGORY_IN_USE')

    const income = listCategories(vault).filter((category) => category.type === 'INCOME')
    for (const category of income.slice(1)) deleteCategory(vault, category.id)
    expect(codeOf(() => deleteCategory(vault, income[0].id))).toBe('LAST_CATEGORY')
  })

  it('refuses non-admins and restores permissions missing from older vaults', async () => {
    const { vault } = await freshVault()
    await createUser(vault, {
      email: 'manager@example.com',
      password: 'manager-password',
      roleName: 'Manager',
      groupId: listGroups(vault)[0].id,
    })
    vault.db.exec("UPDATE roles SET permissions = ? WHERE name = 'Admin'", [
      JSON.stringify(permissionsForRole('Admin').filter((permission) => permission !== Permission.MANAGE_SETTINGS)),
    ])
    const sealed = await sealVault(vault)

    const manager = await unlockVault(sealed, 'manager@example.com', 'manager-password')
    open.push(manager)
    expect(() => updateVaultSettings(manager, { vaultName: 'Mine', currency: 'USD' })).toThrow(ForbiddenError)

    const admin = await unlockVault(sealed, 'admin@example.com', 'correct-horse')
    open.push(admin)
    expect(canUser(admin.user, Permission.MANAGE_SETTINGS)).toBe(true)
  })
})
