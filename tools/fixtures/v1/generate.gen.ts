import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'
import type { OpenVault } from '../../../src/domain/types'
import { createVault, sealVault, unlockVault } from '../../../src/services/auth.service'
import { noteExport, vaultToBackup } from '../../../src/services/backup.service'
import {
  createTransaction,
  deleteTransaction,
  listCategories,
  updateTransaction,
} from '../../../src/services/finance.service'
import { createGroup, listGroups } from '../../../src/services/group.service'
import { createCategory, deleteCategory, updateCategory, updateVaultSettings } from '../../../src/services/settings.service'
import { createUser } from '../../../src/services/user.service'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '../../../tests/fixtures/backups/v1')

const RECEIPT =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

type Spec = {
  key: string
  type: 'INCOME' | 'EXPENSE'
  v1Amount: number
  amountMinor: number
  currency: string
  category: string
  group: string
  date: string
  notes: string
  receipt?: boolean
  by?: 'admin' | 'manager'
}

function categoryId(vault: OpenVault, nameEn: string): number {
  const found = listCategories(vault).find((category) => category.nameEn === nameEn)
  if (!found) throw new Error(`missing category ${nameEn}`)
  return found.id
}

function groupId(vault: OpenVault, name: string): number {
  const found = listGroups(vault).find((group) => group.name === name)
  if (!found) throw new Error(`missing group ${name}`)
  return found.id
}

function add(vault: OpenVault, spec: Spec): string {
  return createTransaction(vault, {
    type: spec.type,
    amount: spec.v1Amount,
    currency: spec.currency,
    categoryId: categoryId(vault, spec.category),
    groupId: groupId(vault, spec.group),
    date: spec.date,
    notes: spec.notes,
    receiptData: spec.receipt ? RECEIPT : null,
  })
}

function write(name: string, backup: unknown, expected: unknown) {
  mkdirSync(outDir, { recursive: true })
  const file = resolve(outDir, `${name}.moliya`)
  if (existsSync(file)) throw new Error(`${file} exists; fixtures are immutable`)
  writeFileSync(file, JSON.stringify(backup))
  writeFileSync(resolve(outDir, `${name}.expected.json`), `${JSON.stringify(expected, null, 2)}\n`)
}

async function exportBackup(vault: OpenVault) {
  noteExport(vault)
  return vaultToBackup(await sealVault(vault))
}

