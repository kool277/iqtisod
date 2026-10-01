import { readFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { auditHead } from '../../src/db/audit-chain'
import { RECORD_VERSION, SCHEMA_VERSION } from '../../src/db/versions'
import { sealSnapshot, type FxSnapshot } from '../../src/domain/fx'
import {
  collectAppFacts,
  collectBrowserFacts,
  collectRatesFacts,
  collectSecurityFacts,
  collectStorageFacts,
  probeIndexedDb,
  storedRecordFacts,
  type BrowserFacts,
  type HealthGlobals,
  type StorageFacts,
} from '../../src/health/collect'
import { appChecks, browserChecks, evaluateHealth, ratesChecks, securityChecks, storageChecks, vaultChecks, type HealthInput } from '../../src/health/evaluate'
import { HEALTH_CHECKS, HEALTH_FACTS, overall, summarize, type HealthResult } from '../../src/health/model'
import { healthReport, shortAgent } from '../../src/health/report'
import { collectVaultFacts, type VaultFacts } from '../../src/health/vault'
import { LOCALES, catalogFor, flattenMessages, loadHealthMessages } from '../../src/i18n'
import { FX_CACHE_KEY } from '../../src/services/fx.service'
import { CLOCK_KEY } from '../../src/services/grant-store'
import { MEMBER, OWNER, buildAccessHousehold, openAs, settlePassword } from '../support/access'
import { closeTracked } from '../support/safes'

const MIB = 1024 * 1024
const NOW = Date.parse('2026-09-30T10:00:00.000Z')
const CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; require-trusted-types-for 'script'; trusted-types default"
const RUNNING = { version: '1.5.0', commit: 'abc123abc123', builtAt: '2026-09-30T08:00:00.000Z' }
const RECORDED = JSON.parse(readFileSync(new URL('../fixtures/fx/snapshot.json', import.meta.url), 'utf8')) as FxSnapshot

afterAll(closeTracked)

function byId(results: readonly HealthResult[], id: HealthResult['id']): HealthResult {
  const found = results.find((item) => item.id === id)
  if (!found) throw new Error(`no ${id} result`)
  return found
}

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  }
}

function fullBrowser(overrides: Partial<HealthGlobals> = {}): HealthGlobals {
  return {
    crypto: { subtle: {} },
    indexedDB: { open: () => ({}) } as unknown as IDBFactory,
    WebAssembly: { validate: () => true },
    isSecureContext: true,
    crossOriginIsolated: true,
    SharedArrayBuffer: function SharedArrayBuffer() {},
    trustedTypes: { defaultPolicy: {} },
    localStorage: memoryStorage(),
    navigator: { locks: {}, cookieEnabled: true, serviceWorker: { controller: {} } },
    document: { querySelector: () => ({ getAttribute: () => CSP }) },
    __moliyaFramed: false,
    ...overrides,
  }
}

function json(body: unknown, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) })
}

function text(body: string, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(JSON.parse(body)), text: () => Promise.resolve(body) })
}

function snapshotDated(date: string): string {
  const { digest: _digest, ...body } = structuredClone(RECORDED)
  body.generatedAt = `${date}T09:00:00.000Z`
  body.quotes = body.quotes.map((quote) => ({ ...quote, date, previous: quote.previous ? { ...quote.previous, date: '2026-09-20' } : null }))
  return JSON.stringify(sealSnapshot(body))
}

