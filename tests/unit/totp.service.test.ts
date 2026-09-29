import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CURRENT_KDF } from '../../src/crypto/crypto.service'
import { AuthError, ForbiddenError } from '../../src/domain/errors'
import type { OpenVault } from '../../src/domain/types'
import { base32Decode, importTotpKey, timeStep, totpAt } from '../../src/lib/totp'
import { changeOwnPassword } from '../../src/services/account.service'
import { sealVault, unlockVault } from '../../src/services/auth.service'
import {
  RECOVERY_CODE_COUNT,
  beginTotpSetup,
  clearUserTotp,
  completeTotpChallenge,
  disableTotp,
  enableTotp,
  hasSignInCheck,
  normalizeRecoveryCode,
  openTotpChallenge,
  type TotpSetup,
} from '../../src/services/totp.service'
import { listUsers } from '../../src/services/user.service'
import {
  MANAGER,
  MEMBER,
  MINUTE,
  NEW_PASSWORD,
  OWNER,
  auditActions,
  auditRows,
  buildAccessHousehold,
  expectNoSecretsStored,
  lastAudit,
  openAs,
  thrownCode,
  type Household,
} from '../support/access'
import { closeTracked, track } from '../support/safes'

const T0 = Date.parse('2026-10-01T08:00:00.000Z')
const STEP = 30_000
const RECOVERY_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){3}$/

let household: Household

beforeAll(async () => {
  household = await buildAccessHousehold()
  closeTracked()
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
  closeTracked()
})

async function codeAt(secret: string, ms: number): Promise<string> {
  return totpAt(await importTotpKey(base32Decode(secret)), ms)
}

/** Some six digits that no step in [from, to] produces. */
async function unusedCode(secret: string, fromMs: number, toMs: number): Promise<string> {
  const taken = new Set<string>()
  for (let ms = fromMs; ms <= toMs; ms += STEP) taken.add(await codeAt(secret, ms))
  for (let value = 0; ; value += 1) {
    const candidate = String(value).padStart(6, '0')
    if (!taken.has(candidate)) return candidate
  }
}

async function enable(vault: OpenVault, password: string, at = T0): Promise<{ setup: TotpSetup; recovery: string[] }> {
  const setup = beginTotpSetup(vault.user.email)
  const recovery = await enableTotp(vault, password, setup, await codeAt(setup.secret, at), at)
  return { setup, recovery }
}

function totpRow(vault: OpenVault, userId = vault.user.id): Record<string, unknown> {
  return { ...vault.db.queryOne('SELECT * FROM user_totp WHERE user_id = ?', [userId])! }
}

