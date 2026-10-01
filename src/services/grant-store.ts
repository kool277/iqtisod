import type { SqlDatabase, SqlValue } from '../db/sqlite'
import type { OpenVault } from '../domain/types'
import { writeAudit } from './audit.service'

export type GrantEndReason = 'USED' | 'REVOKED' | 'EXPIRED' | 'REPLACED'

export type GrantRow = {
  id: string
  kind: 'INVITE' | 'RESET'
  email: string
  userId: string | null
  roleId: number | null
  groupId: number | null
  codeVerifier: string
  stopOldPassword: boolean
  createdBy: string | null
  createdAt: string
  expiresAt: string
  endedAt: string | null
  endedReason: GrantEndReason | null
}

const optStr = (value: SqlValue): string | null => (value == null ? null : String(value))
const optNum = (value: SqlValue): number | null => (value == null ? null : Number(value))

export function toGrantRow(row: Record<string, SqlValue>): GrantRow {
  return {
    id: String(row.id),
    kind: row.kind === 'RESET' ? 'RESET' : 'INVITE',
    email: String(row.email),
    userId: optStr(row.user_id),
    roleId: optNum(row.role_id),
    groupId: optNum(row.group_id),
    codeVerifier: String(row.code_verifier),
    stopOldPassword: Number(row.stop_old_password) === 1,
    createdBy: optStr(row.created_by),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    endedAt: optStr(row.ended_at),
    endedReason: (optStr(row.ended_reason) as GrantEndReason | null) ?? null,
  }
}

export function grantRow(db: SqlDatabase, id: string): GrantRow | null {
  const row = db.queryOne('SELECT * FROM access_grants WHERE id = ?', [id])
  return row ? toGrantRow(row) : null
}

export function openGrantRows(db: SqlDatabase): GrantRow[] {
  return db.query('SELECT * FROM access_grants WHERE ended_at IS NULL ORDER BY created_at').map(toGrantRow)
}

export function grantAuditAction(kind: GrantRow['kind'], event: 'CREATED' | 'REVOKED' | 'EXPIRED' | 'USED'): string {
  if (kind === 'INVITE') return { CREATED: 'INVITE_CREATED', REVOKED: 'INVITE_REVOKED', EXPIRED: 'INVITE_EXPIRED', USED: 'INVITE_ACCEPTED' }[event]
  return { CREATED: 'RESET_ISSUED', REVOKED: 'RESET_REVOKED', EXPIRED: 'INVITE_EXPIRED', USED: 'RESET_COMPLETED' }[event]
}

export function endGrant(db: SqlDatabase, id: string, reason: GrantEndReason, by: string | null, at: string): boolean {
  db.exec('UPDATE access_grants SET ended_at = ?, ended_reason = ?, ended_by = ? WHERE id = ? AND ended_at IS NULL', [at, reason, by, id])
  return Number(db.queryValue('SELECT changes()') ?? 0) === 1
}

/**
 * Wraps the envelope will hold once every open code is used: current wraps, plus one per open invite, plus one per
 * open reset that stopped the old password (its wrap comes back when the code is used).
 */
export function committedWraps(vault: OpenVault): number {
  const open = openGrantRows(vault.db)
  const invites = open.filter((grant) => grant.kind === 'INVITE').length
  const resets = open.filter((grant) => grant.kind === 'RESET' && grant.userId !== null && !vault.wraps.some((wrap) => wrap.userId === grant.userId)).length
  return vault.wraps.length + invites + resets
}

export function dropEnvelopeGrant(vault: OpenVault, id: string): void {
  vault.grants = vault.grants.filter((grant) => grant.id !== id)
}

/** Ends expired grants and drops envelope wraps that can no longer be redeemed. Returns how many things changed. */
export function sweepGrants(vault: OpenVault, now = new Date()): number {
  const at = now.toISOString()
  let changed = 0
  vault.db.withTransaction(() => {
    for (const row of openGrantRows(vault.db)) {
      const inEnvelope = vault.grants.some((grant) => grant.id === row.id)
      if (row.expiresAt > at && inEnvelope) continue
      if (endGrant(vault.db, row.id, 'EXPIRED', null, at)) {
        writeAudit(vault.db, null, 'INVITE_EXPIRED', 'grant', row.id, { kind: row.kind, email: row.email, expiresAt: row.expiresAt })
        changed += 1
      }
    }
  })
  const before = vault.grants.length
  vault.grants = vault.grants.filter((grant) => {
    const row = grantRow(vault.db, grant.id)
    return row !== null && row.endedAt === null && row.kind === grant.kind && row.email === grant.email
  })
  return changed + (before - vault.grants.length)
}

export const CLOCK_KEY = 'clock_high_water'
export const CLOCK_TOLERANCE_MS = 5 * 60_000
