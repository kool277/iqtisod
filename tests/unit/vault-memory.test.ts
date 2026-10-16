import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { parseBackupText } from '../../src/db/envelope'
import { SqlDatabase, growthRoom, loadModule } from '../../src/db/sqlite'
import { createVault, sealVault, unlockVault } from '../../src/services/auth.service'
import { readVault, writeVault } from '../../src/db/storage'
import { capacityCheck, vaultChecks } from '../../src/health/evaluate'
import { computeCapacity, growthBudget, type CapacitySignals } from '../../src/lib/capacity'
import { formatBytes, restoreLimitBytes } from '../../src/lib/limits'
import { asLegacy, fixtureByPath } from '../support/fixtures'

const MIB = 1024 * 1024

async function sampleDatabase(rows: number, bytes: number): Promise<Uint8Array> {
  const db = await SqlDatabase.openEmpty()
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, data BLOB)')
  for (let index = 0; index < rows; index += 1) db.exec('INSERT INTO t (data) VALUES (randomblob(?))', [bytes])
  const exported = db.export()
  db.close()
  return exported
}

describe('SqlDatabase memory handling', () => {
  it('hands out the database where SQLite keeps it, and a wiped copy for one built in this session', async () => {
    const built = await SqlDatabase.openEmpty()
    built.exec('CREATE TABLE t (x TEXT)')
    built.exec("INSERT INTO t VALUES ('hello')")
    let fallback: Uint8Array | null = null
    const bytes = built.withImage((image) => {
      fallback = image
      return image.slice()
    })
    built.close()
    expect(bytes.length).toBeGreaterThan(0)
    expect(fallback!.every((byte) => byte === 0)).toBe(true)

    const opened = await SqlDatabase.openBytes(bytes)
    const { wasm } = await loadModule()
    const seen = opened.withImage((image) => ({ inHeap: image.buffer === wasm.heap8u().buffer, bytes: image.slice() }))
    expect(seen.inHeap).toBe(true)
    expect(Buffer.from(seen.bytes).equals(Buffer.from(opened.export()))).toBe(true)
    opened.close()
  })

  it('seals an opened vault without copying the plaintext out of SQLite', async () => {
    const credentials = { email: 'admin@example.com', password: 'correct-horse' }
    const created = await createVault({ ...credentials, displayName: 'Home', currency: 'USD' })
    created.vault.db.close()
    const vault = await unlockVault(created.record, credentials.email, credentials.password)
    const exportSpy = vi.spyOn(SqlDatabase.prototype, 'export')
    try {
      const sealed = await sealVault(vault)
      expect(exportSpy).not.toHaveBeenCalled()
      const reopened = await unlockVault(sealed, credentials.email, credentials.password)
      expect(reopened.vaultName).toBe('Home')
      reopened.db.close()
    } finally {
      exportSpy.mockRestore()
      vault.db.close()
    }
  })

  it('reserves an eighth of the database to grow into, between 1 and 64 MiB', () => {
    expect(growthRoom(0)).toBe(MIB)
    expect(growthRoom(16 * MIB)).toBe(2 * MIB)
    expect(growthRoom(800 * MIB)).toBe(64 * MIB)
  })

  it('opens from the caller’s bytes, which the caller may wipe at once, and exports them unchanged', async () => {
    const bytes = await sampleDatabase(4, 256 * 1024)
    const original = bytes.slice()
    const db = await SqlDatabase.openBytes(bytes)
    bytes.fill(0)
    expect(db.queryValue('SELECT COUNT(*) FROM t')).toBe(4)
    const exported = db.export()
    expect(exported.buffer).toBeInstanceOf(ArrayBuffer)
    expect(exported).toEqual(original)
    db.close()
  })

  it('keeps working when writes outgrow the room it was opened with', async () => {
    const db = await SqlDatabase.openBytes(await sampleDatabase(1, 1024))
    for (let index = 0; index < 6; index += 1) db.exec('INSERT INTO t (data) VALUES (randomblob(?))', [MIB])
    const exported = db.export()
    expect(exported.byteLength).toBe(db.sizeBytes())
    db.close()
    const again = await SqlDatabase.openBytes(exported)
    expect(again.queryValue('SELECT COUNT(*) FROM t')).toBe(7)
    expect(again.queryValue('PRAGMA quick_check')).toBe('ok')
    again.close()
  })

  it('refuses bytes that are not a database and closes the handle', async () => {
    const db = await SqlDatabase.openBytes(new Uint8Array(4096).fill(7))
    expect(() => db.queryValue('SELECT COUNT(*) FROM sqlite_master')).toThrow()
    db.close()
  })
})

