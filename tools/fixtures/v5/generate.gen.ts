import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, it, vi } from 'vitest'
import { formatFingerprint } from '../../../src/crypto/sign'
import type { KeysRecord } from '../../../src/db/envelope'
import { APP_VERSION, BUILD } from '../../../src/lib/version'
import { base32Decode, importTotpKey, totpAt } from '../../../src/lib/totp'
import { sealVault, unlockVault } from '../../../src/services/auth.service'
import { backupFileText, noteExport } from '../../../src/services/backup.service'
import { createTransaction, listCategories, loadDashboard } from '../../../src/services/finance.service'
import { createInvite, redeemGrant } from '../../../src/services/grant.service'
import { listGroups } from '../../../src/services/group.service'
import { createItem, initializeSafes, listItems } from '../../../src/services/safe.service'
import { beginTotpSetup, enableTotp } from '../../../src/services/totp.service'
import { suspendUser } from '../../../src/services/user.service'
import { createKeysVault } from '../../../src/services/v2/vault'

/** Creates `file`, or fails if it exists: fixtures are immutable, and checking and writing are one step (`wx`). */
function writeOnce(file: string, data: string) {
  try {
    writeFileSync(file, data, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${file} exists; fixtures are immutable`)
    throw error
  }
}

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '../../../tests/fixtures/backups/v5')
const START = new Date('2026-10-18T09:00:00.000Z')
const RECEIPT = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
/** The readers accept 4 KiB to 64 MiB; small chunks give a small file many of them. */
const CHUNK = 16 * 1024

function advance(minutes: number) {
  vi.setSystemTime(new Date(Date.now() + minutes * 60_000))
}

afterAll(() => {
  vi.useRealTimers()
})

it('generates roster-household', async () => {
  if (!APP_VERSION.startsWith('2.0.0')) throw new Error(`v5 fixtures must be produced by 2.0.0, not ${APP_VERSION}`)
  const name = 'roster-household'
  const file = resolve(outDir, `${name}.moliya`)
  // A fixed past clock makes the invite left open in this fixture expired whenever the tests run.
  vi.useFakeTimers({ toFake: ['Date'], now: START })

  const founder = { email: 'founder@roster.test', password: 'Founder roster lantern v5' }
  const alice = { email: 'alice@roster.test', password: 'Alice roster · v5 · Олма' }
  const bob = { email: 'bob@roster.test', password: 'Bob roster compass v5' }
  const carol = { email: 'carol@roster.test', password: 'Carol roster harbour v5' }
  const eve = { email: 'eve@roster.test' }
  const dave = { email: 'dave@roster.test' }
  const home = 'Roster Home'

  // The founder, two invites, and a little of everything that lives in the database.
  const created = await createKeysVault({ email: founder.email, password: founder.password, displayName: home, currency: 'USD' })
  const first = created.vault
  const groupId = listGroups(first)[0].id
  const food = listCategories(first).find((category) => category.nameEn === 'Food')!.id
  const salary = listCategories(first).find((category) => category.nameEn === 'Salary')!.id
  const salaryId = createTransaction(first, { type: 'INCOME', amount: '4200.00', currency: 'USD', categoryId: salary, groupId, date: '2026-10-01', notes: '', receiptData: null })
  const foodId = createTransaction(first, { type: 'EXPENSE', amount: '86.40', currency: 'USD', categoryId: food, groupId, date: '2026-10-03', notes: 'market', receiptData: RECEIPT })
  const { keyring, recoveryCode } = await initializeSafes(first, founder.password, { recovery: true, defaultSafeName: 'Main' })
  const safeId = keyring.meta.defaultSafeId!
  await createItem(first, keyring, safeId, { kind: 'NOTE', title: 'Deposit box', body: 'Box 42 at the Chilonzor branch' })
  const items = (await listItems(first, keyring, safeId, { includeTrashed: true })).items.map(({ createdAt: _created, updatedAt: _updated, rev: _rev, ...item }) => item)
  const aliceInvite = await createInvite(first, { email: alice.email, roleName: 'Manager', groupId, validity: '24h' })
  const bobInvite = await createInvite(first, { email: bob.email, roleName: 'Viewer', groupId, validity: '24h' })
  let record = (await sealVault(first, { full: true })) as KeysRecord
  first.db.close()

  // Alice joins and turns on the sign-in check; Bob joins.
  advance(30)
  const aliceVault = await redeemGrant(record, { kind: 'INVITE', email: alice.email, code: aliceInvite.code, password: alice.password })
  const setup = beginTotpSetup(alice.email)
  const recoveryCodes = await enableTotp(aliceVault, alice.password, setup, await totpAt(await importTotpKey(base32Decode(setup.secret)), Date.now()), Date.now())
  const aliceTx = createTransaction(aliceVault, { type: 'EXPENSE', amount: '19.99', currency: 'USD', categoryId: food, groupId, date: '2026-10-05', notes: 'bread', receiptData: null })
  record = (await sealVault(aliceVault, { full: true })) as KeysRecord
  aliceVault.db.close()
  advance(10)
  const bobVault = await redeemGrant(record, { kind: 'INVITE', email: bob.email, code: bobInvite.code, password: bob.password })
  record = (await sealVault(bobVault, { full: true })) as KeysRecord
  bobVault.db.close()

  // The founder signs both into the roster, then Bob is suspended: a new household key, which also stops Eve's code.
  advance(60)
  const admin = await unlockVault(record, founder.email, founder.password)
  record = (await sealVault(admin, { full: true })) as KeysRecord
  const eveInvite = await createInvite(admin, { email: eve.email, roleName: 'Viewer', groupId, validity: '24h' })
  suspendUser(admin, bobInvite.id)
  const carolInvite = await createInvite(admin, { email: carol.email, roleName: 'Viewer', groupId, validity: '72h' })
  record = (await sealVault(admin, { full: true })) as KeysRecord
  admin.db.close()

  // Carol joins with a code for the new key.
  advance(15)
  const carolVault = await redeemGrant(record, { kind: 'INVITE', email: carol.email, code: carolInvite.code, password: carol.password })
  record = (await sealVault(carolVault, { full: true })) as KeysRecord
  carolVault.db.close()

  // The founder signs Carol in, leaves one short invite open, and exports a backup.
  advance(5)
  const last = await unlockVault(record, founder.email, founder.password)
  const daveInvite = await createInvite(last, { email: dave.email, roleName: 'Viewer', groupId, validity: '15m' })
  noteExport(last)
  const final = (await sealVault(last, { full: true, chunkSize: CHUNK })) as KeysRecord
  const text = backupFileText(final)
  const audit = last.db.query('SELECT action FROM audit_logs ORDER BY seq').map((row) => String(row.action))
  const range = { start: '2026-10-01', end: '2026-10-31' }
  const dashboard = loadDashboard(last, range, 'en')
  last.db.close()
  vi.useRealTimers()

  const expected = {
    description: `Produced by Jaybi ${APP_VERSION} services: vault record v3, backup v3, schema v5 (per-person keys, a signed roster, one new household key after a suspension, and a body in ${CHUNK / 1024} KiB chunks).`,
    producedBy: { appVersion: APP_VERSION, commit: BUILD.commit },
    format: { backup: 3, record: 3, schema: 5 },
    vaultName: home,
    currency: 'USD',
    users: [
      { email: founder.email, password: founder.password, role: 'Admin', group: null },
      { email: alice.email, password: alice.password, role: 'Manager', group: home },
      { email: carol.email, password: carol.password, role: 'Viewer', group: home },
    ],
    groups: [home],
    categoryCount: 14,
    transactions: [
      { id: salaryId, type: 'INCOME', amountMinor: 420000, currency: 'USD', category: 'Salary', group: home, date: '2026-10-01', notes: null, hasReceipt: false, userEmail: founder.email },
      { id: foodId, type: 'EXPENSE', amountMinor: 8640, currency: 'USD', category: 'Food', group: home, date: '2026-10-03', notes: 'market', hasReceipt: true, userEmail: founder.email },
      { id: aliceTx, type: 'EXPENSE', amountMinor: 1999, currency: 'USD', category: 'Food', group: home, date: '2026-10-05', notes: 'bread', hasReceipt: false, userEmail: alice.email },
    ],
    totals: {
      range,
      admin: { incomeMinor: dashboard.income, expenseMinor: dashboard.expense, netMinor: dashboard.net, savingsRate: dashboard.savingsRate },
    },
    auditActions: audit,
    addedOnOpen: ['INVITE_EXPIRED'],
    keys: {
      epoch: final.keys.epoch,
      roster: { version: final.keys.roster.version, hash: final.keys.roster.hash },
      founder: { email: founder.email, fingerprint: formatFingerprint(final.keys.founder.fingerprint) },
      removed: [{ email: bob.email, password: bob.password }],
      chunkSize: final.body.chunkSize,
      chunks: final.body.chunks.length,
    },
    grants: {
      pending: [{ kind: 'INVITE', email: dave.email, code: daveInvite.code, expiresAt: daveInvite.expiresAt }],
      used: [
        { kind: 'INVITE', email: alice.email, code: aliceInvite.code },
        { kind: 'INVITE', email: bob.email, code: bobInvite.code },
        { kind: 'INVITE', email: carol.email, code: carolInvite.code },
      ],
      revoked: [{ kind: 'INVITE', email: eve.email, code: eveInvite.code }],
    },
    safes: {
      summaryDate: '2026-10-18',
      owners: [{ email: founder.email, state: 'OPEN', recoveryCode, safes: [{ id: safeId, name: 'Main', archived: false, requirePassword: false, isDefault: true, items }], totals: [] }],
    },
    signInCheck: { email: alice.email, secret: setup.secret, recoveryCodes },
  }

  mkdirSync(outDir, { recursive: true })
  writeOnce(file, text)
  writeOnce(resolve(outDir, `${name}.expected.json`), `${JSON.stringify(expected, null, 2)}\n`)
  const sums = [`${name}.expected.json`, `${name}.moliya`]
    .map((entry) => `${createHash('sha256').update(readFileSync(resolve(outDir, entry))).digest('hex')}  ${entry}`)
    .join('\n')
  writeFileSync(resolve(outDir, 'SHA256SUMS'), `${sums}\n`)
})
