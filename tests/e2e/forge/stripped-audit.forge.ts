import 'fake-indexeddb/auto'
import { writeFileSync } from 'node:fs'
import { it, vi } from 'vitest'
import type { KeysRecord } from '../../../src/db/envelope'
import { readVault, writeVault } from '../../../src/db/storage'
import { sealVault, unlockVault } from '../../../src/services/auth.service'
import { backupFileText } from '../../../src/services/backup.service'
import { createTransaction, listCategories } from '../../../src/services/finance.service'
import { createInvite, redeemGrant } from '../../../src/services/grant.service'
import { listGroups } from '../../../src/services/group.service'
import { commitSealed } from '../../../src/services/v2/session'
import { createKeysVault } from '../../../src/services/v2/vault'
import { memoryStorage } from '../../support/memory-storage'

// The smallest Argon2id the readers accept, so forging stays quick; the browser opens it all the same.
vi.mock('../../../src/crypto/kdf', async (load) => {
  const actual = await load<typeof import('../../../src/crypto/kdf')>()
  return { ...actual, ARGON2_DEFAULT: { name: 'Argon2id', m: 19_456, t: 2, p: 1, len: 32, v: 19 } }
})

/** Kept in step with tests/e2e/keys.spec.ts, which signs in with them. */
const FOUNDER = { email: 'founder@stripped.test', password: 'Founder stripped lantern 7' }
const VIEWER = { email: 'viewer@stripped.test', password: 'Viewer stripped lantern 7' }

async function stored(): Promise<KeysRecord> {
  return (await readVault())!.record as KeysRecord
}

/**
 * A household whose audit log a Viewer holding the vault key stripped of every signature with SQLite tools, written
 * as a backup to `FORGE_OUT`: what a browser that never saw the log must still report.
 */
it('forges a vault whose audit signatures were deleted', async () => {
  const out = process.env.FORGE_OUT
  if (!out) throw new Error('FORGE_OUT names the backup file to write')
  vi.stubGlobal('localStorage', memoryStorage())
  const created = await createKeysVault({ ...FOUNDER, displayName: 'Stripped Home', currency: 'USD' })
  await writeVault(created.record, { expectedStamp: null })
  commitSealed(created.vault, created.record)
  const [group] = listGroups(created.vault)
  const food = listCategories(created.vault).find((category) => category.nameEn === 'Food')!.id
  createTransaction(created.vault, { type: 'EXPENSE', amount: '4.20', currency: 'USD', categoryId: food, groupId: group.id, date: '2026-10-20', notes: '', receiptData: null })
  const invite = await createInvite(created.vault, { email: VIEWER.email, roleName: 'Viewer', groupId: group.id, validity: '24h' })
  let record = await sealVault(created.vault)
  await writeVault(record, { expectedStamp: created.record.updatedAt })
  created.vault.db.close()
  const viewer = await redeemGrant(await stored(), { kind: 'INVITE', email: VIEWER.email, code: invite.code, password: VIEWER.password })
  let stamp = record.updatedAt
  record = await sealVault(viewer)
  await writeVault(record, { expectedStamp: stamp })
  viewer.db.close()
  const founder = await unlockVault(await stored(), FOUNDER.email, FOUNDER.password)
  stamp = record.updatedAt
  record = await sealVault(founder)
  await writeVault(record, { expectedStamp: stamp })
  founder.db.close()

  const forger = await unlockVault(await stored(), VIEWER.email, VIEWER.password)
  forger.db.exec('DELETE FROM audit_sigs')
  const forged = await sealVault(forger, { full: true })
  forger.db.close()
  writeFileSync(out, backupFileText(forged))
})