describe('browser support', () => {
  it('passes every check in a capable, isolated, policy-enforcing browser', () => {
    const results = browserChecks(collectBrowserFacts(fullBrowser()))
    expect(results.map((item) => [item.id, item.status])).toEqual([
      ['crypto', 'pass'],
      ['indexedDb', 'pass'],
      ['wasm', 'pass'],
      ['locks', 'pass'],
      ['isolation', 'pass'],
      ['serviceWorker', 'pass'],
      ['secureContext', 'pass'],
      ['trustedTypes', 'pass'],
      ['cookies', 'pass'],
    ])
  })

  it('fails what Jaybi cannot run without and warns about the rest', () => {
    const facts = collectBrowserFacts({
      navigator: { cookieEnabled: false },
      isSecureContext: false,
      document: { querySelector: () => null },
    })
    const results = browserChecks(facts)
    expect(byId(results, 'crypto').status).toBe('fail')
    expect(byId(results, 'indexedDb').status).toBe('fail')
    expect(byId(results, 'wasm').status).toBe('fail')
    expect(byId(results, 'secureContext')).toMatchObject({ status: 'fail', detail: 'insecure' })
    expect(byId(results, 'locks')).toMatchObject({ status: 'warn', detail: 'missing' })
    expect(byId(results, 'isolation')).toMatchObject({ status: 'warn', action: 'reload' })
    expect(byId(results, 'serviceWorker')).toMatchObject({ status: 'warn', detail: 'unsupported' })
    expect(byId(results, 'trustedTypes')).toMatchObject({ status: 'info', detail: 'dev' })
    expect(byId(results, 'cookies')).toMatchObject({ status: 'warn', detail: 'blocked' })
  })

  it('treats a throwing or lying API as missing rather than crashing', () => {
    const hostile = fullBrowser({
      WebAssembly: {
        validate: () => {
          throw new Error('disabled')
        },
      },
    })
    Object.defineProperty(hostile, 'navigator', {
      get() {
        throw new Error('blocked')
      },
    })
    const facts = collectBrowserFacts(hostile)
    expect(facts.wasm).toBe(false)
    expect(facts.locks).toBe(false)
    expect(facts.serviceWorker).toBe('unsupported')
  })

  it('explains the service worker by how the page is isolated', () => {
    const base: BrowserFacts = collectBrowserFacts(fullBrowser())
    expect(byId(browserChecks({ ...base, serviceWorker: 'uncontrolled' }), 'serviceWorker').detail).toBe('headers')
    expect(byId(browserChecks({ ...base, isolated: false, serviceWorker: 'uncontrolled' }), 'serviceWorker')).toMatchObject({ status: 'warn', detail: 'notControlling', action: 'reload' })
  })

  it('reports Trusted Types as unsupported, not failed, where the browser has none', () => {
    const facts = collectBrowserFacts(fullBrowser({ trustedTypes: undefined }))
    expect(byId(browserChecks(facts), 'trustedTypes')).toMatchObject({ status: 'info', detail: 'unsupported' })
  })
})

describe('storage', () => {
  const healthy: StorageFacts = { write: 'ok', usage: 5 * MIB, quota: 4096 * MIB, persisted: true, canPersist: true, localStorage: true, stored: 'none' }

  it('reads quota, persistence and the stored envelope through the browser APIs', async () => {
    const g = fullBrowser({
      navigator: {
        storage: {
          estimate: () => Promise.resolve({ usage: 3 * MIB, quota: 2048 * MIB }),
          persisted: () => Promise.resolve(false),
          persist: () => Promise.resolve(true),
        },
      },
    })
    const facts = await collectStorageFacts(g, {
      indexedDb: () => Promise.resolve('ok'),
      record: () => Promise.resolve({ version: 2, schemaVersion: 4, appVersion: '1.4.2', updatedAt: '2026-09-30T09:00:00.000Z', wraps: [{ email: 'secret@example.com' }] }),
    })
    expect(facts).toMatchObject({ write: 'ok', usage: 3 * MIB, quota: 2048 * MIB, persisted: false, canPersist: true, localStorage: true })
    expect(facts.stored).toEqual({ version: 2, schemaVersion: 4, appVersion: '1.4.2', updatedAt: '2026-09-30T09:00:00.000Z', audit: null })
    expect(JSON.stringify(facts)).not.toContain('secret@example.com')
    const results = storageChecks(facts)
    expect(byId(results, 'persisted')).toMatchObject({ status: 'warn', detail: 'notGranted', action: 'persist' })
    expect(byId(results, 'storedVault')).toMatchObject({ status: 'pass', facts: { record: 2, schema: 4 } })
  })

  it('copes with a browser that offers no storage manager and blocks local storage', async () => {
    const blocked = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => undefined,
    }
    const facts = await collectStorageFacts(fullBrowser({ navigator: {}, localStorage: blocked }), {
      indexedDb: () => Promise.resolve('failed'),
      record: () => Promise.reject(new Error('denied')),
    })
    expect(facts).toMatchObject({ write: 'failed', usage: null, quota: null, persisted: null, canPersist: false, localStorage: false, stored: 'unreadable' })
    const results = storageChecks(facts)
    expect(byId(results, 'storageWrite')).toMatchObject({ status: 'fail', detail: 'failed' })
    expect(byId(results, 'quota').detail).toBe('unknown')
    expect(byId(results, 'persisted').detail).toBe('unsupported')
    expect(byId(results, 'localStorage').status).toBe('warn')
    expect(byId(results, 'privateMode').detail).toBe('unknown')
  })

  it('compares free space with a full vault and its earlier copies', () => {
    expect(byId(storageChecks(healthy), 'quota').status).toBe('pass')
    expect(byId(storageChecks({ ...healthy, quota: 900 * MIB, usage: 800 * MIB }), 'quota')).toMatchObject({ status: 'warn', detail: 'low' })
    expect(byId(storageChecks({ ...healthy, quota: 900 * MIB, usage: 880 * MIB }), 'quota')).toMatchObject({ status: 'fail', detail: 'full', facts: { free: '20.0 MB', limit: '48.0 MB' } })
  })

  it('hints at a private window when the browser offers very little room', () => {
    expect(byId(storageChecks({ ...healthy, quota: 120 * MIB }), 'privateMode')).toMatchObject({ status: 'warn', detail: 'likely' })
    expect(byId(storageChecks(healthy), 'privateMode').status).toBe('pass')
  })

  it('probes IndexedDB without touching the vault database', async () => {
    expect(await probeIndexedDb(undefined)).toBe('missing')
    const throwing = {
      open: () => {
        throw new Error('SecurityError')
      },
    } as unknown as IDBFactory
    expect(await probeIndexedDb(throwing)).toBe('failed')
    const opened: string[] = []
    const failing = {
      open: (name: string) => {
        opened.push(name)
        const request = {} as IDBOpenDBRequest
        queueMicrotask(() => (request.onerror as () => void)?.())
        return request
      },
    } as unknown as IDBFactory
    expect(await probeIndexedDb(failing)).toBe('failed')
    expect(opened).toEqual(['jaybi-health-probe'])
  })

  it('reads only plain envelope fields from the stored record', () => {
    expect(storedRecordFacts(undefined)).toBe('none')
    expect(storedRecordFacts('garbage')).toBe('unreadable')
    expect(storedRecordFacts({ version: 1 })).toMatchObject({ version: 1, appVersion: '1.0.0', schemaVersion: null })
    expect(storedRecordFacts({ version: 2, audit: { seq: 7, hash: 'a'.repeat(64) } })).toMatchObject({ audit: { seq: 7, hash: 'a'.repeat(64) } })
  })
})

