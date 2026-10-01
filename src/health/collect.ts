import { readVaultRaw } from '../db/storage'
import { parseSnapshot, type FxSnapshot } from '../domain/fx'
import { FX_CACHE_KEY, FX_FUTURE_SKEW_MS, FX_SNAPSHOT_PATH } from '../services/fx.service'
import type { BuildInfo } from '../lib/version'

/** The parts of the browser the checks look at. Tests pass a stand-in; the page passes `globalThis`. */
export type HealthGlobals = {
  crypto?: { subtle?: unknown }
  indexedDB?: IDBFactory
  WebAssembly?: { validate?: (bytes: BufferSource) => boolean }
  isSecureContext?: boolean
  crossOriginIsolated?: boolean
  SharedArrayBuffer?: unknown
  trustedTypes?: { defaultPolicy?: unknown }
  localStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  navigator?: {
    locks?: unknown
    cookieEnabled?: boolean
    serviceWorker?: { controller?: unknown }
    storage?: {
      estimate?: () => Promise<{ usage?: number; quota?: number }>
      persisted?: () => Promise<boolean>
      persist?: () => Promise<boolean>
    }
  }
  document?: { querySelector: (selector: string) => { getAttribute: (name: string) => string | null } | null; baseURI?: string }
  location?: { hostname: string }
  __moliyaFramed?: boolean
}

export type BrowserFacts = {
  subtle: boolean
  secureContext: boolean
  indexedDb: boolean
  wasm: boolean
  locks: boolean
  isolated: boolean
  sharedArrayBuffer: boolean
  serviceWorker: 'controlled' | 'uncontrolled' | 'unsupported'
  /** Whether the page's policy asks for Trusted Types, and whether this browser enforces them. */
  trustedTypes: { policy: boolean; supported: boolean; defaultPolicy: boolean }
  cookies: boolean
}

export type StorageFacts = {
  write: 'ok' | 'failed' | 'missing'
  usage: number | null
  quota: number | null
  persisted: boolean | null
  canPersist: boolean
  localStorage: boolean
  stored: StoredRecordFacts | 'none' | 'unreadable'
}

/** Only the plain-text envelope fields of the stored record: never its people, keys or contents. */
export type StoredRecordFacts = { version: number | null; schemaVersion: number | null; appVersion: string | null; updatedAt: string | null; audit: { seq: number; hash: string } | null }

export type AppFacts = { running: BuildInfo; remote: Partial<BuildInfo> | null; reachable: boolean; dev: boolean }

export type RatesFacts = {
  /** Where the newest valid snapshot came from. */
  source: 'network' | 'cache' | 'none'
  /** Why the published snapshot was not used, if it was not. */
  problem: 'digest' | 'invalid' | 'unreachable' | null
  generatedAt: string | null
  rateDate: string | null
  sources: string[]
}

export type SecurityFacts = { csp: string | null; framed: boolean; hostname: string }

const WASM_HEADER = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
const PROBE_DB = 'jaybi-health-probe'
const PROBE_KEY = 'jaybi.health.probe'
const PROBE_TIMEOUT_MS = 4000
const CSP_SELECTOR = 'meta[http-equiv="Content-Security-Policy"]'

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

export function readCsp(g: HealthGlobals): string | null {
  return safe(() => g.document?.querySelector(CSP_SELECTOR)?.getAttribute('content') ?? null, null)
}

export function collectBrowserFacts(g: HealthGlobals): BrowserFacts {
  const csp = readCsp(g) ?? ''
  const worker = safe(() => g.navigator?.serviceWorker, undefined)
  return {
    subtle: safe(() => typeof g.crypto?.subtle === 'object' && g.crypto.subtle !== null, false),
    secureContext: g.isSecureContext === true,
    indexedDb: safe(() => typeof g.indexedDB?.open === 'function', false),
    wasm: safe(() => typeof g.WebAssembly?.validate === 'function' && g.WebAssembly.validate(WASM_HEADER), false),
    locks: safe(() => g.navigator?.locks != null, false),
    isolated: g.crossOriginIsolated === true,
    sharedArrayBuffer: typeof g.SharedArrayBuffer === 'function',
    serviceWorker: worker == null ? 'unsupported' : worker.controller ? 'controlled' : 'uncontrolled',
    trustedTypes: {
      policy: /require-trusted-types-for\s+'script'/.test(csp),
      supported: safe(() => g.trustedTypes != null, false),
      defaultPolicy: safe(() => g.trustedTypes?.defaultPolicy != null, false),
    },
    cookies: safe(() => g.navigator?.cookieEnabled !== false, false),
  }
}

