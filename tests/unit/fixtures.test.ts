import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CURRENT_KDF, kdfNeedsUpgrade } from '../../src/crypto/crypto.service'
import { verifyAuditChain } from '../../src/db/audit-chain'
import { decodeStoredRecord, storedToBackupJson, type VaultRecord } from '../../src/db/envelope'
import { readSchemaVersion } from '../../src/db/migrations'
import { BACKUP_VERSION, RECORD_VERSION, SCHEMA_VERSION } from '../../src/db/versions'
import { AuthError } from '../../src/domain/errors'
import type { OpenVault } from '../../src/domain/types'
import { listAudit } from '../../src/services/audit.service'
import { sealVault, unlockVault } from '../../src/services/auth.service'
import { backupFileText, parseBackup } from '../../src/services/backup.service'
import { listCategories, listTransactions, loadDashboard } from '../../src/services/finance.service'
import { listGroups } from '../../src/services/group.service'
import {
  FIXTURE_ROOT,
  fixtureFolders,
  readChecksums,
  readFixture,
  readManifest,
  sha256File,
  v1StoredRecordFromBackup,
  type ExpectedUser,
  type Fixture,
} from '../support/fixtures'

const ALL_TIME = { start: '0001-01-01', end: '9999-12-31' }
const open: OpenVault[] = []

afterEach(() => {
  for (const vault of open.splice(0)) vault.db.close()
})

async function unlock(record: VaultRecord, user: ExpectedUser): Promise<OpenVault> {
  const vault = await unlockVault(record, user.email, user.password)
  open.push(vault)
  return vault
}

function visibleTo(fixture: Fixture, user: ExpectedUser) {
  const rows = user.role === 'Admin' ? fixture.expected.transactions : fixture.expected.transactions.filter((tx) => tx.group === user.group)
  return [...rows].sort((left, right) => left.id.localeCompare(right.id))
}

