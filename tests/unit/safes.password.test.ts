import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CURRENT_KDF, randomBytes } from '../../src/crypto/crypto.service'
import { bytesToBase64 } from '../../src/crypto/encoding'
import {
  PERSONAL_KEY_USAGES,
  aad,
  derivePersonalKek,
  deriveRecoveryKek,
  generateAesKey,
  generateRecoveryCode,
  sealJson,
  wrapWithAad,
} from '../../src/crypto/safe-crypto'
import type { VaultRecord } from '../../src/db/envelope'
import { AppError } from '../../src/domain/errors'
import { DEFAULT_PREFS, type NoteItem } from '../../src/domain/safes'
import type { OpenVault } from '../../src/domain/types'
import { changeOwnPassword } from '../../src/services/account.service'
import { createVault, sealVault } from '../../src/services/auth.service'
import {
  createItem,
  createRecoveryCode,
  getSafeStatus,
  initializeSafes,
  listItems,
  listSafeEvents,
  listSafes,
  resetSafes,
  unlockSafes,
  type SafeKeyring,
} from '../../src/services/safe.service'
import { listGroups } from '../../src/services/group.service'
import { createUser, resetUserPassword } from '../../src/services/user.service'
import { ADMIN, MANAGER, NOTE, NOTE_BODY, buildHousehold, closeTracked, open, track } from '../support/safes'

const TEMP = 'temporary-by-admin-9'
const NEXT = 'manager-after-reset-7'

let household: VaultRecord

beforeAll(async () => {
  household = await buildHousehold()
})

afterEach(closeTracked)

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise
    return null
  } catch (error) {
    return error instanceof AppError ? error.code : String(error)
  }
}

async function managerWithNote(recovery: boolean): Promise<{ record: VaultRecord; code: string | null; safeId: string; noteId: string }> {
  const vault = await open(household, MANAGER.email, MANAGER.password)
  const { keyring, recoveryCode } = await initializeSafes(vault, MANAGER.password, { recovery, defaultSafeName: 'Personal' })
  const safeId = keyring.meta.defaultSafeId
  const noteId = await createItem(vault, keyring, safeId, NOTE)
  return { record: await sealVault(vault), code: recoveryCode, safeId, noteId }
}

async function adminResets(record: VaultRecord): Promise<VaultRecord> {
  const admin = await open(record, ADMIN.email, ADMIN.password)
  const manager = admin.wraps.find((wrap) => wrap.email === MANAGER.email)!
  await resetUserPassword(admin, manager.userId, TEMP)
  return sealVault(admin)
}

async function forcedChange(record: VaultRecord): Promise<OpenVault> {
  const vault = await open(record, MANAGER.email, TEMP)
  expect(vault.user.mustChangePassword).toBe(true)
  expect(getSafeStatus(vault).mustChangePassword).toBe(true)
  expect(await codeOf(unlockSafes(vault, { kind: 'password', password: TEMP }))).toBe('MUST_CHANGE_PASSWORD')
  expect(await codeOf(initializeSafes(vault, TEMP, { recovery: false, defaultSafeName: 'x' }))).toBe('MUST_CHANGE_PASSWORD')
  expect(await codeOf(resetSafes(vault, TEMP, 'RESET', { recovery: false, defaultSafeName: 'x' }))).toBe('MUST_CHANGE_PASSWORD')
  expect(await changeOwnPassword(vault, TEMP, NEXT)).toEqual({ safesRewrapped: false })
  expect(vault.user.mustChangePassword).toBe(false)
  expect(getSafeStatus(vault)).toMatchObject({ initialized: true, stale: true })
  expect(await codeOf(unlockSafes(vault, { kind: 'password', password: NEXT }))).toBe('SAFES_STALE')
  return vault
}

async function noteText(vault: OpenVault, unlocked: { keyring: SafeKeyring }, safeId: string) {
  const { items } = await listItems(vault, unlocked.keyring, safeId)
  return items.map((item) => (item as NoteItem).body)
}