function withTimeout<T>(promise: Promise<T>, fallback: T, ms = PROBE_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      },
    )
  })
}

/** Writes, reads back and deletes a value in a throwaway database, never in the vault's own. */
export function probeIndexedDb(factory: IDBFactory | undefined): Promise<'ok' | 'failed' | 'missing'> {
  if (!factory || typeof factory.open !== 'function') return Promise.resolve('missing')
  const attempt = new Promise<'ok' | 'failed'>((resolve) => {
    let request: IDBOpenDBRequest
    try {
      request = factory.open(PROBE_DB, 1)
    } catch {
      resolve('failed')
      return
    }
    request.onupgradeneeded = () => request.result.createObjectStore('probe')
    request.onerror = () => resolve('failed')
    request.onblocked = () => resolve('failed')
    request.onsuccess = () => {
      const database = request.result
      const finish = (outcome: 'ok' | 'failed') => {
        database.close()
        try {
          factory.deleteDatabase(PROBE_DB)
        } catch {
          // A probe database left behind holds one small value and is overwritten next time.
        }
        resolve(outcome)
      }
      try {
        const transaction = database.transaction('probe', 'readwrite')
        const store = transaction.objectStore('probe')
        const stamp = `${Date.now()}`
        store.put(stamp, 'stamp')
        const read = store.get('stamp')
        transaction.oncomplete = () => finish(read.result === stamp ? 'ok' : 'failed')
        transaction.onabort = () => finish('failed')
        transaction.onerror = () => finish('failed')
      } catch {
        finish('failed')
      }
    }
  })
  return withTimeout(attempt, 'failed')
}

function probeLocalStorage(g: HealthGlobals): boolean {
  return safe(() => {
    const storage = g.localStorage
    if (!storage) return false
    storage.setItem(PROBE_KEY, '1')
    const back = storage.getItem(PROBE_KEY)
    storage.removeItem(PROBE_KEY)
    return back === '1'
  }, false)
}

export function storedRecordFacts(raw: unknown): StoredRecordFacts | 'none' | 'unreadable' {
  if (raw === undefined || raw === null) return 'none'
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'unreadable'
  const record = raw as Record<string, unknown>
  const audit = record.audit as Record<string, unknown> | undefined
  return {
    version: typeof record.version === 'number' ? record.version : null,
    schemaVersion: typeof record.schemaVersion === 'number' ? record.schemaVersion : null,
    appVersion: typeof record.appVersion === 'string' ? record.appVersion : record.version === 1 ? '1.0.0' : null,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null,
    audit:
      audit && typeof audit === 'object' && Number.isSafeInteger(audit.seq) && typeof audit.hash === 'string'
        ? { seq: audit.seq as number, hash: audit.hash }
        : null,
  }
}

export type StorageProbes = {
  indexedDb?: (factory: IDBFactory | undefined) => Promise<'ok' | 'failed' | 'missing'>
  /** Resolves the stored record as kept in IndexedDB, or `undefined` when there is none. */
  record?: () => Promise<unknown>
}

