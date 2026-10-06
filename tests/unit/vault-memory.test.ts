import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { parseBackupText } from '../../src/db/envelope'
import { SqlDatabase, growthRoom } from '../../src/db/sqlite'
import { readVault, writeVault } from '../../src/db/storage'
import { capacityCheck, vaultChecks } from '../../src/health/evaluate'
import { computeCapacity, growthBudget, type CapacitySignals } from '../../src/lib/capacity'
import { fixtureByPath } from '../support/fixtures'

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
    const { record } = parseBackupText(fixtureByPath('v4/access-household').text)
    const ciphertext = new Uint8Array(MIB)
    for (let index = 0; index < ciphertext.length; index += 4096) ciphertext[index] = index % 251
    await writeVault({ ...record, body: { iv: record.body.iv, ciphertext: ciphertext.buffer } }, { expectedStamp: null })
    const loaded = await readVault()
    expect(loaded).not.toBeNull()
    const raw = loaded!.raw as { body: { ciphertext: ArrayBuffer } }
    expect(loaded!.record.body.ciphertext).toBe(raw.body.ciphertext)
    expect(new Uint8Array(loaded!.record.body.ciphertext)).toEqual(ciphertext)
  })
})

describe('health: largest vault on this device', () => {
  const MIBS = (value: number) => value * MIB
  const base: CapacitySignals = { quota: 100_000 * MIB, usage: 0, persisted: true, deviceMemoryGiB: 8, jsHeap: null, mobile: false }

  it('names the limit that decides and shows the budgets', () => {
    const check = capacityCheck(computeCapacity(base))
    expect(check).toMatchObject({ id: 'capacity', group: 'storage', status: 'pass', detail: 'memory' })
    expect(check.facts).toMatchObject({ deviceMemory: '8 GB' })
    expect(capacityCheck(computeCapacity({ ...base, deviceMemoryGiB: 64 })).detail).toBe('engine')
    expect(capacityCheck(computeCapacity({ ...base, deviceMemoryGiB: null })).facts).toMatchObject({ deviceMemory: '~8 GB' })
  })

  it('warns, and offers persistent storage, when free storage is below an ordinary vault', () => {
    const roomy = capacityCheck(computeCapacity({ ...base, quota: MIBS(1000), usage: MIBS(500) }))
    expect(roomy).toMatchObject({ status: 'pass', detail: 'storage' })
    const cramped = capacityCheck(computeCapacity({ ...base, quota: MIBS(100), usage: MIBS(20), persisted: false }))
    expect(cramped).toMatchObject({ status: 'warn', detail: 'low', action: 'persist' })
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
    }
    const stored = { version: 2, schemaVersion: 1, appVersion: '1.7.0', updatedAt: null, audit: null }
    const size = (budget = growthBudget(null)) => vaultChecks(facts, stored, 0, budget).find((item) => item.id === 'size')
    expect(size()).toMatchObject({ status: 'fail', facts: { limit: '48.0 MB' } })
    expect(size(growthBudget(computeCapacity(base)))).toMatchObject({ status: 'pass' })
  })
})
