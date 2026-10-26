import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, it, vi } from 'vitest'
import { formatFingerprint } from '../../../src/crypto/sign'
import type { KeysRecord } from '../../../src/db/envelope'
import { APP_VERSION, BUILD } from '../../../src/lib/version'
import { base32Decode, importTotpKey, totpAt } from '../../../src/lib/totp'
import { createVault, sealVault, unlockVault } from '../../../src/services/auth.service'
import { backupFileText, noteExport } from '../../../src/services/backup.service'
import { createTransaction, listCategories, loadDashboard } from '../../../src/services/finance.service'
import { createInvite, issueReset, redeemGrant } from '../../../src/services/grant.service'
import { listGroups } from '../../../src/services/group.service'
import { createItem, initializeSafes, listItems } from '../../../src/services/safe.service'
import { createCategory } from '../../../src/services/settings.service'
import { beginTotpSetup, enableTotp } from '../../../src/services/totp.service'
import { suspendUser, updateUser } from '../../../src/services/user.service'
import { auditCheckInput, checkAuditSignatures } from '../../../src/services/v2/audit-check'
import { upgradeToKeys } from '../../../src/services/v2/upgrade'

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
const START = new Date('2026-10-25T09:00:00.000Z')
/** The readers accept 4 KiB to 64 MiB; small chunks give a small file many of them. */
const CHUNK = 16 * 1024

function advance(minutes: number) {
  vi.setSystemTime(new Date(Date.now() + minutes * 60_000))
}

afterAll(() => {
  vi.useRealTimers()
})

/**
 * The household of `signed-household` (rc.1), produced by rc.2, whose signed list of people anchors the audit log: every
 * roster version records where the signed log starts and where the save that signed it left it.
 */