describe('app and version', () => {
  it('compares the running build with the published version.json', async () => {
    const urls: string[] = []
    const same = await collectAppFacts(RUNNING, (url) => (urls.push(url.href), json(RUNNING)), 'https://jaybi.uz/', false)
    expect(urls).toEqual(['https://jaybi.uz/version.json'])
    expect(appChecks(same).map((item) => [item.id, item.status])).toEqual([
      ['version', 'pass'],
      ['build', 'info'],
      ['chunks', 'pass'],
    ])

    const newer = await collectAppFacts(RUNNING, () => json({ ...RUNNING, version: '1.5.1', commit: 'def456def456', builtAt: '2026-10-02T08:00:00.000Z' }), 'https://jaybi.uz/', false)
    const results = appChecks(newer)
    expect(byId(results, 'version')).toMatchObject({ status: 'warn', detail: 'update', action: 'reload', facts: { running: '1.5.0', available: '1.5.1' } })
    expect(byId(results, 'chunks')).toMatchObject({ status: 'warn', detail: 'stale' })
    expect(byId(results, 'build').facts).toMatchObject({ commit: 'abc123abc123' })
    expect(byId(results, 'build').facts?.deployed).toMatch(/^2026-10-02 /)
  })

  it('says so when version.json cannot be read, and in development builds', async () => {
    const offline = await collectAppFacts(RUNNING, () => Promise.reject(new Error('offline')), 'https://jaybi.uz/', false)
    expect(byId(appChecks(offline), 'version')).toMatchObject({ status: 'warn', detail: 'offline' })
    expect(byId(appChecks(offline), 'chunks').detail).toBe('unknown')
    const missing = await collectAppFacts(RUNNING, () => json(null, false), 'https://jaybi.uz/', false)
    expect(missing.reachable).toBe(false)
    const dev = await collectAppFacts(RUNNING, () => json(null, false), 'http://localhost:5173/', true)
    expect(byId(appChecks(dev), 'version')).toMatchObject({ status: 'info', detail: 'dev' })
  })
})