describe('private safes and passwords', () => {
  it('moves the safes to a new password when the owner changes it', async () => {
    const { record, safeId } = await managerWithNote(false)
    const vault = await open(record, MANAGER.email, MANAGER.password)
    const saltBefore = vault.db.queryValue('SELECT kdf_salt FROM user_keys WHERE user_id = ?', [vault.user.id])
    expect(await codeOf(changeOwnPassword(vault, MANAGER.password, MANAGER.password))).toBe('SAME_PASSWORD')
    expect(await codeOf(changeOwnPassword(vault, 'not-my-password', NEXT))).toBe('BAD_CREDENTIALS')
    expect(await changeOwnPassword(vault, MANAGER.password, NEXT)).toEqual({ safesRewrapped: true })
    expect(vault.db.queryValue('SELECT kdf_salt FROM user_keys WHERE user_id = ?', [vault.user.id])).not.toBe(saltBefore)
    expect(getSafeStatus(vault).stale).toBe(false)
    const last = vault.db.queryOne('SELECT action, details FROM audit_logs ORDER BY seq DESC LIMIT 1')!
    expect(last.action).toBe('PASSWORD_CHANGED')
    expect(String(last.details ?? '')).not.toContain(NEXT)

    const sealed = await sealVault(vault)
    await expect(open(sealed, MANAGER.email, MANAGER.password)).rejects.toBeTruthy()
    const again = await open(sealed, MANAGER.email, NEXT)
    expect(await codeOf(unlockSafes(again, { kind: 'password', password: MANAGER.password }))).toBe('BAD_CREDENTIALS')
    const unlocked = await unlockSafes(again, { kind: 'password', password: NEXT })
    expect(await noteText(again, unlocked, safeId)).toEqual([NOTE_BODY])
  })

  it('recovers after an admin reset with the previous password (no recovery code)', async () => {
    const { record, code, safeId } = await managerWithNote(false)
    expect(code).toBeNull()
    const vault = await forcedChange(await adminResets(record))
    expect(getSafeStatus(vault).hasRecovery).toBe(false)
    expect(await codeOf(unlockSafes(vault, { kind: 'recoveryCode', code: generateRecoveryCode().display, current: NEXT }))).toBe('NO_RECOVERY_CODE')
    expect(await codeOf(unlockSafes(vault, { kind: 'previousPassword', previous: 'wrong-previous-1', current: NEXT }))).toBe('BAD_CREDENTIALS')
    expect(await codeOf(unlockSafes(vault, { kind: 'previousPassword', previous: MANAGER.password, current: 'wrong-current-1' }))).toBe('BAD_CREDENTIALS')
    const unlocked = await unlockSafes(vault, { kind: 'previousPassword', previous: MANAGER.password, current: NEXT })
    expect(unlocked.usedRecovery).toBe(false)
    expect(await noteText(vault, unlocked, safeId)).toEqual([NOTE_BODY])
    expect(getSafeStatus(vault).stale).toBe(false)

    const reopened = await open(await sealVault(vault), MANAGER.email, NEXT)
    const second = await unlockSafes(reopened, { kind: 'password', password: NEXT })
    expect(await noteText(reopened, second, safeId)).toEqual([NOTE_BODY])
    expect((await listSafeEvents(reopened, second.keyring)).map((event) => event.type)).toContain('PASSWORD_REWRAPPED')
  })

  it('recovers after an admin reset with the recovery code, and can replace the code', async () => {
    const { record, code, safeId } = await managerWithNote(true)
    expect(code).toMatch(/^[0-9A-Z*~$=]{5}(-[0-9A-Z*~$=]{5}){4}$/)
    const vault = await forcedChange(await adminResets(record))
    expect(getSafeStatus(vault).hasRecovery).toBe(true)
    expect(await codeOf(unlockSafes(vault, { kind: 'recoveryCode', code: 'not a code', current: NEXT }))).toBe('RECOVERY_CODE')
    expect(await codeOf(unlockSafes(vault, { kind: 'recoveryCode', code: generateRecoveryCode().display, current: NEXT }))).toBe('RECOVERY_CODE')
    const unlocked = await unlockSafes(vault, { kind: 'recoveryCode', code: code!.toLowerCase(), current: NEXT })
    expect(unlocked.usedRecovery).toBe(true)
    expect(await noteText(vault, unlocked, safeId)).toEqual([NOTE_BODY])

    expect(await codeOf(createRecoveryCode(vault, unlocked.keyring, 'wrong-password-1'))).toBe('BAD_CREDENTIALS')
    const fresh = await createRecoveryCode(vault, unlocked.keyring, NEXT)
    expect(fresh).not.toBe(code)
    const reopened = await open(await adminResets(await sealVault(vault)), MANAGER.email, TEMP)
    await changeOwnPassword(reopened, TEMP, 'third-password-3')
    expect(await codeOf(unlockSafes(reopened, { kind: 'recoveryCode', code: code!, current: 'third-password-3' }))).toBe('RECOVERY_CODE')
    const viaFresh = await unlockSafes(reopened, { kind: 'recoveryCode', code: fresh, current: 'third-password-3' })
    expect(await noteText(reopened, viaFresh, safeId)).toEqual([NOTE_BODY])
  })

  it('adds a recovery code later for someone who skipped it at setup', async () => {
    const { record, safeId } = await managerWithNote(false)
    const vault = await open(record, MANAGER.email, MANAGER.password)
    const { keyring } = await unlockSafes(vault, { kind: 'password', password: MANAGER.password })
    const code = await createRecoveryCode(vault, keyring, MANAGER.password)
    expect(getSafeStatus(vault).hasRecovery).toBe(true)
    const reset = await forcedChange(await adminResets(await sealVault(vault)))
    const unlocked = await unlockSafes(reset, { kind: 'recoveryCode', code, current: NEXT })
    expect(await noteText(reset, unlocked, safeId)).toEqual([NOTE_BODY])
  })

  it('loses the safes for good when the previous password and recovery code are both gone, and can start over', async () => {
    const { record } = await managerWithNote(false)
    const vault = await forcedChange(await adminResets(record))
    expect(await codeOf(unlockSafes(vault, { kind: 'previousPassword', previous: TEMP, current: NEXT }))).toBe('BAD_CREDENTIALS')
    expect(await codeOf(resetSafes(vault, NEXT, 'reset please', { recovery: false, defaultSafeName: 'Fresh' }))).toBe('CONFIRM_RESET')
    expect(await codeOf(resetSafes(vault, 'wrong-password-1', 'RESET', { recovery: false, defaultSafeName: 'Fresh' }))).toBe('BAD_CREDENTIALS')
    const { keyring, recoveryCode } = await resetSafes(vault, NEXT, 'RESET', { recovery: false, defaultSafeName: 'Fresh' })
    expect(recoveryCode).toBeNull()
    expect(vault.db.queryValue('SELECT COUNT(*) FROM secure_items WHERE owner_user_id = ?', [vault.user.id])).toBe(0)
    expect((await listSafes(vault, keyring)).map((safe) => safe.meta?.name)).toEqual(['Fresh'])
    expect(getSafeStatus(vault)).toMatchObject({ initialized: true, stale: false, hasRecovery: false })
  })

  it('never opens a wrap an Admin forged under the temporary password', async () => {
    const { record, code } = await managerWithNote(true)
    const reset = await open(await adminResets(record), ADMIN.email, ADMIN.password)
    const managerId = reset.wraps.find((wrap) => wrap.email === MANAGER.email)!.userId

    const forgedKey = await generateAesKey(PERSONAL_KEY_USAGES)
    const salt = randomBytes(32)
    const wrap = await wrapWithAad(forgedKey, await derivePersonalKek(TEMP, salt, CURRENT_KDF), aad('moliya.pk', managerId))
    const forgedCode = generateRecoveryCode()
    const recoverySalt = randomBytes(16)
    const recovery = await wrapWithAad(forgedKey, await deriveRecoveryKek(forgedCode.bytes, recoverySalt), aad('moliya.pk-recovery', managerId))
    const meta = await sealJson({ v: 1, order: [], defaultSafeId: '', ...DEFAULT_PREFS }, forgedKey, aad('moliya.user-meta', managerId))
    const later = new Date(Date.now() + 1000).toISOString()
    reset.db.exec('DELETE FROM user_keys WHERE user_id = ?', [managerId])
    reset.db.exec(
      `INSERT INTO user_keys (user_id, enc_version, kdf, kdf_salt, wrap_iv, wrapped_key, recovery_salt, recovery_iv, recovery_wrapped_key,
         meta_iv, meta_ciphertext, created_at, rewrapped_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [managerId, JSON.stringify(CURRENT_KDF), bytesToBase64(salt), wrap.iv, wrap.ct, bytesToBase64(recoverySalt), recovery.iv, recovery.ct, meta.iv, meta.ct, later, later],
    )

    const vault = await open(await sealVault(reset), MANAGER.email, TEMP)
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await changeOwnPassword(vault, TEMP, NEXT)
    expect(getSafeStatus(vault).stale).toBe(true)
    expect(await codeOf(unlockSafes(vault, { kind: 'password', password: NEXT }))).toBe('SAFES_STALE')
    expect(await codeOf(unlockSafes(vault, { kind: 'previousPassword', previous: MANAGER.password, current: NEXT }))).toBe('BAD_CREDENTIALS')
    expect(await codeOf(unlockSafes(vault, { kind: 'recoveryCode', code: code!, current: NEXT }))).toBe('RECOVERY_CODE')

    const { keyring } = await resetSafes(vault, NEXT, 'RESET', { recovery: true, defaultSafeName: 'Fresh' })
    const row = vault.db.queryOne('SELECT wrap_iv, wrapped_key, recovery_iv FROM user_keys WHERE user_id = ?', [managerId])!
    expect(row.wrapped_key).not.toBe(wrap.ct)
    expect(row.recovery_iv).not.toBe(recovery.iv)
    const reopened = await open(await sealVault(vault), MANAGER.email, NEXT)
    const again = await unlockSafes(reopened, { kind: 'password', password: NEXT })
    expect(again.keyring.meta.defaultSafeId).toBe(keyring.meta.defaultSafeId)
  })

  it('makes accounts created by an Admin choose their own password first', async () => {
    const created = await createVault({ email: ADMIN.email, password: ADMIN.password, displayName: 'Home', currency: 'USD' })
    track(created.vault)
    expect(created.vault.user.mustChangePassword).toBe(false)
    await createUser(created.vault, { email: 'new@example.com', password: TEMP, roleName: 'Viewer', groupId: listGroups(created.vault)[0].id })
    const viewer = await open(await sealVault(created.vault), 'new@example.com', TEMP)
    expect(viewer.user.mustChangePassword).toBe(true)
    expect(await codeOf(initializeSafes(viewer, TEMP, { recovery: false, defaultSafeName: 'x' }))).toBe('MUST_CHANGE_PASSWORD')
    expect(await codeOf(resetUserPassword(created.vault, created.vault.user.id, TEMP))).toBe('USE_ACCOUNT')
  })
})
