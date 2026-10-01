import { createHash, randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { GENESIS_HASH, verifyAuditChain } from '../../src/db/audit-chain'
import { SqlDatabase } from '../../src/db/sqlite'
import type { OpenVault } from '../../src/domain/types'
import { sha256Hex, sha256 } from '../../src/lib/sha256'
import { isNewerBuild } from '../../src/lib/updates'
import { auditIntegrity, listAudit } from '../../src/services/audit-log'
import { unlockVault } from '../../src/services/auth.service'
import { parseBackup } from '../../src/services/backup.service'
import { fixtureByPath } from '../support/fixtures'

const fixture = fixtureByPath('v2/ledger-v2')
const open: { close: () => void }[] = []

afterEach(() => {
  for (const item of open.splice(0)) item.close()
})

async function openAs(role: 'Admin'): Promise<OpenVault> {
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