it('generates household-usd', async () => {
  const admin = { email: 'admin@golden.test', password: 'golden-admin-v1' }
  const manager = { email: 'manager@golden.test', password: 'golden-manager-v1' }
  const viewer = { email: 'viewer@golden.test', password: 'golden-viewer-v1' }
  const { vault } = await createVault({
    email: 'Admin@Golden.Test',
    password: admin.password,
    displayName: 'Golden Household',
    currency: 'USD',
  })
  createGroup(vault, 'Business')
  createCategory(vault, { type: 'EXPENSE', nameEn: 'Pets', nameUzLatn: '', nameUzCyrl: '', nameRu: 'Питомцы' })
  updateCategory(vault, categoryId(vault, 'Pets'), {
    nameEn: 'Pet care',
    nameUzLatn: 'Uy hayvonlari',
    nameUzCyrl: 'Уй ҳайвонлари',
    nameRu: 'Питомцы',
  })
  createCategory(vault, { type: 'INCOME', nameEn: 'Temporary', nameUzLatn: '', nameUzCyrl: '', nameRu: '' })
  deleteCategory(vault, categoryId(vault, 'Temporary'))
  await createUser(vault, { ...manager, roleName: 'Manager', groupId: groupId(vault, 'Golden Household') })
  await createUser(vault, { ...viewer, roleName: 'Viewer', groupId: groupId(vault, 'Golden Household') })

  const specs: Spec[] = [
    { key: 'salary', type: 'INCOME', v1Amount: 2500, amountMinor: 250000, currency: 'USD', category: 'Salary', group: 'Golden Household', date: '2026-01-05', notes: 'January salary' },
    { key: 'food-1999', type: 'EXPENSE', v1Amount: 19.99, amountMinor: 1999, currency: 'USD', category: 'Food', group: 'Golden Household', date: '2026-01-06', notes: 'Бозор — oʻzbek bozori, “quotes”, emoji 🍞' },
    { key: 'food-010', type: 'EXPENSE', v1Amount: 0.1, amountMinor: 10, currency: 'USD', category: 'Food', group: 'Golden Household', date: '2026-01-07', notes: '' },
    { key: 'food-020', type: 'EXPENSE', v1Amount: 0.2, amountMinor: 20, currency: 'USD', category: 'Food', group: 'Golden Household', date: '2026-01-07', notes: '' },
    { key: 'transport-business', type: 'EXPENSE', v1Amount: 1234.56, amountMinor: 123456, currency: 'USD', category: 'Transport', group: 'Business', date: '2026-02-10', notes: 'Business trip\nline two' },
    { key: 'freelance-uzs', type: 'INCOME', v1Amount: 1000000, amountMinor: 100000000, currency: 'UZS', category: 'Freelance', group: 'Golden Household', date: '2026-02-11', notes: '' },
    { key: 'shopping-eur', type: 'EXPENSE', v1Amount: 45.5, amountMinor: 4550, currency: 'EUR', category: 'Shopping', group: 'Golden Household', date: '2026-02-12', notes: '' },
    { key: 'investment-large', type: 'INCOME', v1Amount: 999999.99, amountMinor: 99999999, currency: 'USD', category: 'Investment', group: 'Golden Household', date: '2026-03-01', notes: '' },
    { key: 'pets-receipt', type: 'EXPENSE', v1Amount: 33.33, amountMinor: 3333, currency: 'USD', category: 'Pet care', group: 'Golden Household', date: '2026-03-02', notes: '=SUM(A1) csv trap', receipt: true },
    { key: 'other-income-cent', type: 'INCOME', v1Amount: 0.01, amountMinor: 1, currency: 'USD', category: 'Other income', group: 'Golden Household', date: '2026-03-04', notes: '' },
    { key: 'health-1005', type: 'EXPENSE', v1Amount: 1.005, amountMinor: 100, currency: 'USD', category: 'Health', group: 'Golden Household', date: '2026-03-06', notes: 'v1 stored Math.round(1.005*100)/100 = 1' },
    { key: 'health-2675', type: 'EXPENSE', v1Amount: 2.675, amountMinor: 268, currency: 'USD', category: 'Health', group: 'Golden Household', date: '2026-03-07', notes: 'v1 stored Math.round(2.675*100)/100 = 2.68 because 2.675*100 is 267.5 in binary floating point' },
  ]
  const ids: Record<string, string> = {}
  for (const spec of specs) ids[spec.key] = add(vault, spec)

  const utilities: Spec = { key: 'utilities-updated', type: 'EXPENSE', v1Amount: 10, amountMinor: 1050, currency: 'USD', category: 'Utilities', group: 'Golden Household', date: '2026-03-05', notes: 'updated from 10 to 10.5' }
  ids[utilities.key] = add(vault, utilities)
  updateTransaction(vault, ids[utilities.key], {
    type: 'EXPENSE',
    amount: 10.5,
    currency: 'USD',
    categoryId: categoryId(vault, 'Utilities'),
    groupId: groupId(vault, 'Golden Household'),
    date: '2026-03-05',
    notes: utilities.notes,
    receiptData: null,
  })
  const doomed = add(vault, { ...utilities, key: 'doomed', v1Amount: 5, category: 'Food', notes: 'deleted' })
  deleteTransaction(vault, doomed)

  const managerVault = await unlockVault(await sealVault(vault), manager.email, manager.password)
  const managerSpec: Spec = { key: 'manager-food', type: 'EXPENSE', v1Amount: 12.34, amountMinor: 1234, currency: 'USD', category: 'Food', group: 'Golden Household', date: '2026-03-03', notes: 'added by manager', by: 'manager' }
  ids[managerSpec.key] = add(managerVault, managerSpec)
  const afterManager = await sealVault(managerVault)
  managerVault.db.close()
  vault.db.close()

  const adminAgain = await unlockVault(afterManager, admin.email, admin.password)
  const backup = await exportBackup(adminAgain)
  adminAgain.db.close()

  const all = [...specs, { ...utilities }, managerSpec]
  write('household-usd', backup, {
    description: 'Produced by Moliya 1.0.0 (commit 46105ec) services: vault record v1, backup v1, schema v1 (no user_version), REAL amounts.',
    producedBy: { appVersion: '1.0.0', commit: '46105ec' },
    format: { backup: 1, schema: 1 },
    vaultName: 'Golden Household',
    currency: 'USD',
    users: [
      { ...admin, role: 'Admin', group: null },
      { ...manager, role: 'Manager', group: 'Golden Household' },
      { ...viewer, role: 'Viewer', group: 'Golden Household' },
    ],
    groups: ['Business', 'Golden Household'],
    customCategories: [{ type: 'EXPENSE', nameEn: 'Pet care', nameUzLatn: 'Uy hayvonlari', nameUzCyrl: 'Уй ҳайвонлари', nameRu: 'Питомцы' }],
    categoryCount: 15,
    transactions: all.map((spec) => ({
      id: ids[spec.key],
      type: spec.type,
      amountMinor: spec.amountMinor,
      currency: spec.currency,
      category: spec.category,
      group: spec.group,
      date: spec.date,
      notes: spec.notes || null,
      hasReceipt: Boolean(spec.receipt),
      userEmail: spec.by === 'manager' ? manager.email : admin.email,
    })),
    totals: {
      range: { start: '2026-01-01', end: '2026-03-31' },
      admin: { incomeMinor: 100250000, expenseMinor: 131470, netMinor: 100118530, savingsRate: 99.9 },
      manager: { incomeMinor: 100250000, expenseMinor: 8014, netMinor: 100241986, savingsRate: 100 },
    },
    auditActions: [
      'VAULT_CREATED',
      'GROUP_CREATED',
      'CATEGORY_CREATED',
      'CATEGORY_UPDATED',
      'CATEGORY_CREATED',
      'CATEGORY_DELETED',
      'USER_CREATED',
      'USER_CREATED',
      ...specs.map(() => 'TRANSACTION_CREATED'),
      'TRANSACTION_CREATED',
      'TRANSACTION_UPDATED',
      'TRANSACTION_CREATED',
      'TRANSACTION_DELETED',
      'TRANSACTION_CREATED',
      'BACKUP_EXPORTED',
    ],
  })
})