it('generates anchored-household', async () => {
  if (!APP_VERSION.startsWith('2.0.0-rc') || APP_VERSION === '2.0.0-rc.1') throw new Error(`anchored fixtures must be produced by 2.0.0-rc.2 or later, not ${APP_VERSION}`)
  const name = 'anchored-household'
  const file = resolve(outDir, `${name}.moliya`)
  // A fixed past clock makes the invite left open in this fixture expired whenever the tests run.
  vi.useFakeTimers({ toFake: ['Date'], now: START })

  const founder = { email: 'founder@anchored.test', password: 'Founder anchored lantern v5' }
  const alice = { email: 'alice@anchored.test', password: 'Alice anchored · v5 · Олма' }
  const bob = { email: 'bob@anchored.test', password: 'Bob anchored compass v5' }
  const carol = { email: 'carol@anchored.test', password: 'Carol anchored harbour v5' }
  const dave = { email: 'dave@anchored.test', password: 'Dave anchored meadow v5', first: 'Dave first meadow v5' }
  const home = 'Anchored Home'

  // 1.x: a few entries, and an open 1.x invite that the upgrade ends; its entry is the bridge.
  const legacy = (await createVault({ email: founder.email, password: founder.password, displayName: home, currency: 'USD' })).vault
  const groupId = listGroups(legacy)[0].id
  const food = listCategories(legacy).find((category) => category.nameEn === 'Food')!.id
  const salary = listCategories(legacy).find((category) => category.nameEn === 'Salary')!.id
  createCategory(legacy, { type: 'EXPENSE', nameEn: 'Garden', nameUzLatn: 'Bogʻ', nameUzCyrl: 'Боғ', nameRu: 'Сад' })
  const salaryId = createTransaction(legacy, { type: 'INCOME', amount: '5100.00', currency: 'USD', categoryId: salary, groupId, date: '2026-10-01', notes: '', receiptData: null })
  await createInvite(legacy, { email: 'early@anchored.test', roleName: 'Viewer', groupId, validity: '72h' })
  const legacyEntries = Number(legacy.db.queryValue('SELECT COUNT(*) FROM audit_logs'))
  advance(10)
  const { vault: first } = await upgradeToKeys(legacy, founder.password)
  const foodId = createTransaction(first, { type: 'EXPENSE', amount: '64.20', currency: 'USD', categoryId: food, groupId, date: '2026-10-04', notes: 'bazaar', receiptData: null })
  const { keyring, recoveryCode } = await initializeSafes(first, founder.password, { recovery: true, defaultSafeName: 'Main' })
  const safeId = keyring.meta.defaultSafeId!
  await createItem(first, keyring, safeId, { kind: 'NOTE', title: 'Spare key', body: 'With the neighbour at number 7' })
  const items = (await listItems(first, keyring, safeId, { includeTrashed: true })).items.map(({ createdAt: _created, updatedAt: _updated, rev: _rev, ...item }) => item)
  const aliceInvite = await createInvite(first, { email: alice.email, roleName: 'Manager', groupId, validity: '24h' })
  const bobInvite = await createInvite(first, { email: bob.email, roleName: 'Viewer', groupId, validity: '24h' })
  const daveInvite = await createInvite(first, { email: dave.email, roleName: 'Viewer', groupId, validity: '24h' })
  let record = (await sealVault(first, { full: true })) as KeysRecord
  first.db.close()

  // Alice, Bob and Dave join; each signs their entries before any admin save folds their invite in.
  advance(20)
  const aliceVault = await redeemGrant(record, { kind: 'INVITE', email: alice.email, code: aliceInvite.code, password: alice.password })
  const setup = beginTotpSetup(alice.email)
  const recoveryCodes = await enableTotp(aliceVault, alice.password, setup, await totpAt(await importTotpKey(base32Decode(setup.secret)), Date.now()), Date.now())
  const aliceTx = createTransaction(aliceVault, { type: 'EXPENSE', amount: '23.50', currency: 'USD', categoryId: food, groupId, date: '2026-10-06', notes: 'bread and tea', receiptData: null })
  record = (await sealVault(aliceVault, { full: true })) as KeysRecord
  aliceVault.db.close()
  advance(5)
  for (const [person, invite] of [
    [bob, bobInvite],
    [{ email: dave.email, password: dave.first }, daveInvite],
  ] as const) {
    const joined = await redeemGrant(record, { kind: 'INVITE', email: person.email, code: invite.code, password: person.password })
    record = (await sealVault(joined, { full: true })) as KeysRecord
    joined.db.close()
    advance(5)
  }

  // The founder gives Dave a new code at once: Dave's first binding is dropped without being folded in, and only the
  // entry Dave wrote on joining still carries it.
  advance(30)
  const admin = await unlockVault(record, founder.email, founder.password)
  const daveReset = await issueReset(admin, daveInvite.id, { validity: '24h', stopOldPassword: true })
  record = (await sealVault(admin, { full: true })) as KeysRecord
  admin.db.close()
  advance(5)
  const daveVault = await redeemGrant(record, { kind: 'RESET', email: dave.email, code: daveReset.code, password: dave.password })
  record = (await sealVault(daveVault, { full: true })) as KeysRecord
  daveVault.db.close()

  // Alice becomes an admin, suspends Bob (a new household key, which also stops Eve's code) and steps down to Manager
  // in the same save, signed as the admin Alice was.
  advance(15)
  const promoter = await unlockVault(record, founder.email, founder.password)
  const eveInvite = await createInvite(promoter, { email: 'eve@anchored.test', roleName: 'Viewer', groupId, validity: '24h' })
  updateUser(promoter, aliceInvite.id, { roleName: 'Admin', groupId: null })
  record = (await sealVault(promoter, { full: true })) as KeysRecord
  promoter.db.close()
  advance(10)
  const aliceAdmin = await unlockVault(record, alice.email, alice.password)
  suspendUser(aliceAdmin, bobInvite.id)
  updateUser(aliceAdmin, aliceInvite.id, { roleName: 'Manager', groupId })
  record = (await sealVault(aliceAdmin, { full: true })) as KeysRecord
  aliceAdmin.db.close()

  // Carol joins with a code for the new key; the founder signs Carol in, leaves one short invite open, and exports.
  advance(10)
  const inviter = await unlockVault(record, founder.email, founder.password)
  const carolInvite = await createInvite(inviter, { email: carol.email, roleName: 'Viewer', groupId, validity: '72h' })
  record = (await sealVault(inviter, { full: true })) as KeysRecord
  inviter.db.close()
  advance(5)
  const carolVault = await redeemGrant(record, { kind: 'INVITE', email: carol.email, code: carolInvite.code, password: carol.password })
  record = (await sealVault(carolVault, { full: true })) as KeysRecord
  carolVault.db.close()
  advance(5)
  const last = await unlockVault(record, founder.email, founder.password)
  const frankInvite = await createInvite(last, { email: 'frank@anchored.test', roleName: 'Viewer', groupId, validity: '15m' })
  noteExport(last)
  const final = (await sealVault(last, { full: true, chunkSize: CHUNK })) as KeysRecord
  const text = backupFileText(final)
  const audit = last.db.query('SELECT action FROM audit_logs ORDER BY seq').map((row) => String(row.action))
  const head = last.db.queryOne('SELECT seq, hash FROM audit_logs ORDER BY seq DESC LIMIT 1')!
  const check = await checkAuditSignatures((await auditCheckInput(last.db, final.keys.vaultId, null))!)
  if (check.problems.size > 0 || check.signedFrom !== legacyEntries + 1) throw new Error(`the generated log does not check out: ${JSON.stringify([...check.problems])}`)
  const anchors = last.db.query('SELECT doc FROM roster_versions ORDER BY version').map((row) => (JSON.parse(String(row.doc)) as { audit?: { from: number } }).audit)
  if (anchors.some((audit) => audit?.from !== legacyEntries + 1)) throw new Error(`every roster version must anchor the log at ${legacyEntries + 1}: ${JSON.stringify(anchors)}`)
  const range = { start: '2026-10-01', end: '2026-10-31' }
  const dashboard = loadDashboard(last, range, 'en')
  last.db.close()
  vi.useRealTimers()

  const expected = {
    description: `Produced by Jaybi ${APP_VERSION} services: vault record v3, backup v3, schema v5 (a 1.x vault upgraded to per-person keys, signed audit entries from the upgrade on, anchored in every roster version, one new household key after a suspension, and a body in ${CHUNK / 1024} KiB chunks).`,
    producedBy: { appVersion: APP_VERSION, commit: BUILD.commit },
    format: { backup: 3, record: 3, schema: 5 },
    vaultName: home,
    currency: 'USD',
    users: [
      { email: founder.email, password: founder.password, role: 'Admin', group: null },
      { email: alice.email, password: alice.password, role: 'Manager', group: home },
      { email: carol.email, password: carol.password, role: 'Viewer', group: home },
      { email: dave.email, password: dave.password, role: 'Viewer', group: home },
    ],
    groups: [home],
    categoryCount: 15,
    transactions: [
      { id: salaryId, type: 'INCOME', amountMinor: 510000, currency: 'USD', category: 'Salary', group: home, date: '2026-10-01', notes: null, hasReceipt: false, userEmail: founder.email },
      { id: foodId, type: 'EXPENSE', amountMinor: 6420, currency: 'USD', category: 'Food', group: home, date: '2026-10-04', notes: 'bazaar', hasReceipt: false, userEmail: founder.email },
      { id: aliceTx, type: 'EXPENSE', amountMinor: 2350, currency: 'USD', category: 'Food', group: home, date: '2026-10-06', notes: 'bread and tea', hasReceipt: false, userEmail: alice.email },
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
      audit: { signedFrom: check.signedFrom, signed: check.verified, head: { seq: Number(head.seq), hash: String(head.hash) } },
    },
    grants: {
      pending: [{ kind: 'INVITE', email: 'frank@anchored.test', code: frankInvite.code, expiresAt: frankInvite.expiresAt }],
      used: [
        { kind: 'INVITE', email: alice.email, code: aliceInvite.code },
        { kind: 'INVITE', email: bob.email, code: bobInvite.code },
        { kind: 'RESET', email: dave.email, code: daveReset.code },
        { kind: 'INVITE', email: carol.email, code: carolInvite.code },
      ],
      revoked: [{ kind: 'INVITE', email: 'eve@anchored.test', code: eveInvite.code }],
    },
    safes: {
      summaryDate: '2026-10-25',
      owners: [{ email: founder.email, state: 'OPEN', recoveryCode, safes: [{ id: safeId, name: 'Main', archived: false, requirePassword: false, isDefault: true, items }], totals: [] }],
    },
    signInCheck: { email: alice.email, secret: setup.secret, recoveryCodes },
  }

  writeOnce(file, text)
  writeOnce(resolve(outDir, `${name}.expected.json`), `${JSON.stringify(expected, null, 2)}\n`)
  // The folder's other fixtures keep their lines; this one's are added after them.
  const sums = [`${name}.expected.json`, `${name}.moliya`].map((entry) => `${createHash('sha256').update(readFileSync(resolve(outDir, entry))).digest('hex')}  ${entry}`)
  appendFileSync(resolve(outDir, 'SHA256SUMS'), `${sums.join('\n')}\n`)
})
