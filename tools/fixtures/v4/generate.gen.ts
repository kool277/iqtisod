import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, it, vi } from 'vitest'
import { APP_VERSION, BUILD } from '../../../src/lib/version'
import { base32Decode, importTotpKey, totpAt } from '../../../src/lib/totp'
import { createVault, sealVault, unlockVault } from '../../../src/services/auth.service'
import { backupFileText, noteExport } from '../../../src/services/backup.service'
import { createTransaction, listCategories } from '../../../src/services/finance.service'
import { createInvite, issueReset, redeemGrant, revokeGrant } from '../../../src/services/grant.service'
import { listGroups } from '../../../src/services/group.service'
import { beginTotpSetup, enableTotp } from '../../../src/services/totp.service'
import { createUser } from '../../../src/services/user.service'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '../../../tests/fixtures/backups/v4')
const START = new Date('2026-02-02T09:00:00.000Z')
const RECEIPT = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

function advance(minutes: number) {
  vi.setSystemTime(new Date(Date.now() + minutes * 60_000))
}

afterAll(() => {
  vi.useRealTimers()
})

it('generates access-household', async () => {
  if (APP_VERSION !== '1.3.0') throw new Error(`v4 fixtures must be produced by 1.3.0, not ${APP_VERSION}`)
  const name = 'access-household'
  const file = resolve(outDir, `${name}.moliya`)
  if (existsSync(file)) throw new Error(`${file} exists; fixtures are immutable`)
  // A fixed past clock makes the one invite left open in this fixture expired whenever the tests run.
  vi.useFakeTimers({ toFake: ['Date'], now: START })

  const admin = { email: 'admin@access.test', password: 'Plum orchard admin v4' }
  const manager = { email: 'manager@access.test', password: 'Joined by invite · v4 · Олма' }
  const viewer = { email: 'viewer@access.test', initial: 'Temporary viewer words v4', password: 'Viewer after reset code v4' }
  const late = { email: 'late@access.test' }
  const home = 'Access House'

  const { vault } = await createVault({ email: admin.email, password: admin.password, displayName: home, currency: 'UZS' })
  const groupId = listGroups(vault)[0].id
  const food = listCategories(vault).find((category) => category.nameEn === 'Food')!.id
  const salary = listCategories(vault).find((category) => category.nameEn === 'Salary')!.id
  const salaryId = createTransaction(vault, { type: 'INCOME', amount: '12500000', currency: 'UZS', categoryId: salary, groupId, date: '2026-02-01', notes: '', receiptData: null })
  const foodId = createTransaction(vault, { type: 'EXPENSE', amount: '185000', currency: 'UZS', categoryId: food, groupId, date: '2026-02-02', notes: 'bozor', receiptData: RECEIPT })
  const invite = await createInvite(vault, { email: manager.email, roleName: 'Manager', groupId, validity: '24h' })
  const afterInvite = await sealVault(vault)
  vault.db.close()

  advance(60)
  const managerVault = await redeemGrant(afterInvite, { kind: 'INVITE', email: manager.email, code: invite.code, password: manager.password })
  const setup = beginTotpSetup(manager.email)
  const firstCode = await totpAt(await importTotpKey(base32Decode(setup.secret)), Date.now())
  const recoveryCodes = await enableTotp(managerVault, manager.password, setup, firstCode, Date.now())
  const afterManager = await sealVault(managerVault)
  managerVault.db.close()

  advance(30)
  const adminAgain = await unlockVault(afterManager, admin.email, admin.password)
  await createUser(adminAgain, { email: viewer.email, password: viewer.initial, roleName: 'Viewer', groupId })
  const viewerId = String(adminAgain.db.queryValue('SELECT id FROM users WHERE email = ?', [viewer.email]))
  const firstReset = await issueReset(adminAgain, viewerId, { validity: '1h', stopOldPassword: false })
  revokeGrant(adminAgain, firstReset.id)
  const reset = await issueReset(adminAgain, viewerId, { validity: '72h', stopOldPassword: true })
  const pending = await createInvite(adminAgain, { email: late.email, roleName: 'Viewer', groupId, validity: '15m' })
  const afterAdmin = await sealVault(adminAgain)
  adminAgain.db.close()

  advance(5)
  const viewerVault = await redeemGrant(afterAdmin, { kind: 'RESET', email: viewer.email, code: reset.code, password: viewer.password })
  const afterViewer = await sealVault(viewerVault)
  viewerVault.db.close()

  advance(1)
  const last = await unlockVault(afterViewer, admin.email, admin.password)
  noteExport(last)
  const text = backupFileText(await sealVault(last))
  last.db.close()
  vi.useRealTimers()

  const expected = {
    description: `Produced by Moliya ${APP_VERSION} services: vault record v2, backup v2, schema v4 (one-time invite and reset codes, optional sign-in check).`,
    producedBy: { appVersion: APP_VERSION, commit: BUILD.commit },
    format: { backup: 2, record: 2, schema: 4 },
    vaultName: home,
    currency: 'UZS',
    users: [
      { email: admin.email, password: admin.password, role: 'Admin', group: null },
      { email: manager.email, password: manager.password, role: 'Manager', group: home },
      { email: viewer.email, password: viewer.password, role: 'Viewer', group: home },
    ],
    groups: [home],
    categoryCount: 14,
    transactions: [
      { id: salaryId, type: 'INCOME', amountMinor: 1250000000, currency: 'UZS', category: 'Salary', group: home, date: '2026-02-01', notes: null, hasReceipt: false, userEmail: admin.email },
      { id: foodId, type: 'EXPENSE', amountMinor: 18500000, currency: 'UZS', category: 'Food', group: home, date: '2026-02-02', notes: 'bozor', hasReceipt: true, userEmail: admin.email },
    ],
    totals: {
      range: { start: '2026-02-01', end: '2026-02-28' },
      admin: { incomeMinor: 1250000000, expenseMinor: 18500000, netMinor: 1231500000, savingsRate: 98.5 },
    },
    auditActions: [
      'VAULT_CREATED',
      'TRANSACTION_CREATED',
      'TRANSACTION_CREATED',
      'INVITE_CREATED',
      'INVITE_ACCEPTED',
      'TOTP_ENABLED',
      'USER_CREATED',
      'RESET_ISSUED',
      'RESET_REVOKED',
      'RESET_ISSUED',
      'INVITE_CREATED',
      'RESET_COMPLETED',
      'BACKUP_EXPORTED',
    ],
    addedOnOpen: ['INVITE_EXPIRED'],
    grants: {
      pending: [{ kind: 'INVITE', email: late.email, code: pending.code, expiresAt: pending.expiresAt }],
      used: [
        { kind: 'INVITE', email: manager.email, code: invite.code },
        { kind: 'RESET', email: viewer.email, code: reset.code },
      ],
      revoked: [{ kind: 'RESET', email: viewer.email, code: firstReset.code }],
    },
    signInCheck: { email: manager.email, secret: setup.secret, recoveryCodes },
  }

  mkdirSync(outDir, { recursive: true })
  writeFileSync(file, text)
  writeFileSync(resolve(outDir, `${name}.expected.json`), `${JSON.stringify(expected, null, 2)}\n`)
  const sums = [`${name}.expected.json`, `${name}.moliya`]
    .map((entry) => `${createHash('sha256').update(readFileSync(resolve(outDir, entry))).digest('hex')}  ${entry}`)
    .join('\n')
  writeFileSync(resolve(outDir, 'SHA256SUMS'), `${sums}\n`)
})
