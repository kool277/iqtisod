import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KeysRecord, LegacyRecord } from '../../src/db/envelope'
import { readVault, writeVault } from '../../src/db/storage'
import { KEYS_RECORD_VERSION } from '../../src/db/versions'
import { AuthError } from '../../src/domain/errors'
import type { OpenVault } from '../../src/domain/types'
import { base32Decode, importTotpKey, totpAt } from '../../src/lib/totp'
import { changeOwnPassword } from '../../src/services/account.service'
import { createVault, sealVault, unlockVault } from '../../src/services/auth.service'
import { createInvite, issueReset, redeemGrant } from '../../src/services/grant.service'
import { listGroups } from '../../src/services/group.service'
import { getSafeStatus, initializeSafes, unlockSafes } from '../../src/services/safe.service'
import { beginTotpSetup, completeTotpChallenge, enableTotp, openTotpChallenge } from '../../src/services/totp.service'
import { commitSealed, confirmKeysSession } from '../../src/services/v2/session'
import { upgradeToKeys } from '../../src/services/v2/upgrade'
import { createKeysVault } from '../../src/services/v2/vault'
import { memoryStorage } from '../support/memory-storage'

// The smallest Argon2id the readers accept, so the derivations here stay quick.
vi.mock('../../src/crypto/kdf', async (load) => {
  const actual = await load<typeof import('../../src/crypto/kdf')>()
  return { ...actual, ARGON2_DEFAULT: { name: 'Argon2id', m: 19_456, t: 2, p: 1, len: 32, v: 19 } }
})

const FOUNDER = { email: 'founder@personal.test', password: 'founder-personal-password-1' }
const MEMBER = { email: 'member@personal.test', password: 'member-personal-password-1' }
const NEXT = 'founder-personal-password-2'
const SAFES = { recovery: true, defaultSafeName: 'Main' }

const open: OpenVault[] = []
function track<T extends OpenVault>(vault: T): T {
  open.push(vault)
  return vault
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
})

afterEach(async () => {
  for (const vault of open.splice(0)) {
    try {
      vault.db.close()
    } catch {
      // Already closed.
    }
  }
  vi.unstubAllGlobals()
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('moliya')
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
  })
})

async function save(vault: OpenVault, stamp: string | null): Promise<string> {
  const record = await sealVault(vault)
  await writeVault(record, { expectedStamp: stamp })
  commitSealed(vault, record)
  return record.updatedAt
}

async function stored(): Promise<KeysRecord> {
  const loaded = await readVault()
  if (!loaded || loaded.record.version !== KEYS_RECORD_VERSION) throw new Error('no version 3 record stored')
  return loaded.record
}

async function founded() {
  const created = await createKeysVault({ ...FOUNDER, displayName: 'Personal Keys Household', currency: 'USD' })
  track(created.vault)
  await writeVault(created.record, { expectedStamp: null })
  commitSealed(created.vault, created.record)
  confirmKeysSession(created.vault)
  return { vault: created.vault, at: created.record.updatedAt }
}

function wrapOf(vault: OpenVault, table: 'user_keys' | 'user_totp'): { kdf: unknown; salt: string } {
  const row = vault.db.queryOne(`SELECT kdf, kdf_salt FROM ${table} WHERE user_id = ?`, [vault.user.id])
  if (!row) throw new Error(`no ${table} row`)
  return { kdf: JSON.parse(String(row.kdf)), salt: String(row.kdf_salt) }
}

async function codeAt(secret: string, ms: number): Promise<string> {
  return totpAt(await importTotpKey(base32Decode(secret)), ms)
}

const codeNow = (secret: string) => codeAt(secret, Date.now())

