import { createHash, randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { GENESIS_HASH, verifyAuditChain } from '../../src/db/audit-chain'
import { SqlDatabase } from '../../src/db/sqlite'
import { SCHEMA_VERSION } from '../../src/db/versions'
import { ForbiddenError } from '../../src/domain/errors'
import type { OpenVault } from '../../src/domain/types'
import { sha256Hex, sha256 } from '../../src/lib/sha256'
import { isNewerBuild } from '../../src/lib/updates'
import { auditIntegrity, listAudit } from '../../src/services/audit.service'
import { unlockVault } from '../../src/services/auth.service'
import { parseBackup } from '../../src/services/backup.service'
import { csvCell, exportPlainDatabase, exportTransactionsCsv } from '../../src/services/export.service'
import { fixtureByPath } from '../support/fixtures'

const fixture = fixtureByPath('v2/ledger-v2')
const open: { close: () => void }[] = []

afterEach(() => {
  for (const item of open.splice(0)) item.close()
})

async function openAs(role: 'Admin' | 'Viewer'): Promise<OpenVault> {
  const user = fixture.expected.users.find((item) => item.role === role)!
  const vault = await unlockVault(parseBackup(fixture.text).record, user.email, user.password)
  open.push(vault.db)
  return vault
}

describe('sha256', () => {
  it('matches node:crypto for every padding boundary', () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 4096]) {
      const data = new Uint8Array(randomBytes(length))
      expect(Buffer.from(sha256(data)).toString('hex'), String(length)).toBe(createHash('sha256').update(data).digest('hex'))
    }
    expect(sha256Hex('Oʻzbek — Ўзбек 🔐')).toBe(createHash('sha256').update('Oʻzbek — Ўзбек 🔐', 'utf8').digest('hex'))
  })
})

describe('audit hash chain', () => {
  it('detects edits, deletions, and reordering made outside the app', async () => {
    const vault = await openAs('Admin')
    const report = auditIntegrity(vault)
    expect(report).toMatchObject({ ok: true, brokenAt: null, entries: fixture.expected.auditActions.length + 1 })
    expect(listAudit(vault)[0].action).toBe('SCHEMA_MIGRATED')
    expect(report.head).not.toBe(GENESIS_HASH)

    const edited = await SqlDatabase.openBytes(vault.db.export())
    open.push(edited)
    edited.exec('DROP TRIGGER audit_logs_append_only_update')
    edited.exec("UPDATE audit_logs SET details = '{\"forged\":true}' WHERE seq = 3")
    expect(verifyAuditChain(edited)).toMatchObject({ ok: false, brokenAt: 3 })

    const truncated = await SqlDatabase.openBytes(vault.db.export())
    open.push(truncated)
    truncated.exec('DROP TRIGGER audit_logs_append_only_delete')
    truncated.exec('DELETE FROM audit_logs WHERE seq = 5')
    expect(verifyAuditChain(truncated)).toMatchObject({ ok: false, brokenAt: 6 })
  })

  it('keeps before and after values for edited records', async () => {
    const vault = await openAs('Admin')
    const update = listAudit(vault).find((entry) => entry.action === 'TRANSACTION_UPDATED')
    expect(update).toBeTruthy()
    const details = JSON.parse(String(vault.db.queryValue('SELECT details FROM audit_logs WHERE id = ?', [update!.id])))
    expect(details.before.amountMinor).toBe(1000)
    expect(details.after.amountMinor).toBe(1050)
  })
})

describe('plaintext archival export', () => {
  it('escapes CSV cells and neutralises spreadsheet formulas', () => {
    expect(csvCell(null)).toBe('')
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"')
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)")
    expect(csvCell('@cmd')).toBe("'@cmd")
    expect(csvCell('-2+3')).toBe("'-2+3")
    expect(csvCell(-5)).toBe('-5')
    expect(csvCell(true)).toBe('true')
  })

  it('writes every record as UTF-8 CSV with exact amounts', async () => {
    const vault = await openAs('Admin')
    const csv = exportTransactionsCsv(vault)
    expect(csv.startsWith('\ufeffid,date,type,category,amount,currency,amount_minor,minor_unit,')).toBe(true)
    const lines = csv.slice(1).trimEnd().split('\r\n')
    expect(lines).toHaveLength(fixture.expected.transactions.length + 1)
    const utilities = fixture.expected.transactions.find((tx) => tx.category === 'Utilities')!
    expect(lines.find((line) => line.startsWith(utilities.id))).toContain(',10.50,USD,1050,2,')
    expect(csv).toContain("'@SUM(1+1) csv trap")
    expect(csv).toContain('"Grouped digits\nsecond line"')
    expect(csv).toContain(',9999999999999.99,USD,999999999999999,2,')
    expect(listAudit(vault)[0].action).toBe('PLAINTEXT_EXPORTED')
  })

  it('writes a standard SQLite file without password material', async () => {
    const vault = await openAs('Admin')
    const bytes = await exportPlainDatabase(vault)
    expect(new TextDecoder().decode(bytes.slice(0, 15))).toBe('SQLite format 3')
    const copy = await SqlDatabase.openBytes(bytes)
    open.push(copy)
    expect(copy.queryValue("SELECT COUNT(*) FROM users WHERE password_hash <> '' OR salt <> ''")).toBe(0)
    expect(copy.queryValue('SELECT COUNT(*) FROM transactions')).toBe(fixture.expected.transactions.length)
    expect(copy.queryValue('PRAGMA user_version')).toBe(SCHEMA_VERSION)
    for (const table of ['user_keys', 'safes', 'secure_items', 'safe_events']) {
      expect(copy.queryValue(`SELECT COUNT(*) FROM ${table}`), table).toBe(0)
    }
    expect(verifyAuditChain(copy).ok).toBe(true)
    expect(Number(vault.db.queryValue("SELECT COUNT(*) FROM users WHERE password_hash <> ''"))).toBeGreaterThan(0)
  })

  it('is limited to people allowed to export the vault', async () => {
    const vault = await openAs('Viewer')
    expect(() => exportTransactionsCsv(vault)).toThrow(ForbiddenError)
    await expect(exportPlainDatabase(vault)).rejects.toBeInstanceOf(ForbiddenError)
  })
})

describe('update detection', () => {
  const current = { version: '1.1.0', commit: 'abc', builtAt: '' }
  it('flags a different deployed build only', () => {
    expect(isNewerBuild({ version: '1.1.0', commit: 'abc' }, current)).toBe(false)
    expect(isNewerBuild({ version: '1.1.0', commit: 'def' }, current)).toBe(true)
    expect(isNewerBuild({ version: '1.2.0', commit: 'abc' }, current)).toBe(true)
    expect(isNewerBuild(null, current)).toBe(false)
    expect(isNewerBuild({ version: 1 } as never, current)).toBe(false)
  })
})