describe('exchange rates', () => {
  it('accepts the published snapshot when its digest matches, and flags old rates', async () => {
    const fresh = await collectRatesFacts(fullBrowser(), () => text(snapshotDated('2026-09-30')), 'https://jaybi.uz/', NOW)
    expect(fresh).toMatchObject({ source: 'network', problem: null, rateDate: '2026-09-30' })
    expect(ratesChecks(fresh, NOW).map((item) => [item.id, item.status])).toEqual([
      ['ratesFresh', 'pass'],
      ['ratesDigest', 'pass'],
    ])
    const old = await collectRatesFacts(fullBrowser(), () => text(snapshotDated('2026-09-21')), 'https://jaybi.uz/', NOW)
    expect(byId(ratesChecks(old, NOW), 'ratesFresh')).toMatchObject({ status: 'warn', detail: 'stale' })
  })

  it('refuses a snapshot whose digest does not match and falls back to the saved copy', async () => {
    const tampered = JSON.parse(snapshotDated('2026-09-30')) as FxSnapshot
    tampered.quotes[0].rate = '11000.00'
    const cache = memoryStorage({ [FX_CACHE_KEY]: snapshotDated('2026-09-29') })
    const facts = await collectRatesFacts(fullBrowser({ localStorage: cache }), () => text(JSON.stringify(tampered)), 'https://jaybi.uz/', NOW)
    expect(facts).toMatchObject({ source: 'cache', problem: 'digest', rateDate: '2026-09-29' })
    const results = ratesChecks(facts, NOW)
    expect(byId(results, 'ratesDigest')).toMatchObject({ status: 'fail', detail: 'mismatch' })
    expect(byId(results, 'ratesFresh')).toMatchObject({ status: 'warn', detail: 'cached' })
  })

  it('warns when no rates can be loaded at all', async () => {
    const facts = await collectRatesFacts(fullBrowser(), () => text('not found', false), 'https://jaybi.uz/', NOW)
    expect(facts).toMatchObject({ source: 'none', problem: 'unreachable' })
    expect(ratesChecks(facts, NOW).map((item) => item.detail)).toEqual(['missing', 'unknown'])
  })
})

describe('security posture', () => {
  it('checks the policy, the frame guard and the address', () => {
    const results = securityChecks(collectSecurityFacts(fullBrowser(), 'jaybi.uz'), false)
    expect(results.map((item) => [item.id, item.status])).toEqual([
      ['csp', 'pass'],
      ['frame', 'pass'],
      ['origin', 'pass'],
    ])
    expect(byId(securityChecks(collectSecurityFacts(fullBrowser({ document: { querySelector: () => null } }), 'localhost'), true), 'csp').detail).toBe('dev')
    expect(byId(securityChecks(collectSecurityFacts(fullBrowser({ document: { querySelector: () => null } }), 'jaybi.uz'), false), 'csp').status).toBe('fail')
    expect(byId(securityChecks(collectSecurityFacts(fullBrowser({ __moliyaFramed: true }), 'jaybi.uz'), false), 'frame').status).toBe('fail')
    expect(byId(securityChecks(collectSecurityFacts(fullBrowser(), 'kool277.github.io'), false), 'origin')).toMatchObject({ status: 'warn', detail: 'old' })
    expect(byId(securityChecks(collectSecurityFacts(fullBrowser(), '127.0.0.1'), false), 'origin')).toMatchObject({ status: 'info', detail: 'other' })
  })
})

