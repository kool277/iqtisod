import { expect } from 'vitest'
import type { VaultRecord } from '../../src/db/envelope'
import type { SqlDatabase } from '../../src/db/sqlite'
import type { OpenVault } from '../../src/domain/types'
import { createVault, sealVault } from '../../src/services/auth.service'
import { listGroups } from '../../src/services/group.service'
import { createUser } from '../../src/services/user.service'
import { contains, open, track, utf8 } from './safes'

export const VAULT_NAME = 'Maple House'
export const OWNER = { email: 'keeper@maple.test', password: 'Quiet river lantern 42' }
export const MANAGER = { email: 'steward@maple.test', password: 'Amber meadow compass 77' }
export const MEMBER = { email: 'member@maple.test', password: 'Velvet orchard signal 31' }
export const INVITEE = { email: 'dilnoza.rahimova@maple.test', password: 'Silver harbour quilt 19' }
export const NEW_PASSWORD = 'Copper kettle horizon 58'

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE

export type Household = { record: VaultRecord; groupId: number; managerId: string; memberId: string }

/** Admin (OWNER), a Manager and a Viewer (MEMBER) in the vault's only group. */
export async function buildAccessHousehold(): Promise<Household> {
  const { vault } = await createVault({ email: OWNER.email, password: OWNER.password, displayName: VAULT_NAME, currency: 'USD' })
  track(vault)
  const groupId = listGroups(vault)[0].id
  await createUser(vault, { email: MANAGER.email, password: MANAGER.password, roleName: 'Manager', groupId })
  await createUser(vault, { email: MEMBER.email, password: MEMBER.password, roleName: 'Viewer', groupId })
  return { record: await sealVault(vault), groupId, managerId: userId(vault.db, MANAGER.email), memberId: userId(vault.db, MEMBER.email) }
}

export function openAs(record: VaultRecord, who: { email: string; password: string }, password = who.password): Promise<OpenVault> {
  return open(record, who.email, password)
}

export function userId(db: SqlDatabase, email: string): string {
  return String(db.queryValue('SELECT id FROM users WHERE email = ?', [email]))
}

export type AuditRow = { actorId: string | null; action: string; entityType: string | null; entityId: string | null; details: unknown }

export function auditRows(db: SqlDatabase): AuditRow[] {
  return db.query('SELECT actor_id, action, entity_type, entity_id, details FROM audit_logs ORDER BY seq').map((row) => ({
    actorId: row.actor_id == null ? null : String(row.actor_id),
    action: String(row.action),
    entityType: row.entity_type == null ? null : String(row.entity_type),
    entityId: row.entity_id == null ? null : String(row.entity_id),
    details: row.details == null ? null : (JSON.parse(String(row.details)) as unknown),
  }))
}

export function auditActions(db: SqlDatabase): string[] {
  return auditRows(db).map((row) => row.action)
}

export function lastAudit(db: SqlDatabase, action: string): AuditRow | undefined {
  return auditRows(db)
    .filter((row) => row.action === action)
    .at(-1)
}

export function grantRowOf(db: SqlDatabase, id: string): Record<string, unknown> | null {
  const row = db.queryOne('SELECT * FROM access_grants WHERE id = ?', [id])
  return row ? { ...row } : null
}

export function thrownCode(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code
  }
  return undefined
}

function variants(secret: string): string[] {
  const compact = secret.replace(/[\s-]/g, '')
  return [...new Set([secret, compact, secret.toLowerCase(), compact.toLowerCase()])].filter((value) => value.length >= 6)
}

/**
 * Asserts no secret (code, TOTP secret, recovery code, password) is in any audit detail, in any grant column
 * other than the verifier, or anywhere in the raw database bytes.
 */
export function expectNoSecretsStored(db: SqlDatabase, secrets: string[]): void {
  const needles = secrets.flatMap(variants)
  const details = db.query('SELECT action, details FROM audit_logs').map((row) => `${String(row.action)} ${String(row.details ?? '')}`)
  const grantText = db.query('SELECT * FROM access_grants').map((row) => {
    const { code_verifier: verifier, ...rest } = row
    expect(String(verifier)).toMatch(/^[0-9a-f]{64}$/)
    return JSON.stringify(rest)
  })
  const bytes = db.export()
  for (const needle of needles) {
    for (const line of details) expect(line.includes(needle), `audit leaks ${needle}: ${line}`).toBe(false)
    for (const line of grantText) expect(line.includes(needle), `grant row leaks ${needle}`).toBe(false)
    expect(contains(bytes, utf8(needle)), `database bytes leak ${needle}`).toBe(false)
  }
}
