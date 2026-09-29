import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { derivePbkdf2Bits, verifierFromBits } from '../../src/crypto/crypto.service'
import { base64ToBytes } from '../../src/crypto/encoding'
import { DecryptError, PERSONAL_KEY_USAGES, aad, derivePersonalKek, unwrapWithAad } from '../../src/crypto/safe-crypto'
import type { VaultRecord } from '../../src/db/envelope'
import { AppError } from '../../src/domain/errors'
import { listAudit } from '../../src/services/audit.service'
import { sealVault } from '../../src/services/auth.service'
import { createItem, createSafe, initializeSafes, listItems, listSafes, unlockSafes } from '../../src/services/safe.service'
import {
  ADMIN,
  CARD,
  CARD_NUMBER,
  MANAGER,
  NOTE,
  NOTE_BODY,
  SAFE_NAME,
  SUBSCRIPTION,
  buildHousehold,
  closeTracked,
  contains,
  open,
  utf8,
} from '../support/safes'

let record: VaultRecord
let managerId = ''
let managerSafe = ''
let cardId = ''

beforeAll(async () => {
  const manager = await open(await buildHousehold(), MANAGER.email, MANAGER.password)
  managerId = manager.user.id
  const { keyring } = await initializeSafes(manager, MANAGER.password, { recovery: true, defaultSafeName: 'Personal' })
  managerSafe = await createSafe(manager, keyring, { name: SAFE_NAME, description: 'Grandmother’s rings', icon: 'heart', color: 'brass', requirePassword: false })
  cardId = await createItem(manager, keyring, managerSafe, CARD)
  await createItem(manager, keyring, managerSafe, SUBSCRIPTION)
  await createItem(manager, keyring, managerSafe, NOTE)
  record = await sealVault(manager)
  closeTracked()
})

afterEach(closeTracked)

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise
    return null
  } catch (error) {
    return error instanceof AppError ? error.code : error instanceof DecryptError ? 'DECRYPT' : String(error)
  }
}

describe('private safes are owner-only', () => {
  it('stores no plaintext secret anywhere in the decrypted database', async () => {
    const admin = await open(record, ADMIN.email, ADMIN.password)
    const bytes = admin.db.export()
    const needles = [
      CARD_NUMBER,
      '4111 1111 1111 1111',
      '737',
      'Aziza Karimova',
      'Kapitalbank',
      'Netflix',
      'netflix.com',
      'aziza@example.com',
      SAFE_NAME,
      'Grandmother',
      NOTE_BODY,
      'Deposit box',
      '"1111"',
      '•••• 1111',
      'VISA',
      'SUBSCRIPTION',
      '"kind"',
    ]
    for (const needle of needles) expect(contains(bytes, utf8(needle)), needle).toBe(false)
    expect(admin.db.queryValue('SELECT COUNT(*) FROM secure_items WHERE owner_user_id = ?', [managerId])).toBe(3)
  })

  it('does not let an Admin with the full database open the manager’s safes', async () => {
    const admin = await open(record, ADMIN.email, ADMIN.password)
    expect(await codeOf(unlockSafes(admin, { kind: 'password', password: ADMIN.password }))).toBe('SAFES_NOT_SET_UP')
    const { keyring } = await initializeSafes(admin, ADMIN.password, { recovery: false, defaultSafeName: 'Admin' })
    expect((await listSafes(admin, keyring)).map((safe) => safe.meta?.name)).toEqual(['Admin'])
    expect(await codeOf(listItems(admin, keyring, managerSafe))).toBe('SAFE_NOT_FOUND')

    const keys = admin.db.queryOne('SELECT * FROM user_keys WHERE user_id = ?', [managerId])!
    const wrap = { iv: String(keys.wrap_iv), ct: String(keys.wrapped_key) }
    const pkAad = aad('moliya.pk', managerId)
    const options = { extractable: false, usages: PERSONAL_KEY_USAGES }
    expect(await codeOf(unwrapWithAad(wrap, keyring.personalKey, pkAad, options))).toBe('DECRYPT')

    const hash = String(admin.db.queryValue('SELECT password_hash FROM users WHERE id = ?', [managerId]))
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    const hashBytes = new Uint8Array(Buffer.from(hash, 'hex'))
    const direct = await crypto.subtle.importKey('raw', hashBytes, 'AES-GCM', false, ['unwrapKey'])
    const hkdf = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8('moliya/personal-kek/v1') },
      await crypto.subtle.importKey('raw', hashBytes, 'HKDF', false, ['deriveKey']),
      { name: 'AES-GCM', length: 256 },
      false,
      ['unwrapKey'],
    )
    for (const guess of [direct, hkdf]) expect(await codeOf(unwrapWithAad(wrap, guess, pkAad, options))).toBe('DECRYPT')
    const withAdminPassword = await derivePersonalKek(ADMIN.password, base64ToBytes(String(keys.kdf_salt)), JSON.parse(String(keys.kdf)))
    expect(await codeOf(unwrapWithAad(wrap, withAdminPassword, pkAad, options))).toBe('DECRYPT')
  })

  it('stores a verifier that is not the vault key material', async () => {
    const manager = await open(record, MANAGER.email, MANAGER.password)
    const wrap = manager.wraps.find((item) => item.userId === managerId)!
    const raw = await derivePbkdf2Bits(MANAGER.password, wrap.salt, wrap.kdf)
    const hash = String(manager.db.queryValue('SELECT password_hash FROM users WHERE id = ?', [managerId]))
    expect(hash).toBe(await verifierFromBits(raw))
    expect(hash).not.toBe(Buffer.from(raw).toString('hex'))
  })

  it('refuses rows swapped into another user’s safe', async () => {
    const admin = await open(record, ADMIN.email, ADMIN.password)
    const { keyring } = await initializeSafes(admin, ADMIN.password, { recovery: false, defaultSafeName: 'Admin' })
    const adminSafe = keyring.meta.defaultSafeId
    admin.db.exec('UPDATE secure_items SET owner_user_id = ?, safe_id = ?, key_version = 1 WHERE id = ?', [admin.user.id, adminSafe, cardId])
    const result = await listItems(admin, keyring, adminSafe)
    expect(result.items).toEqual([])
    expect(result.unreadable).toEqual([cardId])

    const forgedSafe = admin.db.queryOne('SELECT * FROM safes WHERE id = ?', [managerSafe])!
    admin.db.exec('PRAGMA foreign_keys = OFF')
    admin.db.exec('UPDATE safes SET owner_user_id = ? WHERE id = ?', [admin.user.id, managerSafe])
    const listed = await listSafes(admin, keyring)
    expect(listed.find((safe) => safe.id === String(forgedSafe.id))?.meta).toBeNull()
  })

  it('keeps safe activity out of the shared audit log', async () => {
    const admin = await open(record, ADMIN.email, ADMIN.password)
    const audit = listAudit(admin)
    expect(audit.some((entry) => /SAFE|ITEM|RECOVERY|REWRAP/.test(entry.action))).toBe(false)
    const details = admin.db.query('SELECT details FROM audit_logs').map((row) => String(row.details ?? '')).join('\n')
    for (const needle of [SAFE_NAME, 'Netflix', CARD_NUMBER, managerSafe, cardId]) expect(details.includes(needle), needle).toBe(false)
  })
})