function ledger(vault: OpenVault) {
  return listTransactions(vault, ALL_TIME)
    .map((entry) => ({
      id: entry.id,
      type: entry.type,
      amountMinor: entry.amountMinor,
      currency: entry.currency,
      category: entry.nameEn,
      group: entry.groupName,
      date: entry.date,
      notes: entry.notes,
      hasReceipt: entry.receiptData !== null,
      userEmail: entry.userEmail,
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

function expectTotals(vault: OpenVault, fixture: Fixture, role: 'admin' | 'manager') {
  const expected = fixture.expected.totals[role]
  if (!expected) return
  const dashboard = loadDashboard(vault, fixture.expected.totals.range, 'en')
  expect({ income: dashboard.income, expense: dashboard.expense, net: dashboard.net, savingsRate: dashboard.savingsRate }).toEqual({
    income: expected.incomeMinor,
    expense: expected.expenseMinor,
    net: expected.netMinor,
    savingsRate: expected.savingsRate,
  })
}

async function expectFixtureContents(record: VaultRecord, fixture: Fixture) {
  for (const user of fixture.expected.users) {
    const vault = await unlock(record, user)
    expect(vault.user.roleName).toBe(user.role)
    expect(vault.vaultName).toBe(fixture.expected.vaultName)
    expect(vault.currency).toBe(fixture.expected.currency)
    expect(readSchemaVersion(vault.db)).toBe(SCHEMA_VERSION)
    expect(ledger(vault)).toEqual(visibleTo(fixture, user))
    if (user.role === 'Admin') {
      expectTotals(vault, fixture, 'admin')
      expect(listCategories(vault)).toHaveLength(fixture.expected.categoryCount)
      expect(listGroups(vault).map((group) => group.name).sort()).toEqual([...fixture.expected.groups].sort())
      expect(verifyAuditChain(vault.db)).toMatchObject({ ok: true, brokenAt: null })
    }
    if (user.role === 'Manager') expectTotals(vault, fixture, 'manager')
  }
}

const manifest = readManifest()
const fixtures = manifest.map(readFixture)

describe('golden fixture registry', () => {
  it('pins every fixture file by SHA-256 and never loses one', () => {
    for (const folder of fixtureFolders()) {
      const sums = readChecksums(folder)
      const files = readdirSync(resolve(FIXTURE_ROOT, folder)).filter((name) => name !== 'SHA256SUMS')
      expect([...sums.keys()].sort()).toEqual(files.sort())
      for (const [name, hash] of sums) expect(sha256File(resolve(FIXTURE_ROOT, folder, name)), `${folder}/${name}`).toBe(hash)
    }
    for (const entry of manifest) {
      const [folder, name] = entry.path.split('/')
      const sums = readChecksums(folder)
      expect(sums.has(`${name}.moliya`)).toBe(true)
      expect(sums.has(`${name}.expected.json`)).toBe(true)
      expect(existsSync(resolve(FIXTURE_ROOT, `${entry.path}.moliya`))).toBe(true)
    }
  })

  it('has a fixture for every backup, record, and schema version ever released', () => {
    for (let version = 1; version <= BACKUP_VERSION; version += 1) {
      expect(manifest.some((entry) => entry.backupFormat === version), `backup format ${version}`).toBe(true)
    }
    for (let version = 1; version <= RECORD_VERSION; version += 1) {
      expect(manifest.some((entry) => entry.recordFormat === version), `record format ${version}`).toBe(true)
    }
    for (let version = 1; version <= SCHEMA_VERSION; version += 1) {
      expect(manifest.some((entry) => entry.schemaVersion === version), `schema version ${version}`).toBe(true)
    }
  })
})

describe.each(fixtures.map((fixture) => [fixture.path, fixture] as const))('golden fixture %s', (_path, fixture) => {
  it('is read with the format it was written in', () => {
    const parsed = parseBackup(fixture.text)
    expect(parsed.sourceVersion).toBe(fixture.backupFormat)
    expect(parsed.appVersion).toBe(fixture.producedBy)
    expect(parsed.record.schemaVersion).toBe(fixture.schemaVersion)
  })

  it('opens for every user with exact records, totals, and an intact audit chain', async () => {
    await expectFixtureContents(parseBackup(fixture.text).record, fixture)
  })

  it('refuses a wrong password', async () => {
    const [user] = fixture.expected.users
    await expect(unlockVault(parseBackup(fixture.text).record, user.email, `${user.password}!`)).rejects.toBeInstanceOf(AuthError)
  })

  it('records the upgrade in the audit log and keeps the original history', async () => {
    const admin = fixture.expected.users.find((user) => user.role === 'Admin')!
    const record = parseBackup(fixture.text).record
    const legacyKdf = kdfNeedsUpgrade(record.wraps.find((wrap) => wrap.email === admin.email)!.kdf)
    const vault = await unlock(record, admin)
    const actions = listAudit(vault).map((entry) => entry.action).reverse()
    const added = [
      ...(fixture.schemaVersion < SCHEMA_VERSION ? ['SCHEMA_MIGRATED'] : []),
      ...(legacyKdf ? ['CREDENTIALS_UPGRADED'] : []),
    ]
    expect(actions).toEqual([...fixture.expected.auditActions, ...added])
    expect(vault.needsSave).toBe(added.length > 0)
  })

  it('survives upgrade, re-seal, and a new backup with nothing lost', async () => {
    const admin = fixture.expected.users.find((user) => user.role === 'Admin')!
    const original = parseBackup(fixture.text).record
    const upgraded = await sealVault(await unlock(original, admin))
    expect(upgraded.version).toBe(RECORD_VERSION)
    expect(upgraded.schemaVersion).toBe(SCHEMA_VERSION)
    for (const wrap of upgraded.wraps) {
      const before = original.wraps.find((item) => item.userId === wrap.userId)!
      expect(wrap.kdf).toEqual(wrap.email === admin.email ? CURRENT_KDF : before.kdf)
    }
    const again = await unlock(upgraded, admin)
    expect(again.needsSave).toBe(false)
    const restored = parseBackup(backupFileText(upgraded)).record
    await expectFixtureContents(restored, fixture)
  })

  it.runIf(fixture.recordFormat === 1)('loads the IndexedDB record 1.0.0 stored and re-exports the original backup byte for byte', async () => {
    const raw = v1StoredRecordFromBackup(fixture.text)
    const decoded = decodeStoredRecord(raw)
    expect(decoded.sourceVersion).toBe(1)
    expect(JSON.stringify(storedToBackupJson(raw, '2026-04-01T00:00:00.000Z'))).toBe(fixture.text)
    await expectFixtureContents(decoded.record, fixture)
  })
})
