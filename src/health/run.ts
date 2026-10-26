import { suiteSupported } from '../crypto/suite'
import { listArchives } from '../db/storage'
import { KEYS_RECORD_VERSION } from '../db/versions'
import { keysEnabled } from '../lib/flags'
import { measureCapacity } from '../lib/capacity'
import type { OpenVault } from '../domain/types'
import { readAuditMark } from '../lib/audit-mark'
import { currentHostname } from '../lib/origin-move'
import { BUILD } from '../lib/version'
import { Permission, canUser } from '../rbac'
import { collectAppFacts, collectBrowserFacts, collectRatesFacts, collectSecurityFacts, collectStorageFacts, type HealthGlobals } from './collect'
import { evaluateHealth } from './evaluate'
import type { HealthResult } from './model'
import { collectVaultFacts, type AuditSignatureFacts, type SaveStateName } from './vault'

/** The check reads everything inside `query`, before it awaits, so a vault that locks meanwhile is not read. */
async function auditSignatureFacts(vault: VaultAccess, full: boolean): Promise<AuditSignatureFacts | null> {
  if (!vault.query((open) => open.keys !== undefined && canUser(open.user, Permission.READ_AUDIT))) return null
  const { checkVaultAudit } = await import('../services/v2/audit-check')
  const report = await vault.query((open) => {
    const keys = open.keys
    return keys ? checkVaultAudit(open as OpenVault & { keys: typeof keys }, { full }) : null
  })
  if (!report) return null
  const problems = [...report.problems.keys()]
  return { checkedFrom: report.start, signed: report.verified, problems: problems.length, firstProblem: problems.length > 0 ? Math.min(...problems) : null, signedFrom: report.signedFrom }
}

export type VaultAccess = {
  query: <T>(fn: (vault: OpenVault) => T) => T
  saveState: SaveStateName
  weak: boolean
}

/**
 * Runs every check that applies: the vault checks only for someone signed in, and admin rows only for admins. The
 * audit signatures are checked since this browser's last check, or all of them with `auditFull`.
 */
export async function runHealthChecks(vault: VaultAccess | null, now = Date.now(), options: { auditFull?: boolean } = {}): Promise<HealthResult[]> {
  const g = globalThis as unknown as HealthGlobals
  const dev = import.meta.env.DEV
  const base = document.baseURI
  const fetcher = (input: URL, init?: RequestInit) => fetch(input, init)
  const [storage, app, rates, capacity] = await Promise.all([
    collectStorageFacts(g),
    collectAppFacts(BUILD, fetcher, base, dev),
    collectRatesFacts(g, fetcher, base, now),
    measureCapacity().catch(() => undefined),
  ])
  // Only where per-person keys matter: a build that creates them, or a stored vault that uses them.
  const keysMatter = keysEnabled() || (typeof storage.stored === 'object' && storage.stored.version === KEYS_RECORD_VERSION)
  const keysSuite = keysMatter ? await suiteSupported() : null
  let vaultFacts = null
  if (vault) {
    const canBackup = vault.query((open) => canUser(open.user, Permission.EXPORT_VAULT))
    const archives = canBackup ? await listArchives().then((items) => items.length, () => null) : null
    const recordedHead = typeof storage.stored === 'object' ? storage.stored.audit : null
    try {
      const signatures = await auditSignatureFacts(vault, options.auditFull === true)
      vaultFacts = vault.query((open) => collectVaultFacts(open, { saveState: vault.saveState, weak: vault.weak, archives, deviceMark: readAuditMark(), recordedHead, signatures }))
    } catch {
      // The vault locked while the checks ran.
      vaultFacts = null
    }
  }
  return evaluateHealth({
    now,
    dev,
    browser: collectBrowserFacts(g),
    storage,
    app,
    rates,
    security: collectSecurityFacts(g, currentHostname()),
    vault: vaultFacts,
    capacity,
    keysSuite,
  })
}
