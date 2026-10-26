import { KEYS_RECORD_VERSION, KEYS_SCHEMA_VERSION, RECORD_VERSION, SCHEMA_VERSION } from '../db/versions'
import { isStale } from '../domain/fx'
import { growthBudget, type Capacity } from '../lib/capacity'
import { LIMITS, formatBytes, restoreLimitBytes } from '../lib/limits'
import { isNewAddress, isOldAddress } from '../lib/origin-move'
import { BACKUP_STALE_DAYS } from '../services/backup.service'
import { CLOCK_TOLERANCE_MS } from '../services/grant-store'
import { MAX_ARCHIVES } from '../db/storage'
import type { AppFacts, BrowserFacts, RatesFacts, SecurityFacts, StorageFacts } from './collect'
import { result, type HealthResult } from './model'
import type { VaultFacts } from './vault'

const MIB = 1024 * 1024
const DAY_MS = 24 * 60 * 60 * 1000
/** Less room than this is offered to private windows in Chromium and Safari; normal windows get far more. */
export const PRIVATE_QUOTA_HINT_BYTES = 400 * MIB
export const MEMBER_WARN_SHARE = 0.9

export function megabytes(bytes: number): string {
  const value = bytes / MIB
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} MB`
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** `YYYY-MM-DD HH:MM` in the device's time zone, or the input when it is not a date. */
export function stamp(value: string | number | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return typeof value === 'string' ? value : undefined
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function localDay(now: number): string {
  const date = new Date(now)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function browserChecks(facts: BrowserFacts): HealthResult[] {
  const { trustedTypes: tt } = facts
  return [
    facts.subtle ? result('crypto', 'pass', 'ok') : result('crypto', 'fail', 'missing'),
    facts.indexedDb ? result('indexedDb', 'pass', 'ok') : result('indexedDb', 'fail', 'missing'),
    facts.wasm ? result('wasm', 'pass', 'ok') : result('wasm', 'fail', 'missing'),
    facts.locks ? result('locks', 'pass', 'ok') : result('locks', 'warn', 'missing'),
    facts.isolated && facts.sharedArrayBuffer ? result('isolation', 'pass', 'ok') : result('isolation', 'warn', 'missing', { action: 'reload' }),
    facts.serviceWorker === 'controlled'
      ? result('serviceWorker', 'pass', 'ok')
      : facts.isolated
        ? result('serviceWorker', 'info', 'headers')
        : facts.serviceWorker === 'uncontrolled'
          ? result('serviceWorker', 'warn', 'notControlling', { action: 'reload' })
          : result('serviceWorker', 'warn', 'unsupported'),
    facts.secureContext ? result('secureContext', 'pass', 'ok') : result('secureContext', 'fail', 'insecure'),
    !tt.policy ? result('trustedTypes', 'info', 'dev') : tt.supported && tt.defaultPolicy ? result('trustedTypes', 'pass', 'ok') : result('trustedTypes', 'info', 'unsupported'),
    facts.cookies ? result('cookies', 'pass', 'ok') : result('cookies', 'warn', 'blocked'),
  ]
}

export function storageChecks(facts: StorageFacts, capacity?: Capacity): HealthResult[] {
  const results: HealthResult[] = []
  results.push(
    facts.quota === null
      ? result('privateMode', 'info', 'unknown')
      : facts.quota < PRIVATE_QUOTA_HINT_BYTES
        ? result('privateMode', 'warn', 'likely', { facts: { quota: megabytes(facts.quota) } })
        : result('privateMode', 'pass', 'ok'),
  )
  results.push(facts.write === 'ok' ? result('storageWrite', 'pass', 'ok') : result('storageWrite', 'fail', facts.write))
  if (facts.quota === null || facts.usage === null) {
    results.push(result('quota', 'info', 'unknown'))
  } else {
    const free = Math.max(0, facts.quota - facts.usage)
    // Full size is as large as receipts may make the vault on this device (48 MiB until that is measured), and the
    // earlier copies kept beside it can each be as large.
    const fullSize = growthBudget(capacity ?? null).budgetBytes
    const shown = { usage: megabytes(facts.usage), quota: megabytes(facts.quota), free: megabytes(free), limit: megabytes(fullSize) }
    results.push(
      free < fullSize
        ? result('quota', 'fail', 'full', { facts: shown })
        : free < (MAX_ARCHIVES + 1) * fullSize
          ? result('quota', 'warn', 'low', { facts: shown })
          : result('quota', 'pass', 'ok', { facts: shown }),
    )
  }
  if (capacity) results.push(capacityCheck(capacity, facts.canPersist))
  results.push(
    facts.persisted === true
      ? result('persisted', 'pass', 'ok')
      : facts.persisted === false
        ? result('persisted', 'warn', 'notGranted', facts.canPersist ? { action: 'persist' } : {})
        : result('persisted', 'info', 'unsupported'),
  )
  results.push(facts.localStorage ? result('localStorage', 'pass', 'ok') : result('localStorage', 'warn', 'blocked'))
  const stored = facts.stored
  results.push(
    stored === 'none'
      ? result('storedVault', 'info', 'none')
      : stored === 'unreadable'
        ? result('storedVault', facts.write === 'ok' ? 'fail' : 'warn', 'unreadable')
        : result('storedVault', 'pass', 'present', { facts: { record: stored.version ?? '?', schema: stored.schemaVersion ?? '?', saved: stamp(stored.updatedAt) } }),
  )
  return results
}

/** How large a vault this device can restore and open, and which of its limits decides that. */
export function capacityCheck(capacity: Capacity, canPersist = true): HealthResult {
  const gib = capacity.deviceMemoryBytes / (1024 * MIB)
  const shown = {
    // Rounded down like the restore screens, so both show the same figure.
    vaultLimit: formatBytes(capacity.vaultBytes),
    backupLimit: formatBytes(restoreLimitBytes(capacity.fileBytes)),
    deviceMemory: `${capacity.deviceMemoryReported ? '' : '~'}${Number.isInteger(gib) ? gib : gib.toFixed(1)} GB`,
  }
  if (capacity.limitedBy === 'storage' && capacity.vaultBytes < LIMITS.databaseBudgetBytes) return result('capacity', 'warn', 'low', { facts: shown, ...(capacity.persisted === false && canPersist ? { action: 'persist' as const } : {}) })
  return result('capacity', 'pass', capacity.limitedBy, { facts: shown })
}

export function isUpdateAvailable(facts: AppFacts): boolean {
  const { remote, running } = facts
  return !!remote && typeof remote.version === 'string' && typeof remote.commit === 'string' && (remote.version !== running.version || remote.commit !== running.commit)
}

export function appChecks(facts: AppFacts): HealthResult[] {
  const update = isUpdateAvailable(facts)
  const running = facts.running
  const version = facts.dev
    ? result('version', 'info', 'dev', { facts: { running: running.version } })
    : !facts.reachable
      ? result('version', 'warn', 'offline', { facts: { running: running.version }, action: 'reload' })
      : update
        ? result('version', 'warn', 'update', { facts: { running: running.version, available: facts.remote?.version }, action: 'reload' })
        : result('version', 'pass', 'current', { facts: { running: running.version } })
  const build = result('build', 'info', 'info', {
    facts: { commit: running.commit, built: stamp(running.builtAt), deployed: facts.remote?.builtAt ? stamp(facts.remote.builtAt) : undefined },
  })
  const chunks = !facts.reachable || facts.dev ? result('chunks', 'info', 'unknown') : update ? result('chunks', 'warn', 'stale', { action: 'reload' }) : result('chunks', 'pass', 'ok')
  return [version, build, chunks]
}

export function vaultChecks(facts: VaultFacts, stored: StorageFacts['stored'], now: number, budget = growthBudget(null)): HealthResult[] {
  const results: HealthResult[] = []
  const record = typeof stored === 'object' ? stored : null
  const formatFacts = { record: record?.version ?? '?', schema: facts.schemaVersion, writtenBy: record?.appVersion ?? undefined }
  // Two tracks: 1.x vaults (record 2, schema 4) and per-person-keys vaults (record 3, schema 5). Each is current on its own.
  const keysTrack = record?.version === KEYS_RECORD_VERSION
  const currentRecord = keysTrack ? KEYS_RECORD_VERSION : RECORD_VERSION
  const currentSchema = keysTrack ? KEYS_SCHEMA_VERSION : SCHEMA_VERSION
  if ((record?.version ?? 0) > KEYS_RECORD_VERSION || facts.schemaVersion > currentSchema) results.push(result('format', 'fail', 'newer', { facts: formatFacts }))
  else if (record?.version !== currentRecord || facts.schemaVersion !== currentSchema || (record?.schemaVersion ?? currentSchema) !== currentSchema)
    results.push(result('format', 'info', 'older', { facts: formatFacts }))
  else results.push(result('format', 'pass', 'current', { facts: formatFacts }))

  const sizeFacts = { size: megabytes(facts.bytes), limit: megabytes(budget.budgetBytes) }
  results.push(
    facts.bytes >= budget.budgetBytes
      ? result('size', 'fail', 'full', { facts: sizeFacts })
      : facts.bytes >= budget.warnBytes
        ? result('size', 'warn', 'near', { facts: sizeFacts })
        : result('size', 'pass', 'ok', { facts: sizeFacts }),
  )

  const saved = { saved: stamp(record?.updatedAt) }
  results.push(
    facts.saveState === 'saved'
      ? result('autosave', 'pass', 'saved', { facts: saved })
      : facts.saveState === 'error'
        ? result('autosave', 'fail', 'error', { facts: saved })
        : facts.saveState === 'conflict'
          ? result('autosave', 'fail', 'conflict', { facts: saved })
          : result('autosave', 'info', 'pending', { facts: saved }),
  )

  if (!facts.canBackup) {
    results.push(result('backup', 'info', 'admin'))
  } else if (!facts.lastBackupAt) {
    results.push(facts.hasRecords ? result('backup', 'warn', 'never', { action: 'backup' }) : result('backup', 'info', 'never', { action: 'backup' }))
  } else {
    const age = now - Date.parse(facts.lastBackupAt)
    const days = Number.isFinite(age) ? Math.max(0, Math.floor(age / DAY_MS)) : 0
    const shown = { lastBackup: stamp(facts.lastBackupAt), days }
    results.push(age > BACKUP_STALE_DAYS * DAY_MS ? result('backup', 'warn', 'stale', { facts: shown, action: 'backup' }) : result('backup', 'pass', 'recent', { facts: shown }))
  }

  if (facts.archives !== null) results.push(result('archives', 'info', 'count', { adminOnly: true, facts: { count: facts.archives, max: MAX_ARCHIVES } }))

  if (facts.chain) {
    results.push(
      facts.chain.ok
        ? result('auditChain', 'pass', 'ok', { adminOnly: true, facts: { entries: facts.chain.entries } })
        : result('auditChain', 'fail', 'broken', { adminOnly: true, facts: { entries: facts.chain.entries, brokenAt: facts.chain.brokenAt ?? '?' }, action: 'audit' }),
    )
  }

  if (facts.canReadAudit && facts.head !== null) {
    const problem = facts.seen?.problem ?? facts.recorded
    const shown = { head: facts.head, seen: facts.seen?.seq }
    results.push(
      problem === 'SHORTER'
        ? result('auditHead', 'fail', 'shorter', { adminOnly: true, facts: shown, action: 'audit' })
        : problem === 'CHANGED'
          ? result('auditHead', 'fail', 'changed', { adminOnly: true, facts: shown, action: 'audit' })
          : facts.seen
            ? result('auditHead', 'pass', 'ok', { adminOnly: true, facts: shown })
            : result('auditHead', 'info', 'first', { adminOnly: true, facts: shown }),
    )
  }

  if (facts.signatures) results.push(signatureCheck(facts.signatures))

  const behind = facts.clockFloor !== null && now < facts.clockFloor - CLOCK_TOLERANCE_MS
  const clockFacts = facts.clockMarks ? { deviceClock: stamp(now), vaultMark: stamp(facts.clockMarks.vault), deviceMark: stamp(facts.clockMarks.device) } : undefined
  results.push(
    behind
      ? result('clock', 'fail', 'behind', { facts: clockFacts, ...(facts.canManageUsers ? { action: 'clock' as const } : {}) })
      : result('clock', 'pass', 'ok', { facts: clockFacts }),
  )

  results.push(facts.totp ? result('totp', 'pass', 'on') : result('totp', 'warn', 'off', { action: 'account' }))
  results.push(
    facts.mustChange
      ? result('password', 'fail', 'mustChange', { action: 'account' })
      : facts.weak
        ? result('password', 'warn', 'weak', { action: 'account' })
        : result('password', 'pass', 'ok'),
  )

  if (facts.members !== null) {
    const shown = { count: facts.members, limit: LIMITS.wraps }
    results.push(
      facts.members >= LIMITS.wraps * MEMBER_WARN_SHARE
        ? result('members', 'warn', 'near', { adminOnly: true, facts: shown })
        : result('members', 'pass', 'ok', { adminOnly: true, facts: shown }),
    )
  }
  if (facts.hygiene !== null) {
    const { noAccess, expiredCodes, legacyWraps } = facts.hygiene
    results.push(
      noAccess + expiredCodes + legacyWraps > 0
        ? result('userHygiene', 'warn', 'attention', { adminOnly: true, facts: facts.hygiene, action: 'users' })
        : result('userHygiene', 'pass', 'ok', { adminOnly: true, facts: facts.hygiene }),
    )
  }
  results.push(...keysChecks(facts))
  return results
}

/** Design 6.2 `audit.signatures`: a check of the entries since this browser's last one offers to check every entry. */
export function signatureCheck(facts: NonNullable<VaultFacts['signatures']>): HealthResult {
  if (facts.problems > 0) {
    return result('auditSignatures', 'fail', 'problems', { adminOnly: true, facts: { problems: facts.problems, firstProblem: facts.firstProblem ?? undefined, signed: facts.signed }, action: 'audit' })
  }
  if (facts.signedFrom === null) return result('auditSignatures', 'info', 'none', { adminOnly: true })
  const partial = facts.checkedFrom > 1
  return result('auditSignatures', 'pass', 'ok', { adminOnly: true, facts: { signed: facts.signed, checkedFrom: partial ? facts.checkedFrom : undefined }, ...(partial ? { action: 'auditFull' as const } : {}) })
}

/** Design 6.2: a per-person-keys vault's founder key, roster and password strength; the upgrade offer on a 1.x vault. */
export function keysChecks(facts: VaultFacts): HealthResult[] {
  const results: HealthResult[] = []
  const keys = facts.keys
  if (keys) {
    results.push(result('keysFounder', 'pass', 'pinned', { facts: { founderKey: keys.founderKey } }))
    const shown = { rosterVersion: keys.rosterVersion, pending: keys.pending ?? undefined, reinvite: keys.reinvite ?? undefined }
    results.push(
      keys.reinvite
        ? result('keysRoster', 'warn', 'reinvite', { adminOnly: true, facts: shown, action: 'users' })
        : keys.pending
          ? result('keysRoster', 'info', 'pending', { adminOnly: true, facts: shown })
          : result('keysRoster', 'pass', 'ok', { facts: shown }),
    )
    results.push(keys.kdfBelow ? result('keysKdf', 'warn', 'below', { action: 'account' }) : result('keysKdf', 'pass', 'ok'))
    results.push(
      keys.missing > 0
        ? result('keysEpoch', 'warn', 'missing', { facts: { epoch: keys.epoch, missing: keys.missing } })
        : result('keysEpoch', 'pass', 'ok', { facts: { epoch: keys.epoch } }),
    )
    // Only after a new household key, and only once there is a backup: the backup row covers never having made one.
    if (facts.canBackup && keys.epoch > 1 && facts.lastBackupAt !== null) {
      results.push(
        keys.backupEpoch === keys.epoch
          ? result('backupRotation', 'pass', 'current', { facts: { epoch: keys.epoch } })
          : result('backupRotation', 'warn', 'before', { facts: { epoch: keys.epoch }, action: 'backup' }),
      )
    }
  }
  if (facts.upgradeOffer) results.push(result('keysUpgrade', 'info', 'offer', { adminOnly: true }))
  return results
}

export function ratesChecks(facts: RatesFacts, now: number): HealthResult[] {
  const shown = { rateDate: facts.rateDate ?? undefined, generated: stamp(facts.generatedAt), sources: facts.sources.length ? facts.sources.join(', ') : undefined }
  const fresh =
    facts.source === 'none'
      ? result('ratesFresh', 'warn', 'missing')
      : facts.source === 'cache'
        ? result('ratesFresh', 'warn', 'cached', { facts: shown })
        : facts.rateDate && isStale(facts.rateDate, localDay(now))
          ? result('ratesFresh', 'warn', 'stale', { facts: shown })
          : result('ratesFresh', 'pass', 'fresh', { facts: shown })
  const digest =
    facts.problem === 'digest'
      ? result('ratesDigest', 'fail', 'mismatch')
      : facts.source === 'network'
        ? result('ratesDigest', 'pass', 'ok')
        : result('ratesDigest', 'info', 'unknown')
  return [fresh, digest]
}

export function securityChecks(facts: SecurityFacts, dev: boolean): HealthResult[] {
  const csp = facts.csp ?? ''
  const strict = /default-src 'none'/.test(csp) && /script-src 'self'/.test(csp) && /object-src 'none'/.test(csp)
  return [
    strict ? result('csp', 'pass', 'ok') : dev ? result('csp', 'info', 'dev') : result('csp', 'fail', 'missing'),
    facts.framed ? result('frame', 'fail', 'framed') : result('frame', 'pass', 'ok'),
    isNewAddress(facts.hostname)
      ? result('origin', 'pass', 'official', { facts: { host: facts.hostname } })
      : isOldAddress(facts.hostname)
        ? result('origin', 'warn', 'old', { facts: { host: facts.hostname } })
        : result('origin', 'info', 'other', { facts: { host: facts.hostname } }),
  ]
}

export type HealthInput = {
  now: number
  dev: boolean
  browser: BrowserFacts
  /** Whether Web Crypto has X25519 and Ed25519; null where per-person keys do not concern this browser. */
  keysSuite?: boolean | null
  storage: StorageFacts
  app: AppFacts
  rates: RatesFacts
  security: SecurityFacts
  vault: VaultFacts | null
  capacity?: Capacity
}

export function evaluateHealth(input: HealthInput): HealthResult[] {
  const suite = input.keysSuite ?? null
  return [
    ...browserChecks(input.browser),
    ...(suite === null ? [] : [suite ? result('keysSuite', 'pass', 'ok') : result('keysSuite', 'warn', 'missing')]),
    ...storageChecks(input.storage, input.capacity),
    ...appChecks(input.app),
    ...(input.vault ? vaultChecks(input.vault, input.storage.stored, input.now, growthBudget(input.capacity ?? null)) : []),
    ...ratesChecks(input.rates, input.now),
    ...securityChecks(input.security, input.dev),
  ]
}
