import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { en } from '../../src/i18n/en'
import { permissionsForRole } from '../../src/rbac'
import { AUDIT_POLICY, auditActionAllowed, isAuditAction } from '../../src/rbac/audit-policy'
// @ts-expect-error The recovery tool is plain JavaScript without type declarations.
import { AUDIT_POLICY as TOOL_POLICY, ROLE_PERMISSIONS as TOOL_ROLES } from '../../tools/moliya-decrypt.mjs'

const ROLES = ['Admin', 'Manager', 'Viewer'] as const

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

describe('the audit policy', () => {
  it('lists exactly the actions the audit log has labels for', () => {
    const labelled = [...Object.keys(en.audit.actions), ...Object.keys(en.securityAudit)].sort()
    expect(Object.keys(AUDIT_POLICY).sort()).toEqual(labelled)
  })

  it('covers every action the app writes', () => {
    const written = new Set<string>()
    for (const file of sources(resolve(__dirname, '../../src'))) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/writeAudit\(\s*[^,]+,\s*[^,]+,\s*'([A-Z_]+)'/g)) written.add(match[1])
      // Actions picked by grantAuditAction and the 1.x upgrade's revocation.
      if (file.endsWith('grant-store.ts')) for (const match of text.matchAll(/[A-Z]+: '([A-Z_]+)'/g)) written.add(match[1])
      for (const match of text.matchAll(/'(INVITE_REVOKED|RESET_REVOKED)'/g)) written.add(match[1])
    }
    expect(written.size).toBeGreaterThan(30)
    for (const action of written) expect(isAuditAction(action), action).toBe(true)
  })

  it('is the one the recovery tool applies, with the same role permissions', () => {
    expect(TOOL_POLICY).toEqual(AUDIT_POLICY)
    expect(TOOL_ROLES).toEqual({ Manager: permissionsForRole('Manager'), Viewer: permissionsForRole('Viewer') })
  })

  it('allows each role exactly what its permissions allow', () => {
    for (const [action, rule] of Object.entries(AUDIT_POLICY)) {
      for (const role of ROLES) {
        const someoneElse = { action, actor: 'm1', entityType: 'user', entityId: 'm2' }
        const allowed = role === 'Admin' || ('anyone' in rule && rule.anyone === true) || ('permission' in rule && permissionsForRole(role).includes(rule.permission))
        expect(auditActionAllowed(role, someoneElse), `${role} ${action}`).toBe(allowed)
        const self = { action, actor: 'm1', entityType: 'user', entityId: 'm1' }
        expect(auditActionAllowed(role, self), `${role} ${action} on themselves`).toBe(allowed || ('self' in rule && rule.self === true))
      }
    }
  })

  it('lets only an admin write an action it does not know, and nobody pass a name off the prototype', () => {
    expect(auditActionAllowed('Admin', { action: 'ADDED_LATER', actor: 'a', entityType: null, entityId: null })).toBe(true)
    for (const role of ['Manager', 'Viewer'] as const) {
      for (const action of ['ADDED_LATER', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
        expect(auditActionAllowed(role, { action, actor: 'a', entityType: null, entityId: null }), `${role} ${action}`).toBe(false)
      }
    }
  })

  it('keeps record changes to the roles that may change records', () => {
    expect(auditActionAllowed('Manager', { action: 'TRANSACTION_UPDATED', actor: 'a', entityType: 'transaction', entityId: 't' })).toBe(true)
    expect(auditActionAllowed('Viewer', { action: 'TRANSACTION_UPDATED', actor: 'a', entityType: 'transaction', entityId: 't' })).toBe(false)
    expect(auditActionAllowed('Manager', { action: 'USER_UPDATED', actor: 'a', entityType: 'user', entityId: 'a' })).toBe(false)
    expect(auditActionAllowed('Viewer', { action: 'TOTP_CLEARED', actor: 'a', entityType: 'user', entityId: 'a' })).toBe(true)
    expect(auditActionAllowed('Viewer', { action: 'TOTP_CLEARED', actor: 'a', entityType: 'user', entityId: 'b' })).toBe(false)
  })
})
