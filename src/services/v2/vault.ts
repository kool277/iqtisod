import { argon2idBits } from '../../crypto/argon2'
import { generateDek, randomBytes } from '../../crypto/crypto.service'
import { unwrapDekWith, wrapDekTo } from '../../crypto/ecies'
import { IDENTITY_SALT_BYTES, generateIdentitySecret, importIdentity, openIdentitySecret, sealIdentity, unsealIdentity, wipeSecret, type IdentityBlob, type IdentityKeys } from '../../crypto/identity'
import { ARGON2_DEFAULT } from '../../crypto/kdf'
import { canonicalize } from '../../crypto/canonical'
import { bytesToBase64 } from '../../crypto/encoding'
import { bindingRedeems, nextRosterMembers, rosterHash, signRoster, type KeyBinding, type RosterCandidate, type RosterDoc, type RosterInvite, type RosterMember, type RosterRole } from '../../crypto/roster'
import { fingerprintOf, isBase64 } from '../../crypto/sign'
import { SUITE, assertSuite } from '../../crypto/suite'
import { auditHead } from '../../db/audit-chain'
import { openChunkedBody, sealChunkedBody } from '../../db/chunks'
import type { KeysRecord } from '../../db/envelope'
import { signHeader } from '../../db/header-sig'
import type { KeysHeader } from '../../db/keys-header'
import { KEYS_MIGRATIONS, assertKnownSchema, migrate, readSchemaVersion } from '../../db/migrations'
import { seedCategories, seedRoles, syncRolePermissions } from '../../db/seed'
import { setSetting } from '../../db/settings'
import { SqlDatabase } from '../../db/sqlite'
import { grantsFromRecord, keysRecordFromSession } from '../../db/storage'
import { KEYS_SCHEMA_VERSION } from '../../db/versions'
import { AppError, AuthError, CorruptRecordError, KeysBlockedError, ValidationError } from '../../domain/errors'
import { isCurrency, type OpenVault } from '../../domain/types'
import { observeClock } from '../../lib/device-clock'
import { assertEmail, normalizeEmail } from '../../lib/email'
import { assertNewPassword } from '../../lib/password-policy'
import { APP_VERSION } from '../../lib/version'
import { Permission, canUser } from '../../rbac'
import { writeAudit } from '../audit.service'
import { assertDisplayName, buildOpenVault, compactIfSparse, loadUserById, type SetupInput } from '../auth.service'
import { openGrantRows, recordClock } from '../grant-store'
import { appendRosterDoc, deleteBinding, latestRosterDoc, readBindings, readPeople } from './roster-store'
import { rememberSealed, type KeysSession } from './session'
import { verifyKeysVault } from './verify'

/** Spends the same Argon2id work as a real sign-in, so an unknown address is not faster to refuse. */
export async function spendIdentityWork(password: string): Promise<void> {
  try {
    const bits = await argon2idBits(password, randomBytes(IDENTITY_SALT_BYTES), ARGON2_DEFAULT)
    bits.fill(0)
  } catch {
    // Timing only.
  }
}

function headerOf(keys: KeysSession, sig: KeysHeader['sig']): KeysHeader {
  return {
    suite: SUITE,
    vaultId: keys.vaultId,
    epoch: keys.epoch,
    founder: { ...keys.founder },
    roster: { ...keys.roster },
    identities: keys.identities,
    dekWraps: keys.dekWraps,
    sig,
  }
}

function roleNameOf(db: SqlDatabase, roleId: number | null): RosterRole | null {
  if (roleId == null) return null
  const name = String(db.queryValue('SELECT name FROM roles WHERE id = ?', [roleId]) ?? '')
  return name === 'Admin' || name === 'Manager' || name === 'Viewer' ? name : null
}

/** Open invites and re-invites, keyed by the member id each is for. Only ones carrying an invite key (v2 codes) count. */
function rosterInvites(db: SqlDatabase): RosterInvite[] {
  const people = new Map(readPeople(db).map((person) => [person.id, person]))
  return openGrantRows(db).flatMap((row): RosterInvite[] => {
    if (!isBase64(row.codeVerifier, 32)) return []
    if (row.kind === 'INVITE') {
      const role = roleNameOf(db, row.roleId)
      return role ? [{ memberId: row.id, email: row.email, role, group: row.groupId, inviteSigPub: row.codeVerifier, inviteExpiresAt: row.expiresAt }] : []
    }
    const person = row.userId ? people.get(row.userId) : undefined
    if (!person?.role) return []
    return [{ memberId: person.id, email: row.email, role: person.role, group: person.group, inviteSigPub: row.codeVerifier, inviteExpiresAt: row.expiresAt }]
  })
}

