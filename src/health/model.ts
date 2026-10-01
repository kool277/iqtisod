export type HealthStatus = 'pass' | 'warn' | 'fail' | 'info'

export const HEALTH_GROUPS = ['browser', 'storage', 'app', 'vault', 'rates', 'security'] as const
export type HealthGroup = (typeof HEALTH_GROUPS)[number]

export type HealthAction = 'persist' | 'backup' | 'reload' | 'clock' | 'audit' | 'account'

/** Plain values shown under a check and copied into the report. Never a secret, an email or a name. */
export type HealthFacts = Record<string, string | number>

/** Every check, its group, and the explanations it can show; `health.checks.<id>.<detail>` holds each text. */
export const HEALTH_CHECKS = {
  crypto: { group: 'browser', details: ['ok', 'missing'] },
  indexedDb: { group: 'browser', details: ['ok', 'missing'] },
  wasm: { group: 'browser', details: ['ok', 'missing'] },
  locks: { group: 'browser', details: ['ok', 'missing'] },
  isolation: { group: 'browser', details: ['ok', 'missing'] },
  serviceWorker: { group: 'browser', details: ['ok', 'headers', 'notControlling', 'unsupported'] },
  secureContext: { group: 'browser', details: ['ok', 'insecure'] },
  trustedTypes: { group: 'browser', details: ['ok', 'dev', 'unsupported'] },
  cookies: { group: 'browser', details: ['ok', 'blocked'] },
  privateMode: { group: 'browser', details: ['ok', 'likely', 'unknown'] },
  storageWrite: { group: 'storage', details: ['ok', 'failed', 'missing'] },
  quota: { group: 'storage', details: ['ok', 'low', 'full', 'unknown'] },
  persisted: { group: 'storage', details: ['ok', 'notGranted', 'unsupported'] },
  localStorage: { group: 'storage', details: ['ok', 'blocked'] },
  storedVault: { group: 'storage', details: ['present', 'none', 'unreadable'] },
  version: { group: 'app', details: ['current', 'update', 'offline', 'dev'] },
  build: { group: 'app', details: ['info'] },
  chunks: { group: 'app', details: ['ok', 'stale', 'unknown'] },
  format: { group: 'vault', details: ['current', 'older', 'newer'] },
  size: { group: 'vault', details: ['ok', 'near', 'full'] },
  autosave: { group: 'vault', details: ['saved', 'pending', 'error', 'conflict'] },
  backup: { group: 'vault', details: ['recent', 'stale', 'never', 'admin'] },
  archives: { group: 'vault', details: ['count'] },
  auditChain: { group: 'vault', details: ['ok', 'broken'] },
  auditHead: { group: 'vault', details: ['ok', 'first', 'shorter', 'changed'] },
  clock: { group: 'vault', details: ['ok', 'behind'] },
  totp: { group: 'vault', details: ['on', 'off'] },
  password: { group: 'vault', details: ['ok', 'weak', 'mustChange'] },
  members: { group: 'vault', details: ['ok', 'near'] },
  ratesFresh: { group: 'rates', details: ['fresh', 'stale', 'cached', 'missing'] },
  ratesDigest: { group: 'rates', details: ['ok', 'mismatch', 'unknown'] },
  csp: { group: 'security', details: ['ok', 'missing', 'dev'] },
  frame: { group: 'security', details: ['ok', 'framed'] },
  origin: { group: 'security', details: ['official', 'old', 'other'] },
} as const satisfies Record<string, { group: HealthGroup; details: readonly string[] }>

export type HealthCheckId = keyof typeof HEALTH_CHECKS
export type HealthDetail<Id extends HealthCheckId = HealthCheckId> = (typeof HEALTH_CHECKS)[Id]['details'][number]

export type HealthResult = {
  [Id in HealthCheckId]: {
    id: Id
    group: (typeof HEALTH_CHECKS)[Id]['group']
    status: HealthStatus
    detail: HealthDetail<Id>
    /** Shown only to people with the matching permission, and marked as such. */
    adminOnly?: boolean
    facts?: HealthFacts
    action?: HealthAction
  }
}[HealthCheckId]

/** The fact labels the page and the report know; `health.facts.<key>` holds each label. */
export const HEALTH_FACTS = [
  'usage',
  'quota',
  'free',
  'record',
  'schema',
  'writtenBy',
  'saved',
  'size',
  'limit',
  'lastBackup',
  'days',
  'count',
  'max',
  'entries',
  'brokenAt',
  'head',
  'seen',
  'vaultMark',
  'deviceMark',
  'deviceClock',
  'rateDate',
  'generated',
  'sources',
  'running',
  'available',
  'commit',
  'built',
  'deployed',
  'host',
] as const
export type HealthFactKey = (typeof HEALTH_FACTS)[number]

export function result<Id extends HealthCheckId>(
  id: Id,
  status: HealthStatus,
  detail: HealthDetail<Id>,
  extra: { adminOnly?: boolean; facts?: Partial<Record<HealthFactKey, string | number>>; action?: HealthAction } = {},
): HealthResult {
  const facts = extra.facts ? (Object.fromEntries(Object.entries(extra.facts).filter(([, value]) => value !== undefined)) as HealthFacts) : undefined
  return {
    id,
    group: HEALTH_CHECKS[id].group,
    status,
    detail,
    ...(extra.adminOnly ? { adminOnly: true } : {}),
    ...(facts && Object.keys(facts).length > 0 ? { facts } : {}),
    ...(extra.action ? { action: extra.action } : {}),
  } as HealthResult
}

export type HealthSummary = Record<HealthStatus, number>

export function summarize(results: readonly HealthResult[]): HealthSummary {
  const summary: HealthSummary = { pass: 0, warn: 0, fail: 0, info: 0 }
  for (const item of results) summary[item.status] += 1
  return summary
}

/** The worst status in a list: fail over warn over pass; info never raises it. */
export function overall(results: readonly HealthResult[]): 'pass' | 'warn' | 'fail' {
  if (results.some((item) => item.status === 'fail')) return 'fail'
  if (results.some((item) => item.status === 'warn')) return 'warn'
  return 'pass'
}
