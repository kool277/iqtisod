import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CURRENT_KDF, kdfNeedsUpgrade } from '../../src/crypto/crypto.service'
import { verifyAuditChain } from '../../src/db/audit-chain'
import { CHUNK_BYTES } from '../../src/db/chunks'
import { decodeStoredRecord, storedToBackupJson, type KeysRecord, type VaultRecord } from '../../src/db/envelope'
import { readSchemaVersion } from '../../src/db/migrations'
import { KEYS_BACKUP_VERSION, KEYS_RECORD_VERSION, KEYS_SCHEMA_VERSION, RECORD_VERSION, SCHEMA_VERSION } from '../../src/db/versions'
import { AuthError } from '../../src/domain/errors'
import type { OpenVault } from '../../src/domain/types'
import { listAudit } from '../../src/services/audit-log'
import { sealVault, unlockVault } from '../../src/services/auth.service'
import { backupFileText, parseBackup } from '../../src/services/backup.service'
import { listCategories, listTransactions, loadDashboard } from '../../src/services/finance.service'
import { listGrants, redeemGrant } from '../../src/services/grant.service'
import { listGroups } from '../../src/services/group.service'
import { completeTotpChallenge, hasSignInCheck, openTotpChallenge } from '../../src/services/totp.service'
import { auditCheckInput, checkAuditSignatures } from '../../src/services/v2/audit-check'
import { formatFingerprint } from '../../src/crypto/sign'
import { base32Decode, importTotpKey, totpAt } from '../../src/lib/totp'
import { DecryptError, SAFE_KEY_USAGES, aad, unwrapWithAad } from '../../src/crypto/safe-crypto'
import { subscriptionSummary } from '../../src/domain/subscriptions'
import {
  getSafeStatus,
  listItems,
  listOpenItems,
  listSafes,
  openSafe,
  unlockSafes,
  type SafeKeyring,
} from '../../src/services/safe.service'
import {
  FIXTURE_ROOT,
  fixtureFolders,
  readChecksums,
  readFixture,
  readManifest,
  sha256File,
  v1StoredRecordFromBackup,
  type ExpectedSafeOwner,
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
    expect(readSchemaVersion(vault.db)).toBe(fixture.recordFormat === KEYS_RECORD_VERSION ? KEYS_SCHEMA_VERSION : SCHEMA_VERSION)
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

async function expectSafes(vault: OpenVault, keyring: SafeKeyring, owner: ExpectedSafeOwner, password: string, summaryDate: string) {
  const listed = await listSafes(vault, keyring)
  expect(
    listed.map((safe) => ({
      id: safe.id,
      name: safe.meta?.name,
      archived: safe.meta?.archived,
      requirePassword: safe.meta?.requirePassword,
      isDefault: safe.isDefault,
    })),
  ).toEqual(owner.safes.map(({ items: _items, ...safe }) => safe))
  for (const safe of owner.safes) {
    if (safe.requirePassword) {
      await expect(listItems(vault, keyring, safe.id)).rejects.toMatchObject({ code: 'SAFE_CLOSED' })
      await openSafe(vault, keyring, safe.id, password)
    }
    const { items, unreadable } = await listItems(vault, keyring, safe.id, { includeTrashed: true })
    expect(unreadable).toEqual([])
    expect(items.map(({ createdAt: _created, updatedAt: _updated, rev: _rev, ...item }) => item)).toEqual(safe.items)
  }
  expect(subscriptionSummary((await listOpenItems(vault, keyring)).items, summaryDate).totals).toEqual(owner.totals)
}

const manifest = readManifest()
const fixtures = manifest.map(readFixture)
/** 1.x vaults (records 1 and 2) and vaults with per-person keys (record 3) are checked each on their own track. */
const legacyFixtures = fixtures.filter((fixture) => fixture.recordFormat < KEYS_RECORD_VERSION)
const keysFixtures = fixtures.filter((fixture) => fixture.recordFormat === KEYS_RECORD_VERSION)

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

  it('has a fixture for every backup, record, and schema version on both tracks', () => {
    // The per-person-keys versions come after the 1.x ones, so this covers both tracks.
    for (let version = 1; version <= KEYS_BACKUP_VERSION; version += 1) {
      expect(manifest.some((entry) => entry.backupFormat === version), `backup format ${version}`).toBe(true)
    }
    for (let version = 1; version <= KEYS_RECORD_VERSION; version += 1) {
      expect(manifest.some((entry) => entry.recordFormat === version), `record format ${version}`).toBe(true)
    }
    for (let version = 1; version <= KEYS_SCHEMA_VERSION; version += 1) {
      expect(manifest.some((entry) => entry.schemaVersion === version), `schema version ${version}`).toBe(true)
    }
  })
})

