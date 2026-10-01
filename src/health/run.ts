import { listArchives } from '../db/storage'
import type { OpenVault } from '../domain/types'
import { readAuditMark } from '../lib/audit-mark'
import { currentHostname } from '../lib/origin-move'
import { BUILD } from '../lib/version'
import { Permission, canUser } from '../rbac'
import { collectAppFacts, collectBrowserFacts, collectRatesFacts, collectSecurityFacts, collectStorageFacts, type HealthGlobals } from './collect'
import { evaluateHealth } from './evaluate'
import type { HealthResult } from './model'
import { collectVaultFacts, type SaveStateName } from './vault'

export type VaultAccess = {
  query: <T>(fn: (vault: OpenVault) => T) => T
  saveState: SaveStateName
  weak: boolean
}

/** Runs every check that applies: the vault checks only for someone signed in, and admin rows only for admins. */
export async function runHealthChecks(vault: VaultAccess | null, now = Date.now()): Promise<HealthResult[]> {
  const g = globalThis as unknown as HealthGlobals
  const dev = import.meta.env.DEV
  const base = document.baseURI
  const fetcher = (input: URL, init?: RequestInit) => fetch(input, init)
  const [storage, app, rates] = await Promise.all([
    collectStorageFacts(g),
    collectAppFacts(BUILD, fetcher, base, dev),
    collectRatesFacts(g, fetcher, base, now),
  ])
  let vaultFacts = null
  if (vault) {
    const canBackup = vault.query((open) => canUser(open.user, Permission.EXPORT_VAULT))
    const archives = canBackup ? await listArchives().then((items) => items.length, () => null) : null
    const recordedHead = typeof storage.stored === 'object' ? storage.stored.audit : null
    try {
      vaultFacts = vault.query((open) => collectVaultFacts(open, { saveState: vault.saveState, weak: vault.weak, archives, deviceMark: readAuditMark(), recordedHead }))
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
  })
}
