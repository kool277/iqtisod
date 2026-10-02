import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeAudit } from '../../src/services/audit.service'
import { listAudit, AUDIT_PAGE_LIMIT } from '../../src/services/audit-log'
import { ForbiddenError } from '../../src/domain/errors'
import type { OpenVault } from '../../src/domain/types'
import { openLedger } from '../support/exports'

let admin: OpenVault
let viewer: OpenVault

beforeAll(async () => {
  admin = await openLedger('Admin')
  viewer = await openLedger('Viewer')
  for (let index = 0; index < 250; index += 1) writeAudit(admin.db, admin.user.id, 'TRANSACTION_UPDATED', 'transaction', String(index))
})

afterAll(() => {
  admin?.db.close()
  viewer?.db.close()
})

describe('listAudit', () => {
  it('keeps the default of 200 newest entries', () => {
    const rows = listAudit(admin)
    expect(rows).toHaveLength(200)
    expect(rows[0].entityId).toBe('249')
  })

  it('returns more entries for the audit page, newest first', () => {
    const rows = listAudit(admin, AUDIT_PAGE_LIMIT)
    expect(rows.length).toBeGreaterThan(250)
    expect(rows[0].entityId).toBe('249')
  })

  it('clamps odd limits', () => {
    expect(listAudit(admin, 0)).toHaveLength(1)
    expect(listAudit(admin, -5)).toHaveLength(1)
    expect(listAudit(admin, Number.NaN)).toHaveLength(200)
    expect(listAudit(admin, 1.5)).toHaveLength(200)
  })

  it('still refuses readers without the audit permission', () => {
    expect(() => listAudit(viewer, AUDIT_PAGE_LIMIT)).toThrow(ForbiddenError)
  })
})
