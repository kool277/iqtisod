import { afterEach, describe, expect, it } from 'vitest'
import { auditHash, auditHead, compareAuditHead, GENESIS_HASH, verifyAuditChain, type AuditHead } from '../../src/db/audit-chain'
import { encodeStoredRecord, decodeStoredRecord, parseBackupJson, toBackupJson } from '../../src/db/envelope'
import { SqlDatabase } from '../../src/db/sqlite'
import { ForbiddenError } from '../../src/domain/errors'
import { advanceAuditMark, AUDIT_MARK_KEY, readAuditMark, resetAuditMark } from '../../src/lib/audit-mark'
import { acknowledgeAuditWarning, checkAuditLog, writeAudit } from '../../src/services/audit.service'
import { sealVault, unlockVault } from '../../src/services/auth.service'
import { parseBackup } from '../../src/services/backup.service'
import { buildAccessHousehold, lastAudit, MEMBER, OWNER, openAs } from '../support/access'
import { readFixture, readManifest } from '../support/fixtures'

const open: { close: () => void }[] = []

afterEach(() => {
  for (const item of open.splice(0)) item.close()
})

async function copyOf(db: SqlDatabase): Promise<SqlDatabase> {
  const copy = await SqlDatabase.openBytes(db.export())
  open.push(copy)
  return copy
}

/** What someone holding the vault key can do with other tools: drop the last entries; the chain still verifies. */
function cutTail(db: SqlDatabase, keep: number): void {
  db.exec('DROP TRIGGER audit_logs_append_only_delete')
  db.exec('DELETE FROM audit_logs WHERE seq > ?', [keep])
}

/** Rewrite one entry and recompute every hash after it, so the chain still verifies. */
function rewriteFrom(db: SqlDatabase, seq: number): void {
  db.exec('DROP TRIGGER audit_logs_append_only_update')
  db.exec("UPDATE audit_logs SET details = '{\"forged\":true}' WHERE seq = ?", [seq])
  const rows = db.query('SELECT * FROM audit_logs WHERE seq >= ? ORDER BY seq', [seq])
  let prevHash = String(db.queryValue('SELECT hash FROM audit_logs WHERE seq = ?', [seq - 1]) ?? GENESIS_HASH)
  for (const row of rows) {
    const hash = auditHash({
      seq: Number(row.seq),
      id: String(row.id),
      actorId: row.actor_id == null ? null : String(row.actor_id),
      action: String(row.action),
      entityType: row.entity_type == null ? null : String(row.entity_type),
      entityId: row.entity_id == null ? null : String(row.entity_id),
      details: row.details == null ? null : String(row.details),
      createdAt: String(row.created_at),
      prevHash,
    })
    db.exec('UPDATE audit_logs SET prev_hash = ?, hash = ? WHERE seq = ?', [prevHash, hash, row.seq])
    prevHash = hash
  }
}

function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  }
}

