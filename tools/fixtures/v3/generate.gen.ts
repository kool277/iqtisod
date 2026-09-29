import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'
import type { SecureItem, SecureItemInput } from '../../../src/domain/safes'
import { subscriptionSummary } from '../../../src/domain/subscriptions'
import type { OpenVault } from '../../../src/domain/types'
import { APP_VERSION, BUILD } from '../../../src/lib/version'
import { changeOwnPassword } from '../../../src/services/account.service'
import { createVault, sealVault, unlockVault } from '../../../src/services/auth.service'
import { backupFileText, noteExport } from '../../../src/services/backup.service'
import { createTransaction, listCategories } from '../../../src/services/finance.service'
import { listGroups } from '../../../src/services/group.service'
import {
  createItem,
  createSafe,
  initializeSafes,
  listItems,
  openSafe,
  trashItems,
  updateSafe,
  type SafeKeyring,
} from '../../../src/services/safe.service'
import { createUser, resetUserPassword } from '../../../src/services/user.service'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '../../../tests/fixtures/backups/v3')

function stable(item: SecureItem) {
  const { createdAt: _created, updatedAt: _updated, rev: _rev, ...rest } = item
  return rest
}

async function itemsOf(vault: OpenVault, keyring: SafeKeyring, safeId: string) {
  const { items } = await listItems(vault, keyring, safeId, { includeTrashed: true })
  return items.map(stable)
}