describe('vault checks', () => {
  const stored = { version: RECORD_VERSION, schemaVersion: SCHEMA_VERSION, appVersion: '1.5.0', updatedAt: '2026-09-30T09:59:00.000Z', audit: null }

  it('show an admin everything, marking admin-only rows, and a viewer only their own rows', async () => {
    const household = await buildAccessHousehold()
    const admin = await openAs(household.record, OWNER)
    const adminFacts = collectVaultFacts(admin, { saveState: 'saved', weak: false, archives: 1, deviceMark: auditHead(admin.db), recordedHead: null })
    expect(adminFacts).toMatchObject({ canReadAudit: true, canManageUsers: true, members: 3, archives: 1, chain: { ok: true } })
    const adminResults = vaultChecks(adminFacts, stored, NOW)
    expect(adminResults.filter((item) => item.adminOnly).map((item) => item.id).sort()).toEqual(['archives', 'auditChain', 'auditHead', 'members'])
    expect(byId(adminResults, 'auditHead')).toMatchObject({ status: 'pass', detail: 'ok' })
    expect(byId(adminResults, 'backup')).toMatchObject({ status: 'info', detail: 'never' })
    expect(byId(adminResults, 'format')).toMatchObject({ status: 'pass', detail: 'current' })

    const viewer = settlePassword(await openAs(household.record, MEMBER))
    const viewerFacts = collectVaultFacts(viewer, { saveState: 'saved', weak: false, archives: 2, deviceMark: null, recordedHead: null })
    expect(viewerFacts).toMatchObject({ canReadAudit: false, canManageUsers: false, chain: null, head: null, members: null, archives: null, clockMarks: null, lastBackupAt: null })
    const viewerResults = vaultChecks(viewerFacts, stored, NOW)
    expect(viewerResults.some((item) => item.adminOnly)).toBe(false)
    expect(viewerResults.map((item) => item.id)).toEqual(['format', 'size', 'autosave', 'backup', 'clock', 'totp', 'password'])
    expect(byId(viewerResults, 'backup').detail).toBe('admin')
    expect(JSON.stringify(viewerResults)).not.toMatch(/@maple\.test/)
  })

  it('catch a broken or shortened audit log', async () => {
    const household = await buildAccessHousehold()
    const admin = await openAs(household.record, OWNER)
    const head = auditHead(admin.db)
    // What someone editing the database outside the app could do: drop the append-only guard and rewrite an entry.
    for (const row of admin.db.query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'audit_logs'")) admin.db.exec(`DROP TRIGGER ${String(row.name)}`)
    admin.db.exec("UPDATE audit_logs SET action = 'TAMPERED' WHERE seq = 1")
    const broken = collectVaultFacts(admin, { saveState: 'saved', weak: false, archives: 0, deviceMark: { seq: head.seq + 5, hash: head.hash }, recordedHead: null })
    const results = vaultChecks(broken, stored, NOW)
    expect(byId(results, 'auditChain')).toMatchObject({ status: 'fail', detail: 'broken', facts: { brokenAt: 1 }, action: 'audit' })
    expect(byId(results, 'auditHead')).toMatchObject({ status: 'fail', detail: 'shorter' })
  })

  it('warn about backups, saving, size, the sign-in check and the password', () => {
    const facts: VaultFacts = {
      schemaVersion: SCHEMA_VERSION,
      bytes: 40 * MIB,
      saveState: 'conflict',
      lastBackupAt: new Date(NOW - 9 * 24 * 60 * 60 * 1000).toISOString(),
      hasRecords: true,
      canBackup: true,
      canReadAudit: false,
      canManageUsers: true,
      archives: 0,
      chain: null,
      head: null,
      seen: null,
      recorded: null,
      clockFloor: NOW + 60 * 60 * 1000,
      clockMarks: { vault: new Date(NOW + 60 * 60 * 1000).toISOString(), device: null },
      totp: false,
      mustChange: false,
      weak: true,
      members: 240,
    }
    const results = vaultChecks(facts, { ...stored, version: 1 }, NOW)
    expect(byId(results, 'format')).toMatchObject({ status: 'info', detail: 'older' })
    expect(byId(results, 'size')).toMatchObject({ status: 'warn', detail: 'near' })
    expect(byId(results, 'autosave')).toMatchObject({ status: 'fail', detail: 'conflict' })
    expect(byId(results, 'backup')).toMatchObject({ status: 'warn', detail: 'stale', action: 'backup', facts: { days: 9 } })
    expect(byId(results, 'clock')).toMatchObject({ status: 'fail', detail: 'behind', action: 'clock' })
    expect(byId(results, 'totp')).toMatchObject({ status: 'warn', detail: 'off', action: 'account' })
    expect(byId(results, 'password')).toMatchObject({ status: 'warn', detail: 'weak' })
    expect(byId(results, 'members')).toMatchObject({ status: 'warn', detail: 'near' })
    expect(byId(vaultChecks({ ...facts, mustChange: true, bytes: 49 * MIB, lastBackupAt: null }, stored, NOW), 'password').detail).toBe('mustChange')
    expect(byId(vaultChecks({ ...facts, bytes: 49 * MIB }, stored, NOW), 'size').status).toBe('fail')
    expect(byId(vaultChecks({ ...facts, lastBackupAt: null }, stored, NOW), 'backup')).toMatchObject({ status: 'warn', detail: 'never' })
    expect(byId(vaultChecks({ ...facts, schemaVersion: SCHEMA_VERSION + 1 }, stored, NOW), 'format').status).toBe('fail')
  })

  it('read the clock marks only for people who manage users', async () => {
    const household = await buildAccessHousehold()
    const admin = await openAs(household.record, OWNER)
    admin.db.exec('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [CLOCK_KEY, new Date(NOW + 2 * 60 * 60 * 1000).toISOString()])
    const facts = collectVaultFacts(admin, { saveState: 'saved', weak: false, archives: 0, deviceMark: null, recordedHead: null })
    const clock = byId(vaultChecks(facts, stored, NOW), 'clock')
    expect(clock).toMatchObject({ status: 'fail', detail: 'behind', action: 'clock' })
    expect(clock.facts?.vaultMark).toBeDefined()
  })
})

describe('the whole run', () => {
  it('leaves out the vault before sign-in and summarises the rest', async () => {
    const input: HealthInput = {
      now: NOW,
      dev: false,
      browser: collectBrowserFacts(fullBrowser()),
      storage: { write: 'ok', usage: MIB, quota: 4096 * MIB, persisted: false, canPersist: true, localStorage: true, stored: 'none' },
      app: await collectAppFacts(RUNNING, () => json(RUNNING), 'https://jaybi.uz/', false),
      rates: await collectRatesFacts(fullBrowser(), () => text(snapshotDated('2026-09-30')), 'https://jaybi.uz/', NOW),
      security: collectSecurityFacts(fullBrowser(), 'jaybi.uz'),
      vault: null,
    }
    const results = evaluateHealth(input)
    expect(results.some((item) => item.group === 'vault')).toBe(false)
    expect(new Set(results.map((item) => item.id)).size).toBe(results.length)
    expect(summarize(results)).toMatchObject({ warn: 1, fail: 0 })
    expect(overall(results)).toBe('warn')
    expect(overall(results.filter((item) => item.status !== 'warn'))).toBe('pass')
  })
})

describe('report', () => {
  it('is plain text without emails, and keeps only product tokens of the user agent', () => {
    const results: HealthResult[] = [
      { id: 'version', group: 'app', status: 'warn', detail: 'update', facts: { running: '1.5.0', available: '1.5.1' } },
      { id: 'members', group: 'vault', status: 'pass', detail: 'ok', adminOnly: true, facts: { count: 3, limit: 256 } },
      { id: 'origin', group: 'security', status: 'info', detail: 'other', facts: { host: 'someone@example.com' } },
    ]
    const report = healthReport(results, {
      appName: 'Jaybi',
      version: '1.5.0',
      commit: 'abc',
      locale: 'en',
      createdAt: '2026-09-30T10:00:00.000Z',
      agent: shortAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'),
      signedIn: true,
      title: (item) => item.id,
      label: (key) => key,
    })
    expect(report).toContain('Browser: Chrome/140.0 Safari/537.36 (Intel Mac OS X 10_15_7)')
    expect(report).toContain('Summary: 1 pass, 1 warn, 0 fail, 1 info')
    expect(report).toContain('[WARN] version.update - version | running=1.5.0; available=1.5.1')
    expect(report).toContain('[PASS] members.ok - members (admin) | count=3; limit=256')
    expect(report).not.toContain('someone@example.com')
  })
})

describe('health strings', () => {
  it('exist in every language for every check, explanation, fix and fact', async () => {
    await Promise.all(LOCALES.map(loadHealthMessages))
    for (const locale of LOCALES) {
      const messages = flattenMessages(catalogFor(locale).health)
      for (const [id, check] of Object.entries(HEALTH_CHECKS)) {
        for (const key of ['title', 'fix', ...check.details]) expect(messages[`checks.${id}.${key}`], `${locale} ${id}.${key}`).toBeTruthy()
      }
      for (const fact of HEALTH_FACTS) expect(messages[`facts.${fact}`], `${locale} facts.${fact}`).toBeTruthy()
      const known = new Set(Object.entries(HEALTH_CHECKS).flatMap(([id, check]) => ['title', 'fix', ...check.details].map((key) => `checks.${id}.${key}`)))
      const extra = Object.keys(messages).filter((key) => key.startsWith('checks.') && !known.has(key))
      expect(extra, locale).toEqual([])
    }
  })
})