describe.each(legacyFixtures.map((fixture) => [fixture.path, fixture] as const))('golden fixture %s', (_path, fixture) => {
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
      ...(fixture.expected.addedOnOpen ?? []),
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

  it.runIf(fixture.expected.safes !== undefined)('opens each private safe only for its owner, with exact contents', async () => {
    const safes = fixture.expected.safes!
    const record = parseBackup(fixture.text).record
    const unlocked = new Map<string, { vault: OpenVault; keyring: SafeKeyring }>()
    for (const owner of safes.owners) {
      const user = fixture.expected.users.find((item) => item.email === owner.email)!
      const vault = await unlock(record, user)
      let keyring: SafeKeyring
      if (owner.state === 'STALE') {
        expect(getSafeStatus(vault)).toMatchObject({ initialized: true, stale: true, hasRecovery: owner.recoveryCode !== null })
        await expect(unlockSafes(vault, { kind: 'password', password: user.password })).rejects.toMatchObject({ code: 'SAFES_STALE' })
        const viaCode = await unlock(record, user)
        const recovered = await unlockSafes(viaCode, { kind: 'recoveryCode', code: owner.recoveryCode!, current: user.password })
        await expectSafes(viaCode, recovered.keyring, owner, user.password, safes.summaryDate)
        keyring = (await unlockSafes(vault, { kind: 'previousPassword', previous: owner.previousPassword!, current: user.password })).keyring
      } else {
        expect(getSafeStatus(vault)).toMatchObject({ initialized: true, stale: false, hasRecovery: owner.recoveryCode !== null })
        keyring = (await unlockSafes(vault, { kind: 'password', password: user.password })).keyring
      }
      await expectSafes(vault, keyring, owner, user.password, safes.summaryDate)
      unlocked.set(owner.email, { vault, keyring })
    }
    for (const [email, { vault, keyring }] of unlocked) {
      for (const other of safes.owners.filter((owner) => owner.email !== email)) {
        for (const safe of other.safes) {
          await expect(listItems(vault, keyring, safe.id)).rejects.toMatchObject({ code: 'SAFE_NOT_FOUND' })
          const row = vault.db.queryOne('SELECT owner_user_id, key_version, key_iv, wrapped_key FROM safes WHERE id = ?', [safe.id])!
          const data = aad('moliya.safe-key', String(row.owner_user_id), safe.id, Number(row.key_version))
          await expect(
            unwrapWithAad({ iv: String(row.key_iv), ct: String(row.wrapped_key) }, keyring.personalKey, data, { extractable: false, usages: SAFE_KEY_USAGES }),
          ).rejects.toBeInstanceOf(DecryptError)
        }
      }
    }
  })

  it.runIf(fixture.recordFormat === 1)('loads the IndexedDB record 1.0.0 stored and re-exports the original backup byte for byte', async () => {
    const raw = v1StoredRecordFromBackup(fixture.text)
    const decoded = decodeStoredRecord(raw)
    expect(decoded.sourceVersion).toBe(1)
    expect(JSON.stringify(storedToBackupJson(raw, '2026-04-01T00:00:00.000Z'))).toBe(fixture.text)
    await expectFixtureContents(decoded.record, fixture)
  })

  it.runIf(fixture.expected.grants !== undefined)('ends expired codes on open and refuses used, revoked and expired ones', async () => {
    const grants = fixture.expected.grants!
    const record = parseBackup(fixture.text).record
    expect((record.grants ?? []).map((grant) => ({ kind: grant.kind, email: grant.email }))).toEqual(
      grants.pending.map((grant) => ({ kind: grant.kind, email: grant.email })),
    )
    const admin = fixture.expected.users.find((user) => user.role === 'Admin')!
    const vault = await unlock(record, admin)
    expect(vault.grants).toEqual([])
    expect(listGrants(vault)).toEqual([])
    const ended = vault.db.query('SELECT kind, email, ended_reason FROM access_grants ORDER BY created_at').map((row) => ({ ...row }))
    expect(ended).toEqual([
      { kind: 'INVITE', email: grants.used[0].email, ended_reason: 'USED' },
      { kind: 'RESET', email: grants.revoked[0].email, ended_reason: 'REVOKED' },
      { kind: 'RESET', email: grants.used[1].email, ended_reason: 'USED' },
      { kind: 'INVITE', email: grants.pending[0].email, ended_reason: 'EXPIRED' },
    ])
    expect(vault.db.queryValue("SELECT COUNT(*) FROM access_grants WHERE length(code_verifier) <> 64")).toBe(0)
    const password = 'A brand new passphrase for tests'
    for (const grant of [...grants.used, ...grants.revoked]) {
      await expect(redeemGrant(record, { ...grant, password })).rejects.toMatchObject({ code: 'INVITE_INVALID' })
    }
    const [late] = grants.pending
    await expect(redeemGrant(record, { ...late, password })).rejects.toMatchObject({ code: 'INVITE_EXPIRED' })
    await expect(redeemGrant(record, { ...late, password }, new Date(Date.parse(late.expiresAt) - 60 * 60_000))).rejects.toMatchObject({ code: 'CLOCK_BEHIND' })
  })

  it.runIf(fixture.expected.signInCheck !== undefined)('keeps the sign-in check secret readable only with its owner\'s password', async () => {
    const check = fixture.expected.signInCheck!
    const record = parseBackup(fixture.text).record
    const owner = fixture.expected.users.find((user) => user.email === check.email)!
    const vault = await unlock(record, owner)
    expect(hasSignInCheck(vault.db, vault.user.id)).toBe(true)
    const challenge = (await openTotpChallenge(vault, owner.password))!
    const now = Date.now()
    const code = await totpAt(await importTotpKey(base32Decode(check.secret)), now)
    await expect(completeTotpChallenge(vault, challenge, '000000', now)).rejects.toMatchObject({ code: 'TOTP_INVALID' })
    await expect(completeTotpChallenge(vault, challenge, code, now)).resolves.toMatchObject({ usedRecovery: false })
    await expect(completeTotpChallenge(vault, challenge, code, now)).rejects.toMatchObject({ code: 'TOTP_INVALID' })
    await expect(completeTotpChallenge(vault, challenge, check.recoveryCodes[3], now)).resolves.toEqual({ usedRecovery: true, recoveryLeft: 9 })
    await expect(completeTotpChallenge(vault, challenge, check.recoveryCodes[3], now)).rejects.toMatchObject({ code: 'TOTP_INVALID' })
    for (const other of fixture.expected.users.filter((user) => user.email !== check.email)) {
      const someone = await unlock(record, other)
      expect(hasSignInCheck(someone.db, someone.user.id)).toBe(false)
      await expect(openTotpChallenge(someone, other.password)).resolves.toBeNull()
      const row = someone.db.queryOne('SELECT user_id FROM user_totp')!
      expect(row.user_id).not.toBe(someone.user.id)
    }
    await expect(openTotpChallenge(vault, `${owner.password}!`)).rejects.toBeInstanceOf(AuthError)
  })
})