describe('sign-in check setup', () => {
  it('generates a fresh 160-bit secret and an otpauth URI', () => {
    const setup = beginTotpSetup(OWNER.email)
    expect(setup.secret).toMatch(/^[A-Z2-7]{32}$/)
    expect(base32Decode(setup.secret)).toHaveLength(20)
    expect(setup.uri).toBe(`otpauth://totp/Moliya%3Akeeper%40maple.test?secret=${setup.secret}&issuer=Moliya&algorithm=SHA1&digits=6&period=30`)
    expect(beginTotpSetup(OWNER.email).secret).not.toBe(setup.secret)
  })

  it('enables with a current code and returns ten one-time recovery codes', async () => {
    const admin = await openAs(household.record, OWNER)
    expect(hasSignInCheck(admin.db, admin.user.id)).toBe(false)
    await expect(openTotpChallenge(admin, OWNER.password)).resolves.toBeNull()
    const setup = beginTotpSetup(OWNER.email)
    const recovery = await enableTotp(admin, OWNER.password, setup, ` ${await codeAt(setup.secret, T0)} `)

    expect(RECOVERY_CODE_COUNT).toBe(10)
    expect(recovery).toHaveLength(10)
    for (const code of recovery) expect(code).toMatch(RECOVERY_PATTERN)
    expect(new Set(recovery).size).toBe(10)
    expect(hasSignInCheck(admin.db, admin.user.id)).toBe(true)
    const row = totpRow(admin)
    expect(row).toMatchObject({ enc_version: 1, last_step: timeStep(T0), created_at: new Date(T0).toISOString(), rewrapped_at: new Date(T0).toISOString() })
    expect(JSON.parse(String(row.kdf))).toEqual(CURRENT_KDF)
    const hashes = JSON.parse(String(row.recovery_hashes)) as string[]
    expect(hashes).toHaveLength(10)
    for (const hash of hashes) expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(lastAudit(admin.db, 'TOTP_ENABLED')).toEqual({ actorId: admin.user.id, action: 'TOTP_ENABLED', entityType: 'user', entityId: admin.user.id, details: null })
    expect(listUsers(admin).map((user) => [user.email, user.signInCheck])).toEqual([
      [OWNER.email, true],
      [MEMBER.email, false],
      [MANAGER.email, false],
    ])
    expectNoSecretsStored(admin.db, [setup.secret, ...recovery, OWNER.password])

    const reopened = await openAs(await sealVault(admin), OWNER)
    expect(hasSignInCheck(reopened.db, admin.user.id)).toBe(true)
    await expect(openTotpChallenge(reopened, OWNER.password)).resolves.toMatchObject({ userId: admin.user.id })
  })

  it('refuses a wrong code, a wrong password, or a second enable', async () => {
    const admin = await openAs(household.record, OWNER)
    const setup = beginTotpSetup(OWNER.email)
    const wrong = await unusedCode(setup.secret, T0 - STEP, T0 + STEP)
    const current = await codeAt(setup.secret, T0)
    await expect(enableTotp(admin, OWNER.password, setup, wrong, T0)).rejects.toMatchObject({ code: 'TOTP_INVALID' })
    await expect(enableTotp(admin, OWNER.password, setup, 'abcdef', T0)).rejects.toMatchObject({ code: 'TOTP_INVALID' })
    const far = await codeAt(setup.secret, T0 + 5 * STEP)
    if (far !== (await codeAt(setup.secret, T0 - STEP)) && far !== current && far !== (await codeAt(setup.secret, T0 + STEP))) {
      await expect(enableTotp(admin, OWNER.password, setup, far, T0)).rejects.toMatchObject({ code: 'TOTP_INVALID' })
    }
    await expect(enableTotp(admin, `${OWNER.password}!`, setup, current, T0)).rejects.toBeInstanceOf(AuthError)
    await expect(enableTotp(admin, `${OWNER.password}!`, setup, wrong, T0)).rejects.toBeInstanceOf(AuthError)
    expect(hasSignInCheck(admin.db, admin.user.id)).toBe(false)
    expect(auditActions(admin.db)).not.toContain('TOTP_ENABLED')

    await enableTotp(admin, OWNER.password, setup, await codeAt(setup.secret, T0 - STEP), T0)
    expect(totpRow(admin).last_step).toBe(timeStep(T0) - 1)
    await expect(enableTotp(admin, `${OWNER.password}!`, beginTotpSetup(OWNER.email), current, T0)).rejects.toMatchObject({ code: 'TOTP_ENABLED' })
    expect(auditActions(admin.db).filter((action) => action === 'TOTP_ENABLED')).toHaveLength(1)
  })
})

