import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { aad, openJson, DecryptError } from '../../src/crypto/safe-crypto'
import type { VaultRecord } from '../../src/db/envelope'
import { AppError } from '../../src/domain/errors'
import type { CardItem, NoteItem } from '../../src/domain/safes'
import { subscriptionSummary } from '../../src/domain/subscriptions'
import type { OpenVault } from '../../src/domain/types'
import { sealVault } from '../../src/services/auth.service'
import {
  confirmRecentAuth,
  copyItems,
  createItem,
  createSafe,
  getItem,
  getSafeStatus,
  initializeSafes,
  listItems,
  listOpenItems,
  listSafeEvents,
  listSafes,
  listTrash,
  moveItems,
  openSafe,
  purgeExpiredTrash,
  purgeItems,
  purgeSafe,
  reorderSafes,
  restoreItems,
  restoreSafe,
  rotateSafeKey,
  setDefaultSafe,
  setFavorite,
  trashItems,
  trashSafe,
  unlockSafes,
  updateItem,
  updateSafe,
  updateSafePrefs,
  type SafeKeyring,
} from '../../src/services/safe.service'
import { CARD, CARD_NUMBER, MANAGER, NOTE, SUBSCRIPTION, buildHousehold, closeTracked, open } from '../support/safes'

let household: VaultRecord

beforeAll(async () => {
  household = await buildHousehold()
})

afterEach(closeTracked)

async function managerWithSafes(): Promise<{ vault: OpenVault; keyring: SafeKeyring; safeId: string }> {
  const vault = await open(household, MANAGER.email, MANAGER.password)
  const { keyring } = await initializeSafes(vault, MANAGER.password, { recovery: false, defaultSafeName: 'Personal' })
  return { vault, keyring, safeId: keyring.meta.defaultSafeId }
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise
    return null
  } catch (error) {
    return error instanceof AppError ? error.code : String(error)
  }
}

function expire(keyring: SafeKeyring) {
  keyring.lastAuthAt = Date.now() - 10 * 60_000
}