export async function collectStorageFacts(g: HealthGlobals, probes: StorageProbes = {}): Promise<StorageFacts> {
  const storage = safe(() => g.navigator?.storage, undefined)
  const [write, estimate, persisted, raw] = await Promise.all([
    (probes.indexedDb ?? probeIndexedDb)(g.indexedDB),
    storage?.estimate ? withTimeout(storage.estimate().then((value) => value, () => null), null) : Promise.resolve(null),
    storage?.persisted ? withTimeout(storage.persisted().then((value) => value, () => null), null) : Promise.resolve(null),
    withTimeout(
      (probes.record ?? readVaultRaw)().then(
        (value) => ({ value }),
        () => null,
      ),
      null,
    ),
  ])
  return {
    write,
    usage: typeof estimate?.usage === 'number' ? estimate.usage : null,
    quota: typeof estimate?.quota === 'number' ? estimate.quota : null,
    persisted: typeof persisted === 'boolean' ? persisted : null,
    canPersist: typeof storage?.persist === 'function',
    localStorage: probeLocalStorage(g),
    stored: raw === null ? 'unreadable' : storedRecordFacts(raw.value),
  }
}

type Fetcher = (input: URL, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'json' | 'text'>>

export async function collectAppFacts(running: BuildInfo, fetcher: Fetcher, base: string, dev: boolean): Promise<AppFacts> {
  // Only a build writes version.json; the update banner skips development servers for the same reason.
  if (dev) return { running, remote: null, reachable: false, dev }
  try {
    const response = await fetcher(new URL('version.json', base), { cache: 'no-store', credentials: 'same-origin' })
    if (!response.ok) return { running, remote: null, reachable: false, dev }
    const remote = (await response.json()) as unknown
    if (typeof remote !== 'object' || remote === null) return { running, remote: null, reachable: false, dev }
    const { version, commit, builtAt } = remote as Record<string, unknown>
    return {
      running,
      remote: {
        ...(typeof version === 'string' ? { version } : {}),
        ...(typeof commit === 'string' ? { commit } : {}),
        ...(typeof builtAt === 'string' ? { builtAt } : {}),
      },
      reachable: true,
      dev,
    }
  } catch {
    return { running, remote: null, reachable: false, dev }
  }
}

function latestRateDate(snapshot: FxSnapshot): string {
  return snapshot.quotes.map((quote) => quote.date).sort().at(-1) ?? snapshot.generatedAt.slice(0, 10)
}

function snapshotFacts(snapshot: FxSnapshot): Pick<RatesFacts, 'generatedAt' | 'rateDate' | 'sources'> {
  return { generatedAt: snapshot.generatedAt, rateDate: latestRateDate(snapshot), sources: [...new Set(snapshot.quotes.map((quote) => quote.source))] }
}

function parseFresh(text: string, now: number): FxSnapshot {
  const snapshot = parseSnapshot(text)
  if (Date.parse(snapshot.generatedAt) > now + FX_FUTURE_SKEW_MS) throw new Error('future')
  return snapshot
}

/** The published snapshot, checked against its digest, or else the copy this browser kept. */
export async function collectRatesFacts(g: HealthGlobals, fetcher: Fetcher, base: string, now: number): Promise<RatesFacts> {
  let problem: RatesFacts['problem'] = null
  try {
    const response = await fetcher(new URL(FX_SNAPSHOT_PATH, base), { cache: 'no-cache', credentials: 'same-origin' })
    if (!response.ok) {
      problem = 'unreachable'
    } else {
      const text = await response.text()
      try {
        return { source: 'network', problem: null, ...snapshotFacts(parseFresh(text, now)) }
      } catch (error) {
        problem = error instanceof Error && /digest/.test(error.message) ? 'digest' : 'invalid'
      }
    }
  } catch {
    problem = 'unreachable'
  }
  const cached = safe(() => g.localStorage?.getItem(FX_CACHE_KEY) ?? null, null)
  if (cached) {
    try {
      return { source: 'cache', problem, ...snapshotFacts(parseFresh(cached, now)) }
    } catch {
      // A damaged cached copy is ignored here; the rates panel removes it the next time it loads.
    }
  }
  return { source: 'none', problem, generatedAt: null, rateDate: null, sources: [] }
}

export function collectSecurityFacts(g: HealthGlobals, hostname: string): SecurityFacts {
  return { csp: readCsp(g), framed: g.__moliyaFramed === true, hostname }
}