describe('sign-in check challenge', () => {
  it('opens only with the owner password', async () => {
    const admin = await openAs(household.record, OWNER)
    await enable(admin, OWNER.password)
    const challenge = await openTotpChallenge(admin, OWNER.password)
    expect(challenge?.userId).toBe(admin.user.id)
    await expect(openTotpChallenge(admin, `${OWNER.password}!`)).rejects.toBeInstanceOf(AuthError)
    await expect(openTotpChallenge(admin, MANAGER.password)).rejects.toBeInstanceOf(AuthError)
  })

  it('accepts a code within one step once and never an older step', async () => {
    const admin = await openAs(household.record, OWNER)
    const { setup } = await enable(admin, OWNER.password)
    const challenge = (await openTotpChallenge(admin, OWNER.password))!
    const auditCount = auditRows(admin.db).length
    const s0 = timeStep(T0)

    await expect(completeTotpChallenge(admin, challenge, await codeAt(setup.secret, T0), T0)).rejects.toMatchObject({ code: 'TOTP_INVALID' })
    const t1 = T0 + STEP
    await expect(completeTotpChallenge(admin, challenge, await codeAt(setup.secret, T0 - STEP), t1)).rejects.toMatchObject({ code: 'TOTP_INVALID' })
    const next = await codeAt(setup.secret, t1)
    await expect(completeTotpChallenge(admin, challenge, `${next.slice(0, 3)} ${next.slice(3)}`, t1)).resolves.toEqual({ usedRecovery: false, recoveryLeft: 10 })
    expect(totpRow(admin).last_step).toBe(s0 + 1)
    await expect(completeTotpChallenge(admin, challenge, next, t1)).rejects.toMatchObject({ code: 'TOTP_INVALID' })

    const t3 = T0 + 3 * STEP
    await expect(completeTotpChallenge(admin, challenge, await codeAt(setup.secret, t3 + STEP), t3)).resolves.toMatchObject({ usedRecovery: false })
    expect(totpRow(admin).last_step).toBe(s0 + 4)
    await expect(completeTotpChallenge(admin, challenge, await codeAt(setup.secret, t3), t3)).rejects.toMatchObject({ code: 'TOTP_INVALID' })

    const t10 = T0 + 10 * STEP
    await expect(completeTotpChallenge(admin, challenge, await unusedCode(setup.secret, t10 - STEP, t10 + STEP), t10)).rejects.toMatchObject({ code: 'TOTP_INVALID' })
    const beyond = await codeAt(setup.secret, t10 + 2 * STEP)
    if (beyond !== (await codeAt(setup.secret, t10)) && beyond !== (await codeAt(setup.secret, t10 - STEP)) && beyond !== (await codeAt(setup.secret, t10 + STEP))) {
      await expect(completeTotpChallenge(admin, challenge, beyond, t10)).rejects.toMatchObject({ code: 'TOTP_INVALID' })
    }
    expect(auditRows(admin.db)).toHaveLength(auditCount)

    const reopened = await openAs(await sealVault(admin), OWNER)
    const again = (await openTotpChallenge(reopened, OWNER.password))!
    const t4 = T0 + 4 * STEP
    await expect(completeTotpChallenge(reopened, again, await codeAt(setup.secret, t4), t4)).rejects.toMatchObject({ code: 'TOTP_INVALID' })
    await expect(completeTotpChallenge(reopened, again, await codeAt(setup.secret, t4 + STEP), t4 + STEP)).resolves.toMatchObject({ usedRecovery: false })
  })

  it('accepts each recovery code exactly once, normalised, and audits only the count left', async () => {
    const admin = await openAs(household.record, OWNER)
    const { setup, recovery } = await enable(admin, OWNER.password)
    const challenge = (await openTotpChallenge(admin, OWNER.password))!
    const lastStep = totpRow(admin).last_step

    await expect(completeTotpChallenge(admin, challenge, recovery[0])).resolves.toEqual({ usedRecovery: true, recoveryLeft: 9 })
    expect(lastAudit(admin.db, 'TOTP_RECOVERY_USED')).toEqual({
      actorId: admin.user.id,
      action: 'TOTP_RECOVERY_USED',
      entityType: 'user',
      entityId: admin.user.id,
      details: { remaining: 9 },
    })
    await expect(completeTotpChallenge(admin, challenge, recovery[0])).rejects.toMatchObject({ code: 'TOTP_INVALID' })
    await expect(completeTotpChallenge(admin, challenge, recovery[1].toLowerCase())).resolves.toEqual({ usedRecovery: true, recoveryLeft: 8 })
    await expect(completeTotpChallenge(admin, challenge, recovery[2].replace(/-/g, ''))).resolves.toEqual({ usedRecovery: true, recoveryLeft: 7 })
    const sloppy = ` ${recovery[3].toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l')} `
    await expect(completeTotpChallenge(admin, challenge, sloppy)).resolves.toEqual({ usedRecovery: true, recoveryLeft: 6 })
    for (const bogus of ['ZZZZ-ZZZZ-ZZZZ-ZZZZ', 'hello', `${recovery[4]}0`, 'UUUU-UUUU-UUUU-UUUU', `${recovery[4]} `.repeat(8)]) {
      await expect(completeTotpChallenge(admin, challenge, bogus), bogus).rejects.toMatchObject({ code: 'TOTP_INVALID' })
    }
    expect(totpRow(admin).last_step).toBe(lastStep)
    await expect(completeTotpChallenge(admin, challenge, await codeAt(setup.secret, T0 + STEP), T0 + STEP)).resolves.toEqual({ usedRecovery: false, recoveryLeft: 6 })

    const reopened = await openAs(await sealVault(admin), OWNER)
    const again = (await openTotpChallenge(reopened, OWNER.password))!
    for (const used of recovery.slice(0, 4)) await expect(completeTotpChallenge(reopened, again, used)).rejects.toMatchObject({ code: 'TOTP_INVALID' })
    for (const [index, code] of recovery.slice(4).entries()) {
      await expect(completeTotpChallenge(reopened, again, code)).resolves.toEqual({ usedRecovery: true, recoveryLeft: 5 - index })
    }
    await expect(completeTotpChallenge(reopened, again, recovery[9])).rejects.toMatchObject({ code: 'TOTP_INVALID' })
    expect(auditRows(reopened.db).filter((row) => row.action === 'TOTP_RECOVERY_USED').map((row) => row.details)).toEqual(
      [9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((remaining) => ({ remaining })),
    )
    expectNoSecretsStored(reopened.db, [setup.secret, ...recovery, OWNER.password])
  })

  it('normalises recovery codes strictly', () => {
    expect(normalizeRecoveryCode('abcd-efgh-jkmn-pqrs')).toBe('ABCDEFGHJKMNPQRS')
    expect(normalizeRecoveryCode('oooo iiii llll 0000')).toBe('0000111111110000')
    expect(normalizeRecoveryCode('ABCD-EFGH-JKMN-PQR')).toBeNull()
    expect(normalizeRecoveryCode('ABCD-EFGH-JKMN-PQRU')).toBeNull()
    expect(normalizeRecoveryCode(`${' '.repeat(60)}ABCDEFGHJKMNPQRS`)).toBeNull()
  })
})

describe('turning the sign-in check off', () => {
  it('disables with the owner password only', async () => {
    const admin = await openAs(household.record, OWNER)
    await enable(admin, OWNER.password)
    await expect(disableTotp(admin, `${OWNER.password}!`)).rejects.toBeInstanceOf(AuthError)
    expect(hasSignInCheck(admin.db, admin.user.id)).toBe(true)
    await disableTotp(admin, OWNER.password)
    expect(hasSignInCheck(admin.db, admin.user.id)).toBe(false)
    expect(lastAudit(admin.db, 'TOTP_DISABLED')).toEqual({ actorId: admin.user.id, action: 'TOTP_DISABLED', entityType: 'user', entityId: admin.user.id, details: null })
    await expect(openTotpChallenge(admin, OWNER.password)).resolves.toBeNull()
    await disableTotp(admin, OWNER.password)
    expect(auditActions(admin.db).filter((action) => action === 'TOTP_DISABLED')).toHaveLength(1)
    await enable(admin, OWNER.password, T0 + MINUTE)
    expect(hasSignInCheck(admin.db, admin.user.id)).toBe(true)
  })

  it('lets an admin clear another member but not themself', async () => {
    const member = await openAs(household.record, MEMBER)
    const { setup, recovery } = await enable(member, MEMBER.password)
    const record = await sealVault(member)

    const manager = await openAs(record, MANAGER)
    expect(() => clearUserTotp(manager, household.memberId)).toThrow(ForbiddenError)
    const admin = await openAs(record, OWNER)
    expect(thrownCode(() => clearUserTotp(admin, admin.user.id))).toBe('USE_ACCOUNT')
    expect(thrownCode(() => clearUserTotp(admin, household.managerId))).toBe('REQUIRED')
    expect(listUsers(admin).find((user) => user.id === household.memberId)?.signInCheck).toBe(true)

    clearUserTotp(admin, household.memberId)
    expect(hasSignInCheck(admin.db, household.memberId)).toBe(false)
    expect(lastAudit(admin.db, 'TOTP_CLEARED')).toEqual({
      actorId: admin.user.id,
      action: 'TOTP_CLEARED',
      entityType: 'user',
      entityId: household.memberId,
      details: { reason: 'ADMIN' },
    })
    expect(listUsers(admin).find((user) => user.id === household.memberId)?.signInCheck).toBe(false)
    expect(thrownCode(() => clearUserTotp(admin, household.memberId))).toBe('REQUIRED')
    expectNoSecretsStored(admin.db, [setup.secret, ...recovery, MEMBER.password])

    const back = await openAs(await sealVault(admin), MEMBER)
    await expect(openTotpChallenge(back, MEMBER.password)).resolves.toBeNull()
  })
})

describe('changing the password with the sign-in check on', () => {
  it('re-seals the secret under the new password', async () => {
    const admin = await openAs(household.record, OWNER)
    const { setup, recovery } = await enable(admin, OWNER.password)
    const before = totpRow(admin)

    await expect(changeOwnPassword(admin, `${OWNER.password}!`, NEW_PASSWORD)).rejects.toBeInstanceOf(AuthError)
    expect(totpRow(admin)).toEqual(before)

    vi.setSystemTime(T0 + 5 * MINUTE)
    await changeOwnPassword(admin, OWNER.password, NEW_PASSWORD)
    const after = totpRow(admin)
    expect(after.secret_ciphertext).not.toBe(before.secret_ciphertext)
    expect(after.secret_iv).not.toBe(before.secret_iv)
    expect(after.kdf_salt).not.toBe(before.kdf_salt)
    expect(after).toMatchObject({
      recovery_salt: before.recovery_salt,
      recovery_hashes: before.recovery_hashes,
      last_step: before.last_step,
      created_at: before.created_at,
      rewrapped_at: new Date(T0 + 5 * MINUTE).toISOString(),
    })

    await expect(openTotpChallenge(admin, OWNER.password)).rejects.toBeInstanceOf(AuthError)
    const challenge = (await openTotpChallenge(admin, NEW_PASSWORD))!
    const now = T0 + 5 * MINUTE
    await expect(completeTotpChallenge(admin, challenge, await codeAt(setup.secret, now), now)).resolves.toMatchObject({ usedRecovery: false })
    expectNoSecretsStored(admin.db, [setup.secret, ...recovery, OWNER.password, NEW_PASSWORD])

    const saved = await sealVault(admin)
    await expect(unlockVault(saved, OWNER.email, OWNER.password)).rejects.toBeInstanceOf(AuthError)
    const reopened = track(await unlockVault(saved, OWNER.email, NEW_PASSWORD))
    const again = (await openTotpChallenge(reopened, NEW_PASSWORD))!
    await expect(completeTotpChallenge(reopened, again, recovery[0])).resolves.toEqual({ usedRecovery: true, recoveryLeft: 9 })
  })
})
