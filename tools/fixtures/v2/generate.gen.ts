import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'
import type { OpenVault } from '../../../src/domain/types'
import { APP_VERSION, BUILD } from '../../../src/lib/version'
import { createVault, sealVault, unlockVault } from '../../../src/services/auth.service'
import { backupFileText, noteExport } from '../../../src/services/backup.service'
import { createTransaction, deleteTransaction, listCategories, updateTransaction } from '../../../src/services/finance.service'
import { createGroup, listGroups } from '../../../src/services/group.service'
import { createCategory } from '../../../src/services/settings.service'
import { createUser } from '../../../src/services/user.service'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '../../../tests/fixtures/backups/v2')

const RECEIPT =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

type Spec = {
  key: string
  type: 'INCOME' | 'EXPENSE'
  input: string
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

function inputOf(vault: OpenVault, spec: Spec, amount = spec.input) {
  return {
    type: spec.type,
    amount,
    currency: spec.currency,
    categoryId: categoryId(vault, spec.category),
    groupId: groupId(vault, spec.group),
    date: spec.date,
    notes: spec.notes,
    receiptData: spec.receipt ? RECEIPT : null,
  }
}

it('generates ledger-v2', async () => {
  if (APP_VERSION !== '1.1.0') throw new Error(`v2 fixtures must be produced by 1.1.0, not ${APP_VERSION}`)
  const name = 'ledger-v2'
  const file = resolve(outDir, `${name}.moliya`)
  if (existsSync(file)) throw new Error(`${file} exists; fixtures are immutable`)

  const admin = { email: 'admin@ledger.test', password: 'ledger-admin-v2' }
  const manager = { email: 'manager@ledger.test', password: 'ledger-manager-v2' }
  const viewer = { email: 'viewer@ledger.test', password: 'Ledger viewer · вьюер · v2' }
  const home = 'Ledger Two'
  const side = 'Side Business'

  const { vault } = await createVault({ email: 'Admin@Ledger.Test', password: admin.password, displayName: home, currency: 'USD' })
  createGroup(vault, side)
  createCategory(vault, { type: 'EXPENSE', nameEn: 'Subscriptions', nameUzLatn: 'Obunalar', nameUzCyrl: 'Обуналар', nameRu: 'Подписки' })
  await createUser(vault, { ...manager, roleName: 'Manager', groupId: groupId(vault, home) })
  await createUser(vault, { ...viewer, roleName: 'Viewer', groupId: groupId(vault, home) })

  const specs: Spec[] = [
    { key: 'salary', type: 'INCOME', input: '4200', amountMinor: 420000, currency: 'USD', category: 'Salary', group: home, date: '2026-10-01', notes: 'October salary' },
    { key: 'food-dot', type: 'EXPENSE', input: '0.10', amountMinor: 10, currency: 'USD', category: 'Food', group: home, date: '2026-10-02', notes: '' },
    { key: 'food-comma', type: 'EXPENSE', input: '0,20', amountMinor: 20, currency: 'USD', category: 'Food', group: home, date: '2026-10-02', notes: 'comma decimal separator' },
    { key: 'transport-side', type: 'EXPENSE', input: '1 234.56', amountMinor: 123456, currency: 'USD', category: 'Transport', group: side, date: '2026-10-15', notes: 'Grouped digits\nsecond line' },
    { key: 'freelance-uzs', type: 'INCOME', input: '2500000', amountMinor: 250000000, currency: 'UZS', category: 'Freelance', group: home, date: '2026-11-01', notes: 'Oʻzbekcha izoh — Ўзбекча' },
    { key: 'shopping-eur', type: 'EXPENSE', input: '99.99', amountMinor: 9999, currency: 'EUR', category: 'Shopping', group: home, date: '2026-11-02', notes: '' },
    { key: 'health-receipt', type: 'EXPENSE', input: '2.67', amountMinor: 267, currency: 'USD', category: 'Health', group: home, date: '2026-11-03', notes: 'with receipt', receipt: true },
    { key: 'subscription', type: 'EXPENSE', input: '15', amountMinor: 1500, currency: 'USD', category: 'Subscriptions', group: home, date: '2026-12-02', notes: '@SUM(1+1) csv trap' },
    { key: 'other-income-cent', type: 'INCOME', input: '0.01', amountMinor: 1, currency: 'USD', category: 'Other income', group: home, date: '2026-12-01', notes: '' },
  ]
  const ids: Record<string, string> = {}
  for (const spec of specs) ids[spec.key] = createTransaction(vault, inputOf(vault, spec))

  const utilities: Spec = { key: 'utilities-updated', type: 'EXPENSE', input: '10', amountMinor: 1050, currency: 'USD', category: 'Utilities', group: home, date: '2026-12-03', notes: 'updated from 10 to 10.50' }
  ids[utilities.key] = createTransaction(vault, inputOf(vault, utilities))
  updateTransaction(vault, ids[utilities.key], inputOf(vault, utilities, '10.50'))
  const doomed = createTransaction(vault, inputOf(vault, { ...utilities, notes: 'deleted' }, '5'))
  deleteTransaction(vault, doomed)

  const managerVault = await unlockVault(await sealVault(vault), manager.email, manager.password)
  const managerSpec: Spec = { key: 'manager-food', type: 'EXPENSE', input: '12.34', amountMinor: 1234, currency: 'USD', category: 'Food', group: home, date: '2026-12-04', notes: 'added by manager', by: 'manager' }
  ids[managerSpec.key] = createTransaction(managerVault, inputOf(managerVault, managerSpec))
  const afterManager = await sealVault(managerVault)
  managerVault.db.close()
  vault.db.close()

  const adminAgain = await unlockVault(afterManager, admin.email, admin.password)
  const maxSpec: Spec = { key: 'max-amount', type: 'INCOME', input: '9999999999999.99', amountMinor: 999999999999999, currency: 'USD', category: 'Investment', group: home, date: '2027-01-05', notes: 'largest accepted amount' }
  ids[maxSpec.key] = createTransaction(adminAgain, inputOf(adminAgain, maxSpec))
  noteExport(adminAgain)
  const text = backupFileText(await sealVault(adminAgain))
  adminAgain.db.close()

  const all = [...specs, utilities, managerSpec, maxSpec]
  const expected = {
    description: `Produced by Moliya ${APP_VERSION} services: vault record v2, backup v2, schema v2 (integer minor units, audit hash chain, PBKDF2 600k).`,
    producedBy: { appVersion: APP_VERSION, commit: BUILD.commit },
    format: { backup: 2, record: 2, schema: 2 },
    vaultName: home,
    currency: 'USD',
    users: [
      { ...admin, role: 'Admin', group: null },
      { ...manager, role: 'Manager', group: home },
      { ...viewer, role: 'Viewer', group: home },
    ],
    groups: [home, side],
    customCategories: [{ type: 'EXPENSE', nameEn: 'Subscriptions', nameUzLatn: 'Obunalar', nameUzCyrl: 'Обуналар', nameRu: 'Подписки' }],
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
      range: { start: '2026-10-01', end: '2026-12-31' },
      admin: { incomeMinor: 420001, expenseMinor: 127537, netMinor: 292464, savingsRate: 69.6 },
      manager: { incomeMinor: 420001, expenseMinor: 4081, netMinor: 415920, savingsRate: 99 },
    },
    auditActions: [
      'VAULT_CREATED',
      'GROUP_CREATED',
      'CATEGORY_CREATED',
      'USER_CREATED',
      'USER_CREATED',
      ...specs.map(() => 'TRANSACTION_CREATED'),
      'TRANSACTION_CREATED',
      'TRANSACTION_UPDATED',
      'TRANSACTION_CREATED',
      'TRANSACTION_DELETED',
      'TRANSACTION_CREATED',
      'TRANSACTION_CREATED',
      'BACKUP_EXPORTED',
    ],
  }

  mkdirSync(outDir, { recursive: true })
  writeFileSync(file, text)
  writeFileSync(resolve(outDir, `${name}.expected.json`), `${JSON.stringify(expected, null, 2)}\n`)
  const sums = [`${name}.expected.json`, `${name}.moliya`]
    .map((entry) => `${createHash('sha256').update(readFileSync(resolve(outDir, entry))).digest('hex')}  ${entry}`)
    .join('\n')
  writeFileSync(resolve(outDir, 'SHA256SUMS'), `${sums}\n`)
})