it('generates business-uzs', async () => {
  const owner = { email: 'owner@business.test', password: 'пароль-oʻzbek-🔐-v1' }
  const { vault } = await createVault({
    email: 'Owner@Business.Test',
    password: owner.password,
    displayName: 'Savdo MChJ',
    currency: 'USD',
  })
  const specs: Spec[] = [
    { key: 'usd-food', type: 'EXPENSE', v1Amount: 20, amountMinor: 2000, currency: 'USD', category: 'Food', group: 'Savdo MChJ', date: '2026-06-01', notes: '' },
  ]
  const ids: Record<string, string> = {}
  ids['usd-food'] = add(vault, specs[0])
  updateVaultSettings(vault, { vaultName: 'Savdo MChJ', currency: 'UZS' })
  const uzs: Spec[] = [
    { key: 'salary-uzs', type: 'INCOME', v1Amount: 12500000.75, amountMinor: 1250000075, currency: 'UZS', category: 'Salary', group: 'Savdo MChJ', date: '2026-06-02', notes: 'Oylik maosh' },
    { key: 'food-uzs', type: 'EXPENSE', v1Amount: 350000, amountMinor: 35000000, currency: 'UZS', category: 'Food', group: 'Savdo MChJ', date: '2026-06-03', notes: '' },
    { key: 'transport-half', type: 'EXPENSE', v1Amount: 0.5, amountMinor: 50, currency: 'UZS', category: 'Transport', group: 'Savdo MChJ', date: '2026-06-30', notes: '' },
  ]
  for (const spec of uzs) ids[spec.key] = add(vault, spec)
  const backup = await exportBackup(vault)
  vault.db.close()

  write('business-uzs', backup, {
    description: 'Produced by Moliya 1.0.0 (commit 46105ec): single admin, non-ASCII password, currency switched USD to UZS after the first record.',
    producedBy: { appVersion: '1.0.0', commit: '46105ec' },
    format: { backup: 1, schema: 1 },
    vaultName: 'Savdo MChJ',
    currency: 'UZS',
    users: [{ ...owner, role: 'Admin', group: null }],
    groups: ['Savdo MChJ'],
    customCategories: [],
    categoryCount: 14,
    transactions: [...specs, ...uzs].map((spec) => ({
      id: ids[spec.key],
      type: spec.type,
      amountMinor: spec.amountMinor,
      currency: spec.currency,
      category: spec.category,
      group: spec.group,
      date: spec.date,
      notes: spec.notes || null,
      hasReceipt: false,
      userEmail: owner.email,
    })),
    totals: {
      range: { start: '2026-06-01', end: '2026-06-30' },
      admin: { incomeMinor: 1250000075, expenseMinor: 35000050, netMinor: 1215000025, savingsRate: 97.2 },
    },
    auditActions: [
      'VAULT_CREATED',
      'TRANSACTION_CREATED',
      'SETTINGS_UPDATED',
      'TRANSACTION_CREATED',
      'TRANSACTION_CREATED',
      'TRANSACTION_CREATED',
      'BACKUP_EXPORTED',
    ],
  })
})
