import { argon2idBits } from '../../crypto/argon2'
import { generateDek, randomBytes } from '../../crypto/crypto.service'
import { wrapDekTo } from '../../crypto/ecies'
import { cloneBytes } from '../../crypto/encoding'
import { IDENTITY_SALT_BYTES, generateIdentitySecret, importIdentity, sealIdentity, wipeSecret } from '../../crypto/identity'
import { deriveInviteKeys, inviteAad, mintInviteKeys, signsFor, unwrapInviteDek, wrapDekForInvite, type InviteKeys } from '../../crypto/invite-crypto'
import { ARGON2_DEFAULT, isArgon2Params } from '../../crypto/kdf'
import { signBinding } from '../../crypto/roster'
import { SUITE, assertSuite } from '../../crypto/suite'
import type { KeysRecord } from '../../db/envelope'
import { getSetting } from '../../db/settings'
import { AppError, ValidationError } from '../../domain/errors'
import { isRoleName, type GrantWrap, type OpenVault } from '../../domain/types'
import { generateAccessCode, normalizeAccessCode } from '../../lib/access-code'
import { deviceClockFloor, observeClock } from '../../lib/device-clock'
import { assertEmail, normalizeEmail } from '../../lib/email'
import { assertNewPassword, assertPasswordLength } from '../../lib/password-policy'
import { writeAudit } from '../audit.service'
import { buildOpenVault, loadUserById } from '../auth.service'
import { CLOCK_TOLERANCE_MS, clockFloor, endGrant, grantRow } from '../grant-store'
import { dropTotp } from '../totp.service'
import { userStatus } from '../user-profile'
import { writeBinding } from './roster-store'
import type { KeysSession } from './session'
import { openKeysDatabase } from './vault'
import { verifyKeysVault } from './verify'

/**
 * A v2 invite or re-invite (design 4.2): the code derives, through Argon2id, a key that wraps the DEK and a signing
 * key whose public half the admin's next roster names. The code itself is never stored.
 */
export async function mintKeysGrant(
  vault: OpenVault & { keys: KeysSession },
  kind: GrantWrap['kind'],
  email: string,
  expiresAt: string,
): Promise<{ code: string; wrap: GrantWrap; inviteSigPub: string }> {
  // The key of the epoch the caller checks is still current once this returns, read before anything awaits.
  const { dek } = vault
  await assertSuite()
  const id = crypto.randomUUID()
  const access = generateAccessCode()
  const salt = randomBytes(IDENTITY_SALT_BYTES)
  const kdf = { ...ARGON2_DEFAULT }
  const invite = await mintInviteKeys(access.canonical, salt, kdf)
  const wrapped = await wrapDekForInvite(dek, invite.kek, inviteAad(vault.keys.vaultId, id, kind, email, expiresAt))
  return { code: access.display, inviteSigPub: invite.sigPub, wrap: { id, kind, email, kdf, salt, iv: wrapped.iv, wrappedDek: wrapped.cipherText, expiresAt } }
}

/** Takes a member's access away at once: their sealed identity and DEK wrap leave the header. */
export function dropMemberKeys(vault: OpenVault, userId: string): void {
  if (!vault.keys) return
  delete vault.keys.identities[userId]
  delete vault.keys.dekWraps[userId]
}

function invalid(): ValidationError {
  return new ValidationError('INVITE_INVALID')
}

/** Spends the Argon2id work of a real code, so a wrong address is not faster to refuse. */
async function spendInviteWork(code: string): Promise<void> {
  try {
    const bits = await argon2idBits(code || 'x', randomBytes(IDENTITY_SALT_BYTES), ARGON2_DEFAULT)
    bits.fill(0)
  } catch {
    // Timing only.
  }
}

export type KeysRedeemInput = { kind: GrantWrap['kind']; email: string; code: string; password: string }

/**
 * Opens a version 3 vault with an invite code (design 4.2, step 4): the code unwraps the DEK, the vault passes the
 * checks of 3.8 with the invite key standing in for the person's keys, and the person picks a password. Their new
 * identity is sealed under it, the DEK is wrapped to them, the code is used up, and a key binding signed by the invite
 * key and the new key goes into the database for the next admin save to fold into the roster. The caller must save
 * right away.
 */
