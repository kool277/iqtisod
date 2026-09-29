import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { deriveKey, unwrapDek } from '../../src/crypto/crypto.service'
import type { VaultRecord } from '../../src/db/envelope'
import { wrapsFromRecord } from '../../src/db/storage'
import type { CardItem } from '../../src/domain/safes'
import { sealVault, unlockVault } from '../../src/services/auth.service'
import { backupFileText, parseBackup } from '../../src/services/backup.service'
import { createItem, initializeSafes, listItems, unlockSafes } from '../../src/services/safe.service'
import { deleteUser } from '../../src/services/user.service'
import { fixtureByPath } from '../support/fixtures'
import { ADMIN, CARD, CARD_NUMBER, MANAGER, NOTE, buildHousehold, closeTracked, contains, open, track, utf8 } from '../support/safes'

let record: VaultRecord
let managerId = ''
let safeId = ''
let cardCiphertext = ''

beforeAll(async () => {
  const manager = await open(await buildHousehold(), MANAGER.email, MANAGER.password)
  managerId = manager.user.id
  const { keyring } = await initializeSafes(manager, MANAGER.password, { recovery: true, defaultSafeName: 'Personal' })
  safeId = keyring.meta.defaultSafeId
  const cardId = await createItem(manager, keyring, safeId, CARD)
  await createItem(manager, keyring, safeId, NOTE)
  cardCiphertext = String(manager.db.queryValue('SELECT ciphertext FROM secure_items WHERE id = ?', [cardId]))
  record = await sealVault(manager)
  closeTracked()
})

afterEach(closeTracked)

const SAFE_TABLES = [
  ['user_keys', 'user_id'],
  ['safes', 'owner_user_id'],
  ['secure_items', 'owner_user_id'],
  ['safe_events', 'owner_user_id'],
] as const

describe('private safes lifecycle', () => {
  it('shreds every safe row when the owner is deleted', async () => {
    const admin = await open(record, ADMIN.email, ADMIN.password)
    for (const [table, column] of SAFE_TABLES) {
      expect(Number(admin.db.queryValue(`SELECT COUNT(*) FROM ${table} WHERE ${column} = ?`, [managerId])), table).toBeGreaterThan(0)
    }
    expect(contains(admin.db.export(), utf8(cardCiphertext.slice(0, 64)))).toBe(true)
    deleteUser(admin, managerId)
    for (const [table] of SAFE_TABLES) expect(admin.db.queryValue(`SELECT COUNT(*) FROM ${table}`), table).toBe(0)
    expect(admin.db.queryValue('PRAGMA secure_delete')).toBe(1)
    expect(contains(admin.db.export(), utf8(cardCiphertext.slice(0, 64)))).toBe(false)
    const audit = admin.db.queryOne("SELECT details FROM audit_logs WHERE action = 'USER_DELETED'")!
    expect(JSON.parse(String(audit.details))).toEqual({ email: MANAGER.email })
    expect(admin.db.queryValue('PRAGMA foreign_key_check')).toBeUndefined()
  })

  it('keeps safes intact through a backup file round trip', async () => {
    const restored = parseBackup(backupFileText(record)).record
    const manager = await open(restored, MANAGER.email, MANAGER.password)
    const { keyring } = await unlockSafes(manager, { kind: 'password', password: MANAGER.password })
    const { items, unreadable } = await listItems(manager, keyring, safeId)
    expect(unreadable).toEqual([])
    expect(items.map((item) => item.kind)).toEqual(['CARD', 'NOTE'])
    expect((items[0] as CardItem).number).toBe(CARD_NUMBER)
  })

  it.each(['v1/household-usd', 'v2/ledger-v2'])('upgrades the %s fixture and lets every user set up safes', async (path) => {
    const fixture = fixtureByPath(path)
    const source = parseBackup(fixture.text).record
    for (const user of fixture.expected.users) {
      const legacy = wrapsFromRecord(source).find((wrap) => wrap.email === user.email)!
      const legacyKek = await deriveKey(user.password, legacy.salt, legacy.kdf)
      const vault = track(await unlockVault(source, user.email, user.password))
      expect(vault.user.mustChangePassword).toBe(false)
      expect(String(vault.db.queryValue('SELECT password_hash FROM users WHERE id = ?', [vault.user.id]))).toMatch(/^[0-9a-f]{64}$/)
      const current = vault.wraps.find((wrap) => wrap.userId === vault.user.id)!
      expect(Buffer.from(current.salt).equals(Buffer.from(legacy.salt)), 'the vault key is re-wrapped under a fresh salt').toBe(false)
      await expect(unwrapDek(current.wrappedDek, legacyKek, current.iv)).rejects.toThrow()
      const { keyring } = await initializeSafes(vault, user.password, { recovery: user.role === 'Admin', defaultSafeName: 'Personal' })
      await createItem(vault, keyring, keyring.meta.defaultSafeId, NOTE)
      expect(vault.db.queryValue('PRAGMA foreign_key_check')).toBeUndefined()
      const reopened = track(await unlockVault(await sealVault(vault), user.email, user.password))
      const again = await unlockSafes(reopened, { kind: 'password', password: user.password })
      expect((await listItems(reopened, again.keyring, again.keyring.meta.defaultSafeId)).items).toHaveLength(1)
    }
  })
})

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

describe('no secret logging', () => {
  it('has no console calls in safe services, crypto, domain, or components', () => {
    const root = resolve(__dirname, '../../src')
    const files = [
      ...sourceFiles(join(root, 'services')).filter((file) => /safe|account/.test(file)),
      ...sourceFiles(join(root, 'crypto')),
      ...['safes.ts', 'cards.ts', 'subscriptions.ts', 'items.ts'].map((name) => join(root, 'domain', name)),
      ...sourceFiles(join(root, 'components', 'safes')),
      ...sourceFiles(join(root, 'context')),
      join(root, 'components', 'AccountPage.tsx'),
    ]
    expect(files.length).toBeGreaterThan(8)
    for (const file of files) expect(readFileSync(file, 'utf8'), file).not.toMatch(/\bconsole\.|\bdebugger\b/)
  })
})