it('generates safes-household', async () => {
  if (APP_VERSION !== '1.2.0') throw new Error(`v3 fixtures must be produced by 1.2.0, not ${APP_VERSION}`)
  const name = 'safes-household'
  const file = resolve(outDir, `${name}.moliya`)
  if (existsSync(file)) throw new Error(`${file} exists; fixtures are immutable`)

  const admin = { email: 'admin@safes.test', password: 'safes-admin-v3' }
  const manager = { email: 'manager@safes.test', initial: 'set-by-admin-m3', password: 'safes-manager-v3' }
  const viewer = { email: 'viewer@safes.test', initial: 'set-by-admin-v3', previous: 'Viewer own · свой · v3', reset: 'reset-by-admin-v3', password: 'viewer-after-reset-v3' }
  const home = 'Safe House'

  const { vault } = await createVault({ email: admin.email, password: admin.password, displayName: home, currency: 'USD' })
  const groupId = listGroups(vault)[0].id
  await createUser(vault, { email: manager.email, password: manager.initial, roleName: 'Manager', groupId })
  await createUser(vault, { email: viewer.email, password: viewer.initial, roleName: 'Viewer', groupId })
  const food = listCategories(vault).find((category) => category.nameEn === 'Food')!.id
  const salary = listCategories(vault).find((category) => category.nameEn === 'Salary')!.id
  const salaryId = createTransaction(vault, { type: 'INCOME', amount: '3000', currency: 'USD', categoryId: salary, groupId, date: '2026-10-01', notes: '', receiptData: null })
  const foodId = createTransaction(vault, { type: 'EXPENSE', amount: '42.50', currency: 'USD', categoryId: food, groupId, date: '2026-10-03', notes: 'market', receiptData: null })

  const adminSafes = await initializeSafes(vault, admin.password, { recovery: true, defaultSafeName: 'Personal' })
  const ak = adminSafes.keyring
  const personal = ak.meta.defaultSafeId
  const visaInput: SecureItemInput = {
    kind: 'CARD', title: 'Family Visa', cardholder: 'Aziza Karimova', number: '4111111111111111', brand: 'VISA',
    expMonth: 8, expYear: 2029, cvv: '737', bank: 'Kapitalbank', notes: 'Main card', favorite: true,
  }
  const visa = await createItem(vault, ak, personal, visaInput)
  const humo = await createItem(vault, ak, personal, {
    kind: 'CARD', title: 'Salary Humo', cardholder: 'AZIZA KARIMOVA', number: '9860 1234 5678 9012', brand: 'HUMO',
    expMonth: 12, expYear: 2027, cvv: null, bank: 'Xalq banki', notes: '',
  })
  await createItem(vault, ak, personal, {
    kind: 'SUBSCRIPTION', title: 'Netflix', url: 'https://www.netflix.com/', amountMinor: 999, currency: 'USD', cycle: 'MONTHLY',
    customDays: null, anchorDate: '2026-01-31', status: 'ACTIVE', trialEndsOn: null, remindDaysBefore: 3, cardItemId: visa,
    account: 'aziza@example.com', notes: '',
  })
  await createItem(vault, ak, personal, {
    kind: 'SUBSCRIPTION', title: 'Internet', url: '', amountMinor: 1_200_000_00, currency: 'UZS', cycle: 'YEARLY',
    customDays: null, anchorDate: '2026-03-15', status: 'ACTIVE', trialEndsOn: null, remindDaysBefore: 7, cardItemId: humo,
    account: 'contract 77-1', notes: 'Paid yearly',
  })
  await createItem(vault, ak, personal, {
    kind: 'SUBSCRIPTION', title: 'Old gym', url: '', amountMinor: 250_000_00, currency: 'UZS', cycle: 'MONTHLY',
    customDays: null, anchorDate: '2026-02-01', status: 'CANCELLED', trialEndsOn: null, remindDaysBefore: 0, cardItemId: null,
    account: '', notes: '',
  })
  await createItem(vault, ak, personal, { kind: 'NOTE', title: 'Deposit box', body: 'Box 42, Chilonzor branch.\nKey in the blue drawer.' })
  const travel = await createSafe(vault, ak, { name: 'Travel', description: 'Old trips', icon: 'plane', color: 'brass', requirePassword: false })
  await createItem(vault, ak, travel, { kind: 'NOTE', title: 'Visa numbers', body: 'Schengen 2025: X1234567' })
  const trashed = await createItem(vault, ak, travel, { kind: 'NOTE', title: 'Hotel wifi', body: 'guest / sunshine' })
  await trashItems(vault, ak, [trashed])
  await updateSafe(vault, ak, travel, { archived: true })
  const adminExpected = {
    safes: [
      { id: personal, name: 'Personal', archived: false, requirePassword: false, isDefault: true, items: await itemsOf(vault, ak, personal) },
      { id: travel, name: 'Travel', archived: true, requirePassword: false, isDefault: false, items: await itemsOf(vault, ak, travel) },
    ],
    totals: subscriptionSummary([...(await listItems(vault, ak, personal)).items], '2026-10-01').totals,
  }

  const managerVault = await unlockVault(await sealVault(vault), manager.email, manager.initial)
  vault.db.close()
  await changeOwnPassword(managerVault, manager.initial, manager.password)
  const managerSafes = await initializeSafes(managerVault, manager.password, { recovery: true, defaultSafeName: 'Shaxsiy' })
  const mk = managerSafes.keyring
  const vip = await createSafe(managerVault, mk, { name: 'Oltin · Золото', description: '', icon: 'shield', color: 'clay', requirePassword: true })
  await openSafe(managerVault, mk, vip)
  await createItem(managerVault, mk, vip, {
    kind: 'CARD', title: 'Business Mastercard', cardholder: 'Rustam T.', number: '5555555555554444', brand: 'MASTERCARD',
    expMonth: 1, expYear: 2027, cvv: null, bank: '', notes: '',
  })
  await createItem(managerVault, mk, vip, {
    kind: 'SUBSCRIPTION', title: 'Cloud backup', url: 'https://backup.example/', amountMinor: 1000, currency: 'EUR', cycle: 'CUSTOM',
    customDays: 30, anchorDate: '2026-09-20', status: 'ACTIVE', trialEndsOn: '2026-10-05', remindDaysBefore: 5, cardItemId: null,
    account: '', notes: '',
  })
  const managerExpected = {
    safes: [
      { id: mk.meta.defaultSafeId, name: 'Shaxsiy', archived: false, requirePassword: false, isDefault: true, items: [] as ReturnType<typeof stable>[] },
      { id: vip, name: 'Oltin · Золото', archived: false, requirePassword: true, isDefault: false, items: await itemsOf(managerVault, mk, vip) },
    ],
    totals: subscriptionSummary((await listItems(managerVault, mk, vip)).items, '2026-10-01').totals,
  }

  const viewerVault = await unlockVault(await sealVault(managerVault), viewer.email, viewer.initial)
  managerVault.db.close()
  await changeOwnPassword(viewerVault, viewer.initial, viewer.previous)
  const viewerSafes = await initializeSafes(viewerVault, viewer.previous, { recovery: true, defaultSafeName: 'Личное' })
  const vk = viewerSafes.keyring
  await createItem(viewerVault, vk, vk.meta.defaultSafeId, { kind: 'NOTE', title: 'Wi-Fi', body: 'Uy · Дом: parol-123' })
  const viewerExpected = {
    safes: [{ id: vk.meta.defaultSafeId, name: 'Личное', archived: false, requirePassword: false, isDefault: true, items: await itemsOf(viewerVault, vk, vk.meta.defaultSafeId) }],
    totals: [],
  }
  const afterViewer = await sealVault(viewerVault)
  viewerVault.db.close()

  await new Promise((resolve) => setTimeout(resolve, 20))
  const adminAgain = await unlockVault(afterViewer, admin.email, admin.password)
  await resetUserPassword(adminAgain, viewerVault.user.id, viewer.reset)
  const afterReset = await sealVault(adminAgain)
  adminAgain.db.close()
  const viewerReset = await unlockVault(afterReset, viewer.email, viewer.reset)
  await changeOwnPassword(viewerReset, viewer.reset, viewer.password)
  const afterChange = await sealVault(viewerReset)
  viewerReset.db.close()

  const last = await unlockVault(afterChange, admin.email, admin.password)
  noteExport(last)
  const text = backupFileText(await sealVault(last))
  last.db.close()

  const expected = {
    description: `Produced by Moliya ${APP_VERSION} services: vault record v2, backup v2, schema v3 (private safes, HKDF password verifier).`,
    producedBy: { appVersion: APP_VERSION, commit: BUILD.commit },
    format: { backup: 2, record: 2, schema: 3 },
    vaultName: home,
    currency: 'USD',
    users: [
      { email: admin.email, password: admin.password, role: 'Admin', group: null },
      { email: manager.email, password: manager.password, role: 'Manager', group: home },
      { email: viewer.email, password: viewer.password, role: 'Viewer', group: home },
    ],
    groups: [home],
    categoryCount: 14,
    transactions: [
      { id: salaryId, type: 'INCOME', amountMinor: 300000, currency: 'USD', category: 'Salary', group: home, date: '2026-10-01', notes: null, hasReceipt: false, userEmail: admin.email },
      { id: foodId, type: 'EXPENSE', amountMinor: 4250, currency: 'USD', category: 'Food', group: home, date: '2026-10-03', notes: 'market', hasReceipt: false, userEmail: admin.email },
    ],
    totals: {
      range: { start: '2026-10-01', end: '2026-10-31' },
      admin: { incomeMinor: 300000, expenseMinor: 4250, netMinor: 295750, savingsRate: 98.6 },
    },
    auditActions: [
      'VAULT_CREATED',
      'USER_CREATED',
      'USER_CREATED',
      'TRANSACTION_CREATED',
      'TRANSACTION_CREATED',
      'PASSWORD_CHANGED',
      'PASSWORD_CHANGED',
      'USER_PASSWORD_RESET',
      'PASSWORD_CHANGED',
      'BACKUP_EXPORTED',
    ],
    safes: {
      summaryDate: '2026-10-01',
      owners: [
        { email: admin.email, state: 'OPEN', recoveryCode: adminSafes.recoveryCode, ...adminExpected },
        { email: manager.email, state: 'OPEN', recoveryCode: managerSafes.recoveryCode, ...managerExpected },
        { email: viewer.email, state: 'STALE', previousPassword: viewer.previous, recoveryCode: viewerSafes.recoveryCode, ...viewerExpected },
      ],
    },
  }

  mkdirSync(outDir, { recursive: true })
  writeFileSync(file, text)
  writeFileSync(resolve(outDir, `${name}.expected.json`), `${JSON.stringify(expected, null, 2)}\n`)
  const sums = [`${name}.expected.json`, `${name}.moliya`]
    .map((entry) => `${createHash('sha256').update(readFileSync(resolve(outDir, entry))).digest('hex')}  ${entry}`)
    .join('\n')
  writeFileSync(resolve(outDir, 'SHA256SUMS'), `${sums}\n`)
})
