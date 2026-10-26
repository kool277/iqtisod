import { generateDek } from '../../crypto/crypto.service'
import { wrapDekTo } from '../../crypto/ecies'
import { generateIdentitySecret, importIdentity, sealIdentity, wipeSecret } from '../../crypto/identity'
import { signRoster } from '../../crypto/roster'
import { fingerprintOf } from '../../crypto/sign'
import { SUITE, assertSuite } from '../../crypto/suite'
import type { KeysRecord } from '../../db/envelope'
import { auditHead } from '../../db/audit-chain'
import { KEYS_MIGRATIONS, assertKnownSchema, migrate, readSchemaVersion } from '../../db/migrations'
import { KEYS_SCHEMA_VERSION, RECORD_VERSION, KEYS_RECORD_VERSION } from '../../db/versions'
import { ForbiddenError, ValidationError } from '../../domain/errors'
import type { OpenVault } from '../../domain/types'
import { APP_VERSION } from '../../lib/version'
import { Permission, canUser } from '../../rbac'
import { writeAudit } from '../audit.service'
import { verifyOwnPassword } from '../auth.service'
import { endGrant, openGrantRows } from '../grant-store'
import { upgradeReinvites } from './reinvites'
import { appendRosterDoc } from './roster-store'
import type { KeysSession } from './session'
import { sealKeysVault } from './vault'

export { upgradeReinvites }

/**
 * The founder upgrade (design 5.2): an admin of a 1.x vault converts it to per-person keys and becomes its founder.
 * Schema 5 is applied, the founder's identity and a fresh DEK are made (the 1.x DEK is never reused), every open 1.x
 * code is ended, every password check value is cleared, and roster version 1 names the founder alone. Everyone else
 * keeps their records but needs a new invite. The returned record holds only the founder's identity and DEK wrap.
 *
 * The open session becomes the upgraded one. If the record cannot be written, the caller must close the session:
 * the database in memory is already upgraded and must not be saved without the archive of the 1.x record.
 */
export async function upgradeToKeys(vault: OpenVault, password: string): Promise<{ vault: OpenVault & { keys: KeysSession }; record: KeysRecord }> {
  if (vault.keys) throw new ValidationError('ALREADY_UPGRADED')
  if (!canUser(vault.user, Permission.MANAGE_USERS) || vault.user.roleName !== 'Admin') throw new ForbiddenError()
  await assertSuite()
  await verifyOwnPassword(vault, password)
  const { db } = vault
  if (readSchemaVersion(db) !== 4) throw new ValidationError('SCHEMA_UNKNOWN')

  const memberId = vault.user.id
  const vaultId = crypto.randomUUID()
  const secret = await generateIdentitySecret()
  let blob
  let identity
  try {
    blob = await sealIdentity(secret, { vaultId, memberId, email: vault.user.email, password })
    identity = await importIdentity(secret)
  } finally {
    wipeSecret(secret)
  }
  const dek = await generateDek()
  const wrap = await wrapDekTo(dek, identity.encPub, { vaultId, epoch: 1, memberId })
  const founder = { memberId, sigPub: identity.sigPub, fingerprint: await fingerprintOf(identity.sigPub) }
  const at = new Date().toISOString()
  const roster = await signRoster(
    {
      type: 'roster',
      suite: SUITE,
      vaultId,
      version: 1,
      prev: null,
      epoch: 1,
      issuedAt: at,
      issuedBy: memberId,
      members: [{ id: memberId, email: vault.user.email, role: 'Admin', group: vault.user.groupId, status: 'active', encPub: identity.encPub, sigPub: identity.sigPub }],
    },
    identity.sigPriv,
  )
  const reinvite = upgradeReinvites(vault)
  migrate(db, { appVersion: APP_VERSION, migrations: KEYS_MIGRATIONS })
  await assertKnownSchema(db, readSchemaVersion(db), KEYS_SCHEMA_VERSION)
  let rosterHash = ''
  // The upgrade's own entries are the first this vault signs: everything before them stays as 1.x wrote it.
  const auditFrom = auditHead(db).seq + 1
  db.exec('BEGIN')
  try {
    for (const grant of openGrantRows(db)) {
      endGrant(db, grant.id, 'REVOKED', memberId, at)
      writeAudit(db, memberId, grant.kind === 'INVITE' ? 'INVITE_REVOKED' : 'RESET_REVOKED', 'grant', grant.id, { email: grant.email, reason: 'UPGRADE' })
    }
    // No 1.x password check value remains: a password alone no longer opens anything in the upgraded vault.
    db.exec("UPDATE users SET password_hash = '', salt = ''")
    rosterHash = await appendRosterDoc(db, roster)
    writeAudit(db, memberId, 'VAULT_UPGRADED', 'vault', 'primary', {
      fromRecord: RECORD_VERSION,
      toRecord: KEYS_RECORD_VERSION,
      founderFingerprint: founder.fingerprint,
      reinvite,
      appVersion: APP_VERSION,
    })
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
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
    firstSeen: true,
    holders: [memberId],
    nextDek: await generateDek(),
    auditFrom,
  }
  const upgraded = vault as OpenVault & { keys: KeysSession }
  upgraded.dek = dek
  upgraded.wraps = []
  upgraded.grants = []
  upgraded.keys = keys
  const record = await sealKeysVault(upgraded)
  return { vault: upgraded, record }
}