describe('private safes service', () => {
  it('stores small items of every kind with the same ciphertext length', async () => {
    const { vault, keyring, safeId } = await managerWithSafes()
    const cardId = await createItem(vault, keyring, safeId, CARD)
    await createItem(vault, keyring, safeId, { ...SUBSCRIPTION, cardItemId: cardId })
    await createItem(vault, keyring, safeId, NOTE)
    const lengths = vault.db.query('SELECT length(ciphertext) AS size FROM secure_items').map((row) => Number(row.size))
    expect(lengths).toHaveLength(3)
    expect(new Set(lengths).size).toBe(1)
  })

  it('sets up, stores every kind of item, and reads it back after seal and unlock', async () => {
    const { vault, keyring, safeId } = await managerWithSafes()
    expect(getSafeStatus(vault)).toEqual({ initialized: true, mustChangePassword: false, stale: false, hasRecovery: false })
    expect(await codeOf(initializeSafes(vault, MANAGER.password, { recovery: false, defaultSafeName: 'x' }))).toBe('SAFES_ALREADY_SET_UP')

    const cardId = await createItem(vault, keyring, safeId, CARD)
    const subId = await createItem(vault, keyring, safeId, { ...SUBSCRIPTION, cardItemId: cardId })
    const noteId = await createItem(vault, keyring, safeId, NOTE)

    const restored = await open(await sealVault(vault), MANAGER.email, MANAGER.password)
    const { keyring: again, previousUnlockAt } = await unlockSafes(restored, { kind: 'password', password: MANAGER.password })
    expect(previousUnlockAt).toBeNull()
    const { items, unreadable } = await listItems(restored, again, safeId)
    expect(unreadable).toEqual([])
    expect(items.map((item) => item.id)).toEqual([cardId, subId, noteId])
    const card = items[0] as CardItem
    expect(card).toMatchObject({ kind: 'CARD', number: CARD_NUMBER, cvv: '737', brand: 'VISA', cardholder: 'Aziza Karimova', rev: 1 })
    expect(items[1]).toMatchObject({ kind: 'SUBSCRIPTION', cardItemId: cardId, amountMinor: 999 })
    expect((items[2] as NoteItem).body).toBe(NOTE.kind === 'NOTE' ? NOTE.body : '')

    const second = await unlockSafes(restored, { kind: 'password', password: MANAGER.password })
    expect(second.previousUnlockAt).toMatch(/^\d{4}-/)
    const events = await listSafeEvents(restored, second.keyring)
    expect(events.map((event) => event.type).slice(0, 2)).toEqual(['SAFES_UNLOCKED', 'SAFES_UNLOCKED'])
    expect(events.map((event) => event.type)).toContain('SAFES_INITIALIZED')
    expect(await codeOf(unlockSafes(restored, { kind: 'password', password: 'wrong-password' }))).toBe('BAD_CREDENTIALS')
  })

  it('validates input and enforces revisions', async () => {
    const { vault, keyring, safeId } = await managerWithSafes()
    expect(await codeOf(createItem(vault, keyring, safeId, { ...CARD, number: '4111111111111112' }))).toBe('CARD_NUMBER')
    expect(await codeOf(createItem(vault, keyring, safeId, { ...NOTE, title: '   ' }))).toBe('REQUIRED')
    expect(await codeOf(createSafe(vault, keyring, { name: 'x'.repeat(61), description: '', icon: 'vault', color: 'pine', requirePassword: false }))).toBe('TOO_LONG')
    const id = await createItem(vault, keyring, safeId, NOTE)
    await updateItem(vault, keyring, id, 1, { ...NOTE, title: 'Renamed' })
    expect(await codeOf(updateItem(vault, keyring, id, 1, { ...NOTE, title: 'Stale edit' }))).toBe('ITEM_CONFLICT')
    expect(await codeOf(updateItem(vault, keyring, id, 2, CARD))).toBe('REQUIRED')
    await setFavorite(vault, keyring, id, 2, true)
    expect(await getItem(vault, keyring, id)).toMatchObject({ title: 'Renamed', favorite: true, rev: 3 })
    expect(await codeOf(getItem(vault, keyring, 'missing'))).toBe('ITEM_NOT_FOUND')
  })

  it('orders safes, changes the default, archives, and keeps preferences encrypted', async () => {
    const { vault, keyring, safeId } = await managerWithSafes()
    const travel = await createSafe(vault, keyring, { name: 'Travel', description: 'Trips', icon: 'plane', color: 'brass', requirePassword: false })
    await reorderSafes(vault, keyring, [travel, safeId])
    await setDefaultSafe(vault, keyring, travel)
    await updateSafePrefs(vault, keyring, { autoLockMinutes: 15, clipboardSeconds: 60, revealSeconds: 99 as never })
    await updateSafe(vault, keyring, travel, { archived: true })
    expect(await codeOf(createItem(vault, keyring, travel, NOTE))).toBe('SAFE_ARCHIVED')

    const restored = await open(await sealVault(vault), MANAGER.email, MANAGER.password)
    const { keyring: again } = await unlockSafes(restored, { kind: 'password', password: MANAGER.password })
    expect(again.meta).toMatchObject({ order: [travel, safeId], defaultSafeId: travel, autoLockMinutes: 15, clipboardSeconds: 60, revealSeconds: 15 })
    const safes = await listSafes(restored, again)
    expect(safes.map((safe) => [safe.meta?.name, safe.meta?.archived, safe.isDefault])).toEqual([
      ['Travel', true, true],
      ['Personal', false, false],
    ])
  })

  it('handles trash: non-empty and last safes, restore, typed-name purge, and 30-day expiry', async () => {
    const { vault, keyring, safeId } = await managerWithSafes()
    expect(await codeOf(trashSafe(vault, keyring, safeId, { withContents: true }))).toBe('LAST_SAFE')
    const box = await createSafe(vault, keyring, { name: 'Box', description: '', icon: 'shield', color: 'clay', requirePassword: false })
    const inBox = await createItem(vault, keyring, box, NOTE)
    expect(await codeOf(trashSafe(vault, keyring, box, { withContents: false }))).toBe('SAFE_NOT_EMPTY')
    await trashSafe(vault, keyring, box, { withContents: false, moveItemsTo: safeId })
    expect((await getItem(vault, keyring, inBox)).safeId).toBe(safeId)
    expect((await listSafes(vault, keyring)).map((safe) => safe.id)).toEqual([safeId])
    await restoreSafe(vault, keyring, box)
    await trashSafe(vault, keyring, box, { withContents: true })

    expect((await listTrash(vault, keyring)).safes.map((safe) => [safe.id, safe.daysLeft])).toEqual([[box, 30]])
    expire(keyring)
    expect(await codeOf(purgeSafe(vault, keyring, box, 'Box'))).toBe('REAUTH_REQUIRED')
    await confirmRecentAuth(vault, keyring, MANAGER.password)
    expect(await codeOf(purgeSafe(vault, keyring, box, 'box'))).toBe('CONFIRM_NAME')
    await purgeSafe(vault, keyring, box, ' Box ')
    expect(vault.db.queryValue('SELECT COUNT(*) FROM safes WHERE id = ?', [box])).toBe(0)

    const doomed = await createItem(vault, keyring, safeId, NOTE)
    await trashItems(vault, keyring, [doomed])
    expect((await listTrash(vault, keyring)).items.map((item) => item.id)).toEqual([doomed])
    await restoreItems(vault, keyring, [doomed])
    await trashItems(vault, keyring, [doomed])
    expire(keyring)
    expect(await codeOf(purgeItems(vault, keyring, [doomed]))).toBe('REAUTH_REQUIRED')
    expect(purgeExpiredTrash(vault, keyring, new Date(Date.now() + 29 * 86_400_000))).toBe(0)
    expect(purgeExpiredTrash(vault, keyring, new Date(Date.now() + 31 * 86_400_000))).toBe(1)
    expect(vault.db.queryValue('SELECT COUNT(*) FROM secure_items WHERE id = ?', [doomed])).toBe(0)
  })

  it('re-encrypts items when moving or copying them to another safe', async () => {
    const { vault, keyring, safeId } = await managerWithSafes()
    const other = await createSafe(vault, keyring, { name: 'Other', description: '', icon: 'wallet', color: 'slate', requirePassword: false })
    const cardId = await createItem(vault, keyring, safeId, CARD)
    const before = vault.db.queryOne('SELECT iv, ciphertext FROM secure_items WHERE id = ?', [cardId])!
    await moveItems(vault, keyring, [cardId], other)
    const after = vault.db.queryOne('SELECT safe_id, iv, ciphertext, rev FROM secure_items WHERE id = ?', [cardId])!
    expect(after.safe_id).toBe(other)
    expect(after.ciphertext).not.toBe(before.ciphertext)
    expect(after.rev).toBe(2)
    const otherKey = keyring.safeKeys.get(other)!.key
    const sealed = { iv: String(after.iv), ct: String(after.ciphertext) }
    await expect(openJson(sealed, otherKey, aad('moliya.item', keyring.userId, other, cardId, 1))).resolves.toMatchObject({ number: CARD_NUMBER })
    await expect(openJson(sealed, otherKey, aad('moliya.item', keyring.userId, safeId, cardId, 1))).rejects.toBeInstanceOf(DecryptError)

    const [copyId] = await copyItems(vault, keyring, [cardId], safeId)
    expect(copyId).not.toBe(cardId)
    expect(await getItem(vault, keyring, copyId)).toMatchObject({ safeId, number: CARD_NUMBER, rev: 1 })
    expect(await getItem(vault, keyring, cardId)).toMatchObject({ safeId: other })
  })

  it('rotates a safe key so every item, trashed ones too, uses the new key', async () => {
    const { vault, keyring, safeId } = await managerWithSafes()
    const live = await createItem(vault, keyring, safeId, CARD)
    const trashed = await createItem(vault, keyring, safeId, NOTE)
    await trashItems(vault, keyring, [trashed])
    const oldKey = keyring.safeKeys.get(safeId)!.key
    expire(keyring)
    expect(await codeOf(rotateSafeKey(vault, keyring, safeId))).toBe('REAUTH_REQUIRED')
    await confirmRecentAuth(vault, keyring, MANAGER.password)
    await rotateSafeKey(vault, keyring, safeId)
    expect(vault.db.queryValue('SELECT key_version FROM safes WHERE id = ?', [safeId])).toBe(2)
    expect(vault.db.queryValue("SELECT COUNT(*) FROM secure_items WHERE key_version <> 2")).toBe(0)
    const { items } = await listItems(vault, keyring, safeId, { includeTrashed: true })
    expect(items.map((item) => item.id).sort()).toEqual([live, trashed].sort())
    const row = vault.db.queryOne('SELECT iv, ciphertext FROM secure_items WHERE id = ?', [live])!
    const sealed = { iv: String(row.iv), ct: String(row.ciphertext) }
    await expect(openJson(sealed, oldKey, aad('moliya.item', keyring.userId, safeId, live, 2))).rejects.toBeInstanceOf(DecryptError)
    await expect(openJson(sealed, oldKey, aad('moliya.item', keyring.userId, safeId, live, 1))).rejects.toBeInstanceOf(DecryptError)
  })

  it('keeps password-protected safes closed and out of search and summaries', async () => {
    const { vault, keyring, safeId } = await managerWithSafes()
    const vip = await createSafe(vault, keyring, { name: 'VIP', description: '', icon: 'heart', color: 'pine', requirePassword: true })
    await createItem(vault, keyring, vip, SUBSCRIPTION)
    await createItem(vault, keyring, safeId, { ...SUBSCRIPTION, title: 'Music', amountMinor: 499 })

    const restored = await open(await sealVault(vault), MANAGER.email, MANAGER.password)
    const { keyring: again } = await unlockSafes(restored, { kind: 'password', password: MANAGER.password })
    expect((await listSafes(restored, again)).find((safe) => safe.id === vip)?.open).toBe(false)
    expect(await codeOf(listItems(restored, again, vip))).toBe('SAFE_CLOSED')
    expect(await codeOf(createItem(restored, again, vip, NOTE))).toBe('SAFE_CLOSED')
    const visible = await listOpenItems(restored, again)
    expect(visible.items.map((item) => item.title)).toEqual(['Music'])
    expect(subscriptionSummary(visible.items, '2026-09-29').totals).toEqual([{ currency: 'USD', monthlyMinor: 499, yearlyMinor: 5988, active: 1 }])

    expect(await codeOf(openSafe(restored, again, vip, 'wrong-password'))).toBe('BAD_CREDENTIALS')
    await openSafe(restored, again, vip, MANAGER.password)
    expect((await listOpenItems(restored, again)).items.map((item) => item.title).sort()).toEqual(['Music', 'Netflix'])
  })

  it('enforces the per-user safe limit', async () => {
    const { vault, keyring } = await managerWithSafes()
    for (let index = 1; index < 50; index += 1) {
      vault.db.exec(
        "INSERT INTO safes (id, owner_user_id, enc_version, key_version, key_iv, wrapped_key, meta_iv, meta_ciphertext) VALUES (?, ?, 1, 1, 'x', 'x', 'x', 'x')",
        [`filler-${index}`, keyring.userId],
      )
    }
    expect(await codeOf(createSafe(vault, keyring, { name: 'One too many', description: '', icon: 'vault', color: 'pine', requirePassword: false }))).toBe('SAFE_LIMIT')
    const safes = await listSafes(vault, keyring)
    expect(safes.filter((safe) => safe.meta === null)).toHaveLength(49)
  })
})