export async function redeemKeysInvite(record: KeysRecord, input: KeysRedeemInput, now = new Date()): Promise<OpenVault & { keys: KeysSession }> {
  const email = normalizeEmail(input.email)
  assertEmail(email)
  const canonical = normalizeAccessCode(input.code)
  assertPasswordLength(input.password)
  const grant = (record.grants ?? []).find((item) => item.kind === input.kind && item.email === email)
  if (!grant || !isArgon2Params(grant.kdf)) {
    await spendInviteWork(canonical)
    throw invalid()
  }
  const deviceFloor = deviceClockFloor()
  observeClock(now.getTime())
  if (deviceFloor !== null && now.getTime() < deviceFloor - CLOCK_TOLERANCE_MS) throw new ValidationError('CLOCK_BEHIND')
  if (grant.expiresAt !== undefined && grant.expiresAt <= new Date(Math.max(now.getTime(), deviceFloor ?? 0)).toISOString()) throw new ValidationError('INVITE_EXPIRED')
  const { keys } = record
  let invite: InviteKeys
  let dek: CryptoKey
  try {
    invite = await deriveInviteKeys(canonical, cloneBytes(grant.salt), grant.kdf)
    dek = await unwrapInviteDek(grant.wrappedDek, invite.kek, cloneBytes(grant.iv), inviteAad(keys.vaultId, grant.id, grant.kind, grant.email, grant.expiresAt ?? ''))
  } catch (error) {
    if (error instanceof AppError) throw error
    throw invalid()
  }
  const { db, chunks } = await openKeysDatabase(record, dek)
  try {
    const row = grantRow(db, grant.id)
    // The admin stored the invite key's public half; the key this code derives must be its private half.
    if (!row || row.endedAt || row.kind !== grant.kind || row.email !== email || !(await signsFor(invite.sigPriv, row.codeVerifier))) throw invalid()
    const inviteSigPub = row.codeVerifier
    if (grant.expiresAt !== row.expiresAt) throw invalid()
    const floor = clockFloor(db)
    if (floor !== null && now.getTime() < floor - CLOCK_TOLERANCE_MS) throw new ValidationError('CLOCK_BEHIND')
    if (row.expiresAt <= new Date(Math.max(now.getTime(), floor ?? 0)).toISOString()) throw new ValidationError('INVITE_EXPIRED')
    const memberId = row.kind === 'INVITE' ? row.id : row.userId
    if (!memberId) throw invalid()
    const verified = await verifyKeysVault(record, db, { memberId, invite: { sigPub: inviteSigPub } })
    await assertNewPassword(input.password, { email, vaultName: getSetting(db, 'vault_name') ?? undefined })
    if (row.kind === 'INVITE') {
      if (db.queryValue('SELECT 1 FROM users WHERE email = ? OR id = ?', [email, memberId]) != null) throw new ValidationError('DUPLICATE_EMAIL')
      const roleName = db.queryValue('SELECT name FROM roles WHERE id = ?', [row.roleId])
      if (roleName == null || !isRoleName(String(roleName))) throw new ValidationError('ROLE')
      if (String(roleName) !== 'Admin' && row.groupId == null) throw new ValidationError('GROUP')
    } else {
      const target = db.queryOne('SELECT id, email FROM users WHERE id = ?', [memberId])
      if (!target || String(target.email) !== email || userStatus(db, memberId) !== 'ACTIVE') throw invalid()
    }

    const secret = await generateIdentitySecret()
    let blob
    let identity
    try {
      blob = await sealIdentity(secret, { vaultId: keys.vaultId, memberId, email, password: input.password })
      identity = await importIdentity(secret)
    } finally {
      wipeSecret(secret)
    }
    const wrap = await wrapDekTo(dek, identity.encPub, { vaultId: keys.vaultId, epoch: keys.epoch, memberId })
    const at = now.toISOString()
    const binding = await signBinding(
      { type: 'binding', suite: SUITE, vaultId: keys.vaultId, memberId, rosterVersion: verified.latest.version, inviteSigPub, encPub: identity.encPub, sigPub: identity.sigPub, at },
      invite.sigPriv,
      identity.sigPriv,
    )
    db.withTransaction(() => {
      if (row.kind === 'INVITE') {
        db.exec(
          `INSERT INTO users (id, email, password_hash, salt, role_id, group_id, must_change_password, password_changed_at)
           VALUES (?, ?, '', '', ?, ?, 0, ?)`,
          [memberId, email, row.roleId, row.groupId, at],
        )
        endGrant(db, row.id, 'USED', memberId, at)
        writeAudit(db, memberId, 'INVITE_ACCEPTED', 'grant', row.id, { email, role: String(db.queryValue('SELECT name FROM roles WHERE id = ?', [row.roleId])), groupId: row.groupId, keys: true })
      } else {
        db.exec("UPDATE users SET password_hash = '', salt = '', must_change_password = 0, password_changed_at = ? WHERE id = ?", [at, memberId])
        dropTotp(db, memberId, memberId, 'PASSWORD_RESET')
        endGrant(db, row.id, 'USED', memberId, at)
        writeAudit(db, memberId, 'RESET_COMPLETED', 'grant', row.id, { email, keys: true })
      }
      writeBinding(db, binding)
    })
    const user = loadUserById(db, memberId)
    if (!user) throw invalid()
    const session: KeysSession = {
      vaultId: keys.vaultId,
      epoch: keys.epoch,
      founder: { ...keys.founder },
      memberId,
      identity,
      identities: { ...structuredClone(keys.identities), [memberId]: blob },
      dekWraps: { ...structuredClone(keys.dekWraps), [memberId]: wrap },
      roster: { ...keys.roster },
      chunks,
      firstSeen: verified.firstSeen,
      holders: [...new Set([...verified.holders, memberId])].sort(),
      nextDek: await generateDek(),
    }
    const vault = buildOpenVault(record, { db, dek, wraps: [], user, needsSave: true }, now)
    vault.grants = vault.grants.filter((item) => item.id !== grant.id)
    vault.keys = session
    return vault as OpenVault & { keys: KeysSession }
  } catch (error) {
    db.close()
    throw error
  }
}