type RosterPlan = {
  doc: RosterDoc
  hash: string
  /** Everything the plan was derived from, so it can be checked against the database right before it is applied. */
  members: RosterMember[]
  bindings: Map<string, KeyBinding>
}

function rosterCandidates(db: SqlDatabase, keys: KeysSession): RosterCandidate[] {
  return readPeople(db).flatMap((person) =>
    person.role
      ? [
          {
            id: person.id,
            email: person.email,
            role: person.role,
            group: person.group,
            active: person.status === 'ACTIVE',
            sealed: keys.identities[person.id] !== undefined && keys.dekWraps[person.id] !== undefined,
          },
        ]
      : [],
  )
}

/**
 * The roster version an admin's save should sign, if the people, their roles, groups or access changed since the
 * latest one, folding in redeemed invites. Signing is asynchronous, so the plan is applied only if the database still
 * derives the same members ({@link applyRosterPlan}).
 */
async function planRoster(vault: OpenVault & { keys: KeysSession }, now: string): Promise<RosterPlan | null> {
  const { db, keys } = vault
  const latest = await latestRosterDoc(db)
  if (!latest || latest.version !== keys.roster.version) throw new CorruptRecordError()
  const bindings = new Map<string, KeyBinding>()
  for (const binding of readBindings(db) ?? []) {
    const invited = latest.members.find((member) => member.id === binding.memberId)
    if (await bindingRedeems(binding, invited, keys.vaultId)) bindings.set(binding.memberId, binding)
  }
  const members = nextRosterMembers({ latest, bindings, people: rosterCandidates(db, keys), invites: rosterInvites(db) })
  if (!members) return null
  const doc = await signRoster(
    { type: 'roster', suite: SUITE, vaultId: keys.vaultId, version: latest.version + 1, prev: keys.roster.hash, epoch: keys.epoch, issuedAt: now, issuedBy: keys.memberId, members },
    keys.identity.sigPriv,
  )
  return { doc, hash: await rosterHash(doc), members, bindings }
}

/**
 * Synchronous, so nothing can change the database between the check and the image the caller copies right after:
 * returns false when the people changed while the plan was signed. Deletes the bindings the new version folded in or
 * no longer names.
 */
function applyRosterPlan(vault: OpenVault & { keys: KeysSession }, plan: RosterPlan | null, latest: RosterDoc): boolean {
  const { db, keys } = vault
  const members = nextRosterMembers({ latest, bindings: plan?.bindings ?? new Map(), people: rosterCandidates(db, keys), invites: rosterInvites(db) })
  if (plan === null ? members !== null : members === null || canonicalize(members) !== canonicalize(plan.members)) return false
  const current = plan?.doc.members ?? latest.members
  const stale = (readBindings(db) ?? []).filter(
    (binding) => !current.some((member) => member.id === binding.memberId && member.status === 'invited' && member.inviteSigPub === binding.inviteSigPub),
  )
  db.withTransaction(() => {
    if (plan) db.exec('INSERT INTO roster_versions (version, hash, doc) VALUES (?, ?, ?)', [plan.doc.version, plan.hash, canonicalize(plan.doc)])
    for (const binding of stale) deleteBinding(db, binding.memberId)
  })
  if (plan) keys.roster = { version: plan.doc.version, hash: plan.hash }
  return true
}

const ROSTER_ATTEMPTS = 3

/**
 * Seals an open per-person-keys vault into a version 3 record: an admin's save first signs a new roster version if
 * anything about the people changed; the body is re-encrypted where it changed (everything with `full`), and the
 * header is signed by the person saving. The session takes the new chunk state only once the record is written
 * (`commitSealed`).
 */