describe.each(keysFixtures.map((fixture) => [fixture.path, fixture] as const))('golden fixture %s (per-person keys)', (_path, fixture) => {
  const keys = fixture.expected.keys!
  const admin = fixture.expected.users.find((user) => user.role === 'Admin')!
  const record = () => parseBackup(fixture.text).record as KeysRecord

  it('is read with the format it was written in, its body in the chunks it was sealed in', () => {
    const parsed = parseBackup(fixture.text)
    expect(parsed.sourceVersion).toBe(fixture.backupFormat)
    expect(parsed.appVersion).toBe(fixture.producedBy)
    expect(parsed.record.schemaVersion).toBe(fixture.schemaVersion)
    const { body, keys: header } = parsed.record as KeysRecord
    expect({ chunkSize: body.chunkSize, chunks: body.chunks.length }).toEqual({ chunkSize: keys.chunkSize, chunks: keys.chunks })
    expect(body.chunks.reduce((total, chunk) => total + chunk.ciphertext!.byteLength, 0)).toBe(body.length + 16 * body.chunks.length)
    expect({ epoch: header.epoch, roster: header.roster }).toEqual({ epoch: keys.epoch, roster: keys.roster })
    expect(Object.values(header.dekWraps).every((wrap) => wrap.epoch === keys.epoch)).toBe(true)
  })

  it('opens for every member with exact records, totals, keys, and an intact audit chain', async () => {
    await expectFixtureContents(record(), fixture)
    for (const user of fixture.expected.users) {
      const vault = await unlock(record(), user)
      expect(vault.keys).toMatchObject({ epoch: keys.epoch, roster: keys.roster })
      expect(formatFingerprint(vault.keys!.founder.fingerprint)).toBe(keys.founder.fingerprint)
      expect(vault.keys!.founder.memberId === vault.user.id).toBe(user.email === keys.founder.email)
    }
  })

  it('refuses a wrong password, and everyone who was removed', async () => {
    await expect(unlockVault(record(), admin.email, `${admin.password}!`)).rejects.toBeInstanceOf(AuthError)
    for (const removed of keys.removed) await expect(unlockVault(record(), removed.email, removed.password)).rejects.toBeInstanceOf(AuthError)
  })

  it('keeps its history, and adds only what opening it does', async () => {
    const vault = await unlock(record(), admin)
    const actions = listAudit(vault).map((entry) => entry.action).reverse()
    const added = fixture.expected.addedOnOpen ?? []
    expect(actions).toEqual([...fixture.expected.auditActions, ...added])
    expect(vault.needsSave).toBe(added.length > 0)
  })

  it('checks out its signed audit entries, and a save signs everything opening it added', async () => {
    const vault = await unlock(record(), admin)
    const check = async () => checkAuditSignatures({ ...(await auditCheckInput(vault.db, vault.keys!.vaultId, null))!, pendingAfter: vault.keys!.auditSigned })
    const signed = keys.audit?.signed ?? 0
    const added = fixture.expected.addedOnOpen?.length ?? 0
    const before = await check()
    expect([...before.problems]).toEqual([])
    // What opening it added is signed by the next save.
    expect({ signedFrom: before.signedFrom, verified: before.verified, pending: before.pending }).toEqual({ signedFrom: keys.audit?.signedFrom ?? null, verified: signed, pending: added })
    if (keys.audit) expect(vault.db.queryOne('SELECT seq, hash FROM audit_logs ORDER BY seq DESC LIMIT 1 OFFSET ?', [fixture.expected.addedOnOpen?.length ?? 0])).toEqual(keys.audit.head)
    await sealVault(vault)
    const after = await check()
    expect(after.pending).toBe(0)
    expect([...after.problems]).toEqual([])
    // A log from before signatures starts its signed part at the first entry this build wrote.
    expect({ signedFrom: after.signedFrom, verified: after.verified }).toEqual({ signedFrom: keys.audit?.signedFrom ?? fixture.expected.auditActions.length + 1, verified: signed + added })
  })

  it('survives a re-seal and a new backup with nothing lost', async () => {
    const resealed = (await sealVault(await unlock(record(), admin))) as KeysRecord
    expect({ version: resealed.version, schemaVersion: resealed.schemaVersion, epoch: resealed.keys.epoch }).toEqual({
      version: KEYS_RECORD_VERSION,
      schemaVersion: KEYS_SCHEMA_VERSION,
      epoch: keys.epoch,
    })
    // A body read in another chunk size is written again whole, in the writer's size.
    expect(resealed.body.chunkSize).toBe(CHUNK_BYTES)
    await expectFixtureContents(parseBackup(backupFileText(resealed)).record, fixture)
  })

  it.runIf(fixture.expected.safes !== undefined)('opens each private safe only for its owner, with exact contents', async () => {
    const safes = fixture.expected.safes!
    for (const owner of safes.owners) {
      const user = fixture.expected.users.find((item) => item.email === owner.email)!
      const vault = await unlock(record(), user)
      expect(getSafeStatus(vault)).toMatchObject({ initialized: true, stale: false, hasRecovery: owner.recoveryCode !== null })
      const { keyring } = await unlockSafes(vault, { kind: 'password', password: user.password })
      await expectSafes(vault, keyring, owner, user.password, safes.summaryDate)
      for (const other of fixture.expected.users.filter((item) => item.email !== owner.email)) {
        const someone = await unlock(record(), other)
        expect(getSafeStatus(someone).initialized).toBe(false)
      }
    }
  })

  it.runIf(fixture.expected.grants !== undefined)('ends expired codes on open and refuses used, revoked and expired ones', async () => {
    const grants = fixture.expected.grants!
    expect((record().grants ?? []).map((grant) => ({ kind: grant.kind, email: grant.email }))).toEqual(grants.pending.map((grant) => ({ kind: grant.kind, email: grant.email })))
    const vault = await unlock(record(), admin)
    expect(vault.grants).toEqual([])
    expect(listGrants(vault)).toEqual([])
    const reasons = new Map(vault.db.query('SELECT email, ended_reason FROM access_grants').map((row) => [String(row.email), String(row.ended_reason)]))
    for (const grant of grants.used) expect(reasons.get(grant.email)).toBe('USED')
    for (const grant of grants.revoked) expect(reasons.get(grant.email)).toBe('REVOKED')
    for (const grant of grants.pending) expect(reasons.get(grant.email)).toBe('EXPIRED')
    const password = 'A brand new passphrase for tests'
    for (const grant of [...grants.used, ...grants.revoked]) await expect(redeemGrant(record(), { ...grant, password })).rejects.toMatchObject({ code: 'INVITE_INVALID' })
    const [late] = grants.pending
    await expect(redeemGrant(record(), { ...late, password })).rejects.toMatchObject({ code: 'INVITE_EXPIRED' })
  })

  it.runIf(fixture.expected.signInCheck !== undefined)('opens the sign-in check from its owner\'s keys, and only theirs', async () => {
    const check = fixture.expected.signInCheck!
    const owner = fixture.expected.users.find((user) => user.email === check.email)!
    const vault = await unlock(record(), owner)
    expect(hasSignInCheck(vault.db, vault.user.id)).toBe(true)
    const challenge = (await openTotpChallenge(vault, owner.password))!
    const now = Date.now()
    const code = await totpAt(await importTotpKey(base32Decode(check.secret)), now)
    await expect(completeTotpChallenge(vault, challenge, '000000', now)).rejects.toMatchObject({ code: 'TOTP_INVALID' })
    await expect(completeTotpChallenge(vault, challenge, code, now)).resolves.toMatchObject({ usedRecovery: false })
    await expect(completeTotpChallenge(vault, challenge, check.recoveryCodes[3], now)).resolves.toEqual({ usedRecovery: true, recoveryLeft: 9 })
    for (const other of fixture.expected.users.filter((user) => user.email !== check.email)) {
      const someone = await unlock(record(), other)
      await expect(openTotpChallenge(someone, other.password)).resolves.toBeNull()
    }
  })
})