describe('IndexedDB storage of a large vault', () => {
  it('stores and reads back a 1 MiB ciphertext without the decoded record copying it', async () => {
    const record = asLegacy(parseBackupText(fixtureByPath('v4/access-household').text).record)
    const ciphertext = new Uint8Array(MIB)
    for (let index = 0; index < ciphertext.length; index += 4096) ciphertext[index] = index % 251
    await writeVault({ ...record, body: { iv: record.body.iv, ciphertext: ciphertext.buffer } }, { expectedStamp: null })
    const loaded = await readVault()
    expect(loaded).not.toBeNull()
    const raw = loaded!.raw as { body: { ciphertext: ArrayBuffer } }
    expect(asLegacy(loaded!.record).body.ciphertext).toBe(raw.body.ciphertext)
    expect(new Uint8Array(asLegacy(loaded!.record).body.ciphertext)).toEqual(ciphertext)
  })
})

describe('health: largest vault on this device', () => {
  const MIBS = (value: number) => value * MIB
  const base: CapacitySignals = { quota: 100_000 * MIB, usage: 0, persisted: true, deviceMemoryGiB: 8, jsHeap: null, mobile: false, chromium: false }

  it('names the limit that decides and shows the budgets', () => {
    const check = capacityCheck(computeCapacity(base))
    expect(check).toMatchObject({ id: 'capacity', group: 'storage', status: 'pass', detail: 'memory' })
    expect(check.facts).toMatchObject({ deviceMemory: '8 GB' })
    expect(capacityCheck(computeCapacity({ ...base, chromium: true }))).toMatchObject({ status: 'pass', detail: 'browser', facts: { vaultLimit: '126 MB' } })
    expect(capacityCheck(computeCapacity({ ...base, deviceMemoryGiB: 64 })).facts).toMatchObject({ deviceMemory: '8 GB' })
    expect(capacityCheck(computeCapacity({ ...base, deviceMemoryGiB: null })).facts).toMatchObject({ deviceMemory: '~8 GB' })
  })

  it('warns, and offers persistent storage, when free storage is below an ordinary vault', () => {
    const roomy = capacityCheck(computeCapacity({ ...base, quota: MIBS(1000), usage: MIBS(500) }))
    expect(roomy).toMatchObject({ status: 'pass', detail: 'storage' })
    const cramped = capacityCheck(computeCapacity({ ...base, quota: MIBS(100), usage: MIBS(20), persisted: false }))
    expect(cramped).toMatchObject({ status: 'warn', detail: 'low', action: 'persist' })
    // No button where the browser cannot keep data at all: it could only say it was refused.
    expect(capacityCheck(computeCapacity({ ...base, quota: MIBS(100), usage: MIBS(20), persisted: false }), false)).not.toHaveProperty('action')
  })

  it('shows the same figures as the restore screens', () => {
    const capacity = computeCapacity(base)
    expect(capacity.fileBytes % MIB).not.toBe(0)
    const check = capacityCheck(capacity)
    expect(check.facts).toMatchObject({ vaultLimit: formatBytes(capacity.vaultBytes), backupLimit: formatBytes(restoreLimitBytes(capacity.fileBytes)) })
  })

  it('measures the vault size against the device budget', () => {
    const facts: Parameters<typeof vaultChecks>[0] = {
      schemaVersion: 1,
      bytes: MIBS(60),
      saveState: 'saved',
      lastBackupAt: null,
      hasRecords: false,
      canBackup: false,
      canReadAudit: false,
      canManageUsers: false,
      archives: null,
      chain: null,
      head: null,
      seen: null,
      recorded: null,
      clockFloor: null,
      clockMarks: null,
      totp: true,
      mustChange: false,
      weak: false,
      members: null,
      hygiene: null,
      keys: null,
      upgradeOffer: false,
    }
    const stored = { version: 2, schemaVersion: 1, appVersion: '1.7.0', updatedAt: null, audit: null }
    const size = (budget = growthBudget(null)) => vaultChecks(facts, stored, 0, budget).find((item) => item.id === 'size')
    expect(size()).toMatchObject({ status: 'fail', facts: { limit: '48.0 MB' } })
    expect(size(growthBudget(computeCapacity(base)))).toMatchObject({ status: 'pass' })
  })
})