export async function sealKeysVault(vault: OpenVault & { keys: KeysSession }, options: { full?: boolean } = {}): Promise<KeysRecord> {
  const { db, keys } = vault
  const now = Date.now()
  observeClock(now)
  recordClock(db, now)
  const updatedAt = new Date().toISOString()
  const admin = canUser(vault.user, Permission.MANAGE_USERS) && vault.user.roleName === 'Admin'
  let sealing: ReturnType<typeof sealChunkedBody> | null = null
  let schemaVersion = 0
  let audit: ReturnType<typeof auditHead> | undefined
  for (let attempt = 0; sealing === null; attempt += 1) {
    if (attempt === ROSTER_ATTEMPTS) throw new ValidationError('SAVE_BUSY')
    const latest = admin ? await latestRosterDoc(db) : null
    const plan = admin ? await planRoster(vault, updatedAt) : null
    // From here to the image copy nothing awaits, so the roster, the image and the audit head describe one state.
    if (latest && !applyRosterPlan(vault, plan, latest)) continue
    compactIfSparse(db)
    sealing = sealChunkedBody(db, vault.dek, { vaultId: keys.vaultId, epoch: keys.epoch }, keys.chunks, { full: options.full })
    schemaVersion = readSchemaVersion(db)
    audit = auditHead(db)
  }
  const { body, state } = await sealing
  const unsigned = keysRecordFromSession({
    grants: vault.grants,
    schemaVersion,
    createdAt: vault.createdAt,
    updatedAt,
    ...(audit ? { audit } : {}),
    keys: headerOf(keys, { by: keys.memberId, alg: 'Ed25519', value: bytesToBase64(new Uint8Array(64)) }),
    body,
  })
  const record: KeysRecord = { ...unsigned, keys: { ...unsigned.keys, sig: await signHeader(unsigned, keys.memberId, keys.identity.sigPriv) } }
  rememberSealed(record, state)
  return record
}