describe('audit head', () => {
  it('is sealed into the record and survives storage and backup round trips', async () => {
    const { record } = await buildAccessHousehold()
    const vault = await openAs(record, OWNER)
    open.push(vault.db)
    expect(record.audit).toEqual(auditHead(vault.db))
    expect(record.audit!.seq).toBeGreaterThan(0)

    expect(decodeStoredRecord(encodeStoredRecord(record)).record.audit).toEqual(record.audit)
    const backup = JSON.parse(JSON.stringify(toBackupJson(record, new Date().toISOString())))
    expect(backup.audit).toEqual(record.audit)
    expect(parseBackupJson(backup).record.audit).toEqual(record.audit)
  })

  it('drops a malformed head instead of refusing the file', async () => {
    const { record } = await buildAccessHousehold()
    for (const audit of [{ seq: -1, hash: GENESIS_HASH }, { seq: 1, hash: 'nope' }, 'head', null]) {
      const backup = { ...JSON.parse(JSON.stringify(toBackupJson(record, new Date().toISOString()))), audit }
      const parsed = parseBackupJson(backup).record
      expect(parsed.audit).toBeUndefined()
      const vault = await unlockVault(parsed, OWNER.email, OWNER.password)
      open.push(vault.db)
    }
  })

  it('accepts a log that only grew', async () => {
    const vault = await openAs((await buildAccessHousehold()).record, OWNER)
    open.push(vault.db)
    const seen = auditHead(vault.db)
    writeAudit(vault.db, vault.user.id, 'SETTINGS_UPDATED', 'vault', 'primary', {})
    expect(compareAuditHead(vault.db, seen)).toBeNull()
    expect(compareAuditHead(vault.db, { seq: 0, hash: GENESIS_HASH })).toBeNull()
    expect(checkAuditLog(vault.db, { device: seen, record: auditHead(vault.db) }, true)).toBeNull()
  })

  it('catches entries cut off the end even though the chain still verifies', async () => {
    const vault = await openAs((await buildAccessHousehold()).record, OWNER)
    open.push(vault.db)
    const seen = auditHead(vault.db)
    const cut = await copyOf(vault.db)
    cutTail(cut, seen.seq - 2)
    expect(verifyAuditChain(cut).ok).toBe(true)
    expect(compareAuditHead(cut, seen)).toBe('SHORTER')
    expect(checkAuditLog(cut, { device: seen }, true)).toEqual({ kind: 'SHORTER', source: 'device', expected: seen, actual: auditHead(cut) })
  })

  it('catches a rewritten history with recomputed hashes', async () => {
    const vault = await openAs((await buildAccessHousehold()).record, OWNER)
    open.push(vault.db)
    const seen = auditHead(vault.db)
    const forged = await copyOf(vault.db)
    rewriteFrom(forged, 2)
    expect(verifyAuditChain(forged).ok).toBe(true)
    expect(compareAuditHead(forged, seen)).toBe('CHANGED')
    expect(checkAuditLog(forged, { device: null, record: seen }, true)).toMatchObject({ kind: 'CHANGED', source: 'record' })
  })

  it('reports a broken chain first, and only to people who check it', async () => {
    const vault = await openAs((await buildAccessHousehold()).record, OWNER)
    open.push(vault.db)
    const edited = await copyOf(vault.db)
    edited.exec('DROP TRIGGER audit_logs_append_only_update')
    edited.exec("UPDATE audit_logs SET details = '{}' WHERE seq = 2")
    expect(checkAuditLog(edited, { device: auditHead(vault.db) }, true)).toEqual({ kind: 'BROKEN', brokenAt: 2 })
    // The marks only cover the head; an edit in the middle is the chain check's job.
    expect(checkAuditLog(edited, { device: auditHead(vault.db) }, false)).toBeNull()
  })

  it('lets only audit readers accept the log, and records it', async () => {
    const { record } = await buildAccessHousehold()
    const owner = await openAs(record, OWNER)
    const member = await openAs(record, MEMBER)
    open.push(owner.db, member.db)
    const warning = { kind: 'SHORTER' as const, source: 'device' as const, expected: { seq: 99, hash: GENESIS_HASH }, actual: auditHead(owner.db) }
    expect(() => acknowledgeAuditWarning(member, warning)).toThrow(ForbiddenError)
    acknowledgeAuditWarning(owner, warning)
    expect(lastAudit(owner.db, 'AUDIT_MARK_RESET')?.details).toEqual(warning)
    expect((await sealVault(owner)).audit).toEqual(auditHead(owner.db))
  })

  it('leaves every released backup openable; none carries a head', async () => {
    for (const entry of readManifest()) {
      const fixture = readFixture(entry)
      const { record } = parseBackup(fixture.text)
      expect(record.audit, entry.path).toBeUndefined()
      const admin = fixture.expected.users.find((user) => user.role === 'Admin')!
      const vault = await unlockVault(record, admin.email, admin.password)
      open.push(vault.db)
      expect(checkAuditLog(vault.db, { device: null, record: record.audit }, true), entry.path).toBeNull()
    }
  })
})

describe('audit mark in this browser', () => {
  const head = (seq: number): AuditHead => ({ seq, hash: seq.toString(16).padStart(64, '0') })

  it('only moves forward until it is reset', () => {
    const storage = memoryStorage()
    expect(readAuditMark(storage)).toBeNull()
    advanceAuditMark(head(5), storage)
    advanceAuditMark(head(3), storage)
    expect(readAuditMark(storage)).toEqual(head(5))
    advanceAuditMark(head(8), storage)
    expect(readAuditMark(storage)).toEqual(head(8))
    resetAuditMark(head(2), storage)
    expect(readAuditMark(storage)).toEqual(head(2))
    resetAuditMark(null, storage)
    expect(storage.getItem(AUDIT_MARK_KEY)).toBeNull()
  })

  it('ignores junk and works without storage', () => {
    const storage = memoryStorage()
    for (const junk of ['{', '"x"', '{"seq":1}', '{"seq":1.5,"hash":"' + '0'.repeat(64) + '"}']) {
      storage.setItem(AUDIT_MARK_KEY, junk)
      expect(readAuditMark(storage)).toBeNull()
    }
    expect(readAuditMark(null)).toBeNull()
    expect(() => advanceAuditMark(head(1), null)).not.toThrow()
    const failing = { ...storage, setItem: () => { throw new Error('quota') } }
    expect(() => resetAuditMark(head(1), failing)).not.toThrow()
  })
})
