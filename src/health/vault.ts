import { auditHead, compareAuditHead, verifyAuditChain, type AuditHead, type AuditHeadProblem } from '../db/audit-chain'
import { readSchemaVersion } from '../db/migrations'
import { getSetting } from '../db/settings'
import type { OpenVault } from '../domain/types'
import { deviceClockFloor } from '../lib/device-clock'
import { Permission, canUser } from '../rbac'
import { CLOCK_KEY, clockFloor } from '../services/grant-store'
import { hasSignInCheck } from '../services/totp.service'
import { usersOverview } from '../services/user.service'

export type SaveStateName = 'saved' | 'saving' | 'dirty' | 'error' | 'conflict'

/** What the signed-in person may learn about the open vault. Admin-only parts are null for everyone else. */
export type VaultFacts = {
  schemaVersion: number
  bytes: number
  saveState: SaveStateName
  lastBackupAt: string | null
  hasRecords: boolean
  canBackup: boolean
  canReadAudit: boolean
  canManageUsers: boolean
  archives: number | null
  chain: { ok: boolean; entries: number; brokenAt: number | null } | null
  head: number | null
  /** The furthest entry this browser saw before, and how the log compares with it. */
  seen: { seq: number; problem: AuditHeadProblem | null } | null
  /** How the log compares with the head the stored record carries. */
  recorded: AuditHeadProblem | null
  clockFloor: number | null
  clockMarks: { vault: string | null; device: string | null } | null
  totp: boolean
  mustChange: boolean
  weak: boolean
  members: number | null
  /** Counts only, for people managers. */
  hygiene: { noTotp: number; mustChange: number; noAccess: number; expiredCodes: number; legacyWraps: number } | null
}

export type VaultContextFacts = {
  saveState: SaveStateName
  weak: boolean
  archives: number | null
  deviceMark: AuditHead | null
  recordedHead: AuditHead | null
}

export function collectVaultFacts(vault: OpenVault, context: VaultContextFacts): VaultFacts {
  const { db, user } = vault
  const canReadAudit = canUser(user, Permission.READ_AUDIT)
  const canManageUsers = canUser(user, Permission.MANAGE_USERS)
  const canBackup = canUser(user, Permission.EXPORT_VAULT)
  const chain = canReadAudit ? verifyAuditChain(db) : null
  const device = deviceClockFloor()
  return {
    schemaVersion: readSchemaVersion(db),
    bytes: db.sizeBytes(),
    saveState: context.saveState,
    lastBackupAt: canBackup ? vault.lastBackupAt : null,
    hasRecords: Number(db.queryValue('SELECT COUNT(*) FROM transactions') ?? 0) > 0,
    canBackup,
    canReadAudit,
    canManageUsers,
    archives: canBackup ? context.archives : null,
    chain: chain ? { ok: chain.ok, entries: chain.entries, brokenAt: chain.brokenAt } : null,
    head: canReadAudit ? auditHead(db).seq : null,
    seen: canReadAudit && context.deviceMark ? { seq: context.deviceMark.seq, problem: compareAuditHead(db, context.deviceMark) } : null,
    recorded: canReadAudit && context.recordedHead ? compareAuditHead(db, context.recordedHead) : null,
    clockFloor: clockFloor(db),
    clockMarks: canManageUsers ? { vault: getSetting(db, CLOCK_KEY), device: device === null ? null : new Date(device).toISOString() } : null,
    totp: hasSignInCheck(db, user.id),
    mustChange: user.mustChangePassword,
    weak: context.weak,
    members: canManageUsers ? vault.wraps.length : null,
    hygiene: canManageUsers ? hygieneOf(vault) : null,
  }
}

function hygieneOf(vault: OpenVault): NonNullable<VaultFacts['hygiene']> {
  const overview = usersOverview(vault)
  return {
    noTotp: overview.active - overview.totpOn,
    mustChange: overview.mustChange,
    noAccess: overview.noAccess,
    expiredCodes: overview.openCodes.filter((code) => code.expired).length,
    legacyWraps: overview.legacyWraps,
  }
}