/** Creates a new vault with per-person keys (design 4.1): the founder's identity, a fresh DEK, and roster version 1. */
export async function createKeysVault(input: SetupInput): Promise<{ vault: OpenVault & { keys: KeysSession }; record: KeysRecord }> {
  await assertSuite()
  const email = normalizeEmail(input.email)
  assertEmail(email)
  const displayName = assertDisplayName(input.displayName)
  await assertNewPassword(input.password, { email, vaultName: displayName })
  if (!isCurrency(input.currency)) throw new ValidationError('CURRENCY')

  const db = await SqlDatabase.openEmpty()
  try {
    migrate(db, { appVersion: APP_VERSION, migrations: KEYS_MIGRATIONS })
    seedRoles(db)
    seedCategories(db)
    db.exec('INSERT INTO groups (name) VALUES (?)', [displayName])
    const memberId = crypto.randomUUID()
    const vaultId = crypto.randomUUID()
    const secret = await generateIdentitySecret()
    let blob: IdentityBlob
    let identity: IdentityKeys
    try {
      blob = await sealIdentity(secret, { vaultId, memberId, email, password: input.password })
      identity = await importIdentity(secret)
    } finally {
      wipeSecret(secret)
    }
    const dek = await generateDek()
    const wrap = await wrapDekTo(dek, identity.encPub, { vaultId, epoch: 1, memberId })
    const createdAt = new Date().toISOString()
    const founder = { memberId, sigPub: identity.sigPub, fingerprint: await fingerprintOf(identity.sigPub) }
    const roster = await signRoster(
      {
        type: 'roster',
        suite: SUITE,
        vaultId,
        version: 1,
        prev: null,
        epoch: 1,
        issuedAt: createdAt,
        issuedBy: memberId,
        members: [{ id: memberId, email, role: 'Admin', group: null, status: 'active', encPub: identity.encPub, sigPub: identity.sigPub }],
      },
      identity.sigPriv,
    )
    let rosterHash = ''
    db.exec('BEGIN')
    try {
      db.exec(
        `INSERT INTO users (id, email, password_hash, salt, role_id, group_id)
         VALUES (?, ?, '', '', (SELECT id FROM roles WHERE name = 'Admin'), NULL)`,
        [memberId, email],
      )
      setSetting(db, 'currency', input.currency)
      setSetting(db, 'vault_name', displayName)
      setSetting(db, 'vault_created_at', createdAt)
      rosterHash = await appendRosterDoc(db, roster)
      writeAudit(db, memberId, 'VAULT_CREATED', 'vault', 'primary', { email, appVersion: APP_VERSION, keys: true, founderFingerprint: founder.fingerprint })
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    const user = loadUserById(db, memberId)
    if (!user) throw new Error('Admin user was not created')
    const keys: KeysSession = {
      vaultId,
      epoch: 1,
      founder,
      memberId,
      identity,
      identities: { [memberId]: blob },
      dekWraps: { [memberId]: wrap },
      roster: { version: 1, hash: rosterHash },
      chunks: null,
      // The person who creates the vault is its founder: there is nothing to compare yet.
      firstSeen: true,
    }
    const vault: OpenVault & { keys: KeysSession } = {
      db,
      dek,
      wraps: [],
      grants: [],
      user,
      currency: input.currency,
      vaultName: displayName,
      createdAt,
      lastBackupAt: null,
      needsSave: false,
      keys,
    }
    const record = await sealKeysVault(vault)
    return { vault, record }
  } catch (error) {
    db.close()
    throw error
  }
}

/** Opens a record 3 body with the DEK and checks its schema. The caller owns the returned handle. */
export async function openKeysDatabase(record: KeysRecord, dek: CryptoKey): Promise<{ db: SqlDatabase; chunks: Awaited<ReturnType<typeof openChunkedBody>>['state'] }> {
  const { db, state } = await openChunkedBody(record.body, dek, { vaultId: record.keys.vaultId, epoch: record.keys.epoch })
  try {
    await assertKnownSchema(db, readSchemaVersion(db), KEYS_SCHEMA_VERSION)
    if (readSchemaVersion(db) !== KEYS_SCHEMA_VERSION) throw new CorruptRecordError()
    syncRolePermissions(db)
    return { db, chunks: state }
  } catch (error) {
    db.close()
    throw error
  }
}

export type KeysUnlockOptions = { acceptRollback?: boolean }

/**
 * Signs in to a version 3 record (design 4.3): the person's sealed identity opens with their password (Argon2id), it
 * unwraps the epoch DEK, the DEK opens the chunked body, and the checks of 3.8 run before any session exists.
 */
export async function unlockKeysVault(record: KeysRecord, email: string, password: string, options: KeysUnlockOptions = {}, now = new Date()): Promise<OpenVault & { keys: KeysSession }> {
  const normalized = normalizeEmail(email)
  const { keys } = record
  const blob = Object.values(keys.identities).find((item) => item.email.toLowerCase() === normalized)
  if (!blob) {
    await spendIdentityWork(password)
    throw new AuthError()
  }
  let identity: IdentityKeys
  try {
    identity = await unsealIdentity(blob, keys.vaultId, password)
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AuthError()
  }
  const memberId = blob.memberId
  const wrap = keys.dekWraps[memberId]
  if (!wrap) throw new KeysBlockedError('KEYS_REMOVED')
  if (wrap.epoch !== keys.epoch) throw new KeysBlockedError('KEYS_EPOCH_MISMATCH')
  let dek: CryptoKey
  try {
    dek = await unwrapDekWith(wrap, identity, { vaultId: keys.vaultId, epoch: keys.epoch, memberId })
  } catch {
    throw new CorruptRecordError()
  }
  const { db, chunks } = await openKeysDatabase(record, dek)
  try {
    const verified = await verifyKeysVault(record, db, { memberId, encPub: identity.encPub, sigPub: identity.sigPub }, options)
    const user = loadUserById(db, memberId)
    if (!user || user.email !== normalized) throw new KeysBlockedError('KEYS_ROSTER_BROKEN')
    const session: KeysSession = {
      vaultId: keys.vaultId,
      epoch: keys.epoch,
      founder: { ...keys.founder },
      memberId,
      identity,
      identities: structuredClone(keys.identities),
      dekWraps: structuredClone(keys.dekWraps),
      roster: { ...keys.roster },
      chunks,
      firstSeen: verified.firstSeen,
    }
    const vault = buildOpenVault(record, { db, dek, wraps: [], user, needsSave: false }, now)
    vault.keys = session
    if (verified.rolledBack) {
      writeAudit(db, memberId, 'ROSTER_ROLLBACK_ACCEPTED', 'vault', 'primary', { version: verified.latest.version })
      vault.needsSave = true
    }
    return vault as OpenVault & { keys: KeysSession }
  } catch (error) {
    db.close()
    throw error
  }
}

/** The password check of a v2 member: their sealed identity must open with it. */
export async function verifyKeysPassword(vault: OpenVault & { keys: KeysSession }, password: string): Promise<void> {
  const blob = vault.keys.identities[vault.keys.memberId]
  if (!blob) throw new AuthError()
  try {
    wipeSecret(await openIdentitySecret(blob, vault.keys.vaultId, password))
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AuthError()
  }
}

/** Re-seals the person's own identity under a new password (design 4.6): no roster change and no admin needed. */
export async function resealIdentity(vault: OpenVault & { keys: KeysSession }, current: string, next: string): Promise<IdentityBlob> {
  const { keys } = vault
  const blob = keys.identities[keys.memberId]
  if (!blob) throw new AuthError()
  let secret
  try {
    secret = await openIdentitySecret(blob, keys.vaultId, current)
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AuthError()
  }
  try {
    return await sealIdentity(secret, { vaultId: keys.vaultId, memberId: keys.memberId, email: blob.email, password: next })
  } finally {
    wipeSecret(secret)
  }
}

/** The invites a record carries, for a session opened from it. */
export { grantsFromRecord }