describe('safes and the sign-in check with per-person keys', () => {
  it('wraps the safe key from the identity, with no password-derived wrap, and keeps it through a new password', async () => {
    const { vault } = await founded()
    const { recoveryCode } = await initializeSafes(vault, FOUNDER.password, SAFES)
    expect(recoveryCode).toBeTruthy()
    expect(wrapOf(vault, 'user_keys')).toEqual({ kdf: { name: 'identity' }, salt: '' })
    await unlockSafes(vault, { kind: 'password', password: FOUNDER.password })
    await expect(unlockSafes(vault, { kind: 'password', password: 'not-the-password-at-all-1' })).rejects.toBeInstanceOf(AuthError)

    await changeOwnPassword(vault, FOUNDER.password, NEXT)
    // The identity is sealed again with the same seed: the wrap is the same, and not stale.
    expect(wrapOf(vault, 'user_keys')).toEqual({ kdf: { name: 'identity' }, salt: '' })
    expect(getSafeStatus(vault).stale).toBe(false)
    await unlockSafes(vault, { kind: 'password', password: NEXT })
    await expect(unlockSafes(vault, { kind: 'password', password: FOUNDER.password })).rejects.toBeInstanceOf(AuthError)
  })

  it('opens safes only with the recovery code once a new invite replaced the identity', async () => {
    let { vault, at } = await founded()
    const [group] = listGroups(vault)
    const invite = await createInvite(vault, { email: MEMBER.email, roleName: 'Viewer', groupId: group.id, validity: '24h' })
    at = await save(vault, at)
    const member = track(await redeemGrant(await stored(), { kind: 'INVITE', email: MEMBER.email, code: invite.code, password: MEMBER.password }))
    const { recoveryCode } = await initializeSafes(member, MEMBER.password, SAFES)
    at = await save(member, at)
    const admin = track(await unlockVault(await stored(), FOUNDER.email, FOUNDER.password))
    const reset = await issueReset(admin, invite.id, { validity: '24h', stopOldPassword: true })
    at = await save(admin, at)
    // They come back with the same password, but new keys.
    const back = track(await redeemGrant(await stored(), { kind: 'RESET', email: MEMBER.email, code: reset.code, password: MEMBER.password }))
    expect(getSafeStatus(back)).toMatchObject({ stale: true, previousPassword: false, hasRecovery: true })
    await expect(unlockSafes(back, { kind: 'password', password: MEMBER.password })).rejects.toMatchObject({ code: 'SAFES_STALE' })
    await expect(unlockSafes(back, { kind: 'previousPassword', previous: MEMBER.password, current: MEMBER.password })).rejects.toBeInstanceOf(AuthError)
    await unlockSafes(back, { kind: 'recoveryCode', code: recoveryCode!, current: MEMBER.password })
    expect(getSafeStatus(back).stale).toBe(false)
    await unlockSafes(back, { kind: 'password', password: MEMBER.password })
  })

  it('moves a 1.x safe key onto the identity the first time it opens in an upgraded vault', async () => {
    const created = await createVault({ ...FOUNDER, displayName: 'Old Personal Household', currency: 'USD' })
    const v1 = track(created.vault)
    await initializeSafes(v1, FOUNDER.password, SAFES)
    const pbkdf2 = wrapOf(v1, 'user_keys')
    expect(pbkdf2.kdf).toMatchObject({ name: 'PBKDF2' })
    await writeVault((await sealVault(v1)) as LegacyRecord, { expectedStamp: null })
    const { vault } = await upgradeToKeys(v1, FOUNDER.password)
    expect(wrapOf(vault, 'user_keys')).toEqual(pbkdf2)
    await unlockSafes(vault, { kind: 'password', password: FOUNDER.password })
    expect(wrapOf(vault, 'user_keys')).toEqual({ kdf: { name: 'identity' }, salt: '' })
    await unlockSafes(vault, { kind: 'password', password: FOUNDER.password })
  })

  it('seals the sign-in check from the identity, opens it from the sign-in without another password check, and keeps it through a new password', async () => {
    let { vault, at } = await founded()
    const setup = beginTotpSetup(FOUNDER.email)
    await enableTotp(vault, FOUNDER.password, setup, await codeNow(setup.secret))
    expect(wrapOf(vault, 'user_totp')).toEqual({ kdf: { name: 'identity' }, salt: '' })
    at = await save(vault, at)

    const signedIn = track(await unlockVault(await stored(), FOUNDER.email, FOUNDER.password))
    expect(signedIn.keys?.signInTotpKey).toBeDefined()
    // The key the sign-in derived from the identity opens it: the password is not needed again.
    const challenge = await openTotpChallenge(signedIn, 'not-the-password-at-all-1')
    expect(challenge).not.toBeNull()
    expect(signedIn.keys?.signInTotpKey).toBeUndefined()
    await expect(completeTotpChallenge(signedIn, challenge!, '000000')).rejects.toMatchObject({ code: 'TOTP_INVALID' })

    await changeOwnPassword(signedIn, FOUNDER.password, NEXT)
    expect(wrapOf(signedIn, 'user_totp')).toEqual({ kdf: { name: 'identity' }, salt: '' })
    await save(signedIn, at)
    const again = track(await unlockVault(await stored(), FOUNDER.email, NEXT))
    const next = await openTotpChallenge(again, NEXT)
    expect(next).not.toBeNull()
  })

  it('moves a 1.x sign-in check onto the identity at the first sign-in after the upgrade', async () => {
    const created = await createVault({ ...FOUNDER, displayName: 'Old Check Household', currency: 'USD' })
    const v1 = track(created.vault)
    const setup = beginTotpSetup(FOUNDER.email)
    await enableTotp(v1, FOUNDER.password, setup, await codeNow(setup.secret))
    expect(wrapOf(v1, 'user_totp').kdf).toMatchObject({ name: 'PBKDF2' })
    await writeVault((await sealVault(v1)) as LegacyRecord, { expectedStamp: null })
    const upgraded = await upgradeToKeys(v1, FOUNDER.password)
    await writeVault(upgraded.record, { expectedStamp: (await readVault())!.record.updatedAt })
    commitSealed(upgraded.vault, upgraded.record)

    const signedIn = track(await unlockVault(await stored(), FOUNDER.email, FOUNDER.password))
    const challenge = await openTotpChallenge(signedIn, FOUNDER.password)
    expect(challenge).not.toBeNull()
    expect(wrapOf(signedIn, 'user_totp')).toEqual({ kdf: { name: 'identity' }, salt: '' })
    expect(signedIn.needsSave).toBe(true)
    // A code of a later step: the one used to turn it on cannot be used twice.
    const later = Date.now() + 30_000
    await completeTotpChallenge(signedIn, challenge!, await codeAt(setup.secret, later), later)
  })
})
