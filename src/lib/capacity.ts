import { LIMITS } from './limits'

/**
 * How large a vault this browser on this device can hold, restore and back up.
 *
 * The decrypted vault is one SQLite database kept in the WebAssembly heap, and each operation briefly holds a few
 * more copies of it (ciphertext, plaintext, the stored record). The budget is the smallest of three limits, each
 * rounded down by {@link SAFETY_MARGIN}:
 *
 * - storage: free IndexedDB quota divided by the copies a restore writes ({@link STORAGE_MULTIPLE});
 * - memory: what one tab can use on this device, divided by the peak number of copies held at once
 *   ({@link PEAK_MEMORY_MULTIPLE}); never below what every device accepted up to 1.6.0;
 * - engine: the WebAssembly heap the bundled sqlite-wasm can grow to, less SQLite's own room, divided by the
 *   copies memdb holds while it grows.
 */

const MIB = 1024 * 1024
const GIB = 1024 * MIB

/** `@sqlite.org/sqlite-wasm` is built with a WebAssembly.Memory maximum of 32768 pages of 64 KiB. */
export const WASM_HEAP_MAX_BYTES = 2 * GIB
/** SQLite's page cache, statements, and the scratch database `VACUUM` builds live in the same heap. */
export const WASM_RESERVED_BYTES = 128 * MIB
/** memdb grows by reallocating to twice what it needs, so the old and the new buffer briefly coexist. */
export const MEMDB_GROWTH_FACTOR = 3
/** The largest database the engine can keep. */
export const ENGINE_MAX_BYTES = Math.floor((WASM_HEAP_MAX_BYTES - WASM_RESERVED_BYTES) / MEMDB_GROWTH_FACTOR / MIB) * MIB

/**
 * Copies of the vault alive at once at the worst moment of any operation, counting the WebAssembly heap
 * (see docs/developer-guide.md, "Memory"). From 1.7.0 the worst moment is an autosave after memdb has doubled:
 * the heap (2), the exported plaintext, the browser's copy of it while encrypting, and the ciphertext.
 */
export const PEAK_MEMORY_MULTIPLE = 5
/** Up to 1.6.0 the backup text, its JSON and binary strings, and several defensive clones were alive together. */
export const LEGACY_PEAK_MEMORY_MULTIPLE = 13
/** A restored vault, the copy it is archived as when its format is upgraded, and the rewrite of the first save. */
export const STORAGE_MULTIPLE = 3
/** Estimates are rounded down by this much, because other tabs and the browser itself share the same memory. */
export const SAFETY_MARGIN = 0.8
/** Room for the plain-text envelope of a backup: 256 wraps, 64 codes, and the JSON around them. */
export const BACKUP_ENVELOPE_BYTES = 512 * 1024
/** Share of the device's memory one tab can use before the browser or the system ends it. */
export const TAB_SHARE = { desktop: 0.25, mobile: 0.2 } as const
/** Used where the browser does not report its memory (Safari, Firefox). Desktops have at least this; phones often more. */
export const FALLBACK_DEVICE_MEMORY_GIB = { desktop: 8, mobile: 3 } as const
/** The size warning starts at this share of the budget. */
export const WARN_SHARE = 0.75

export function backupFileBytesFor(vaultBytes: number): number {
  return Math.ceil(vaultBytes / 3) * 4 + BACKUP_ENVELOPE_BYTES
}

/** The vault size a backup file of this many bytes can hold at most. */
export function vaultBytesForFile(fileBytes: number): number {
  return Math.max(0, Math.floor(Math.max(0, fileBytes - BACKUP_ENVELOPE_BYTES) / 4) * 3)
}

/** Every device accepted backups up to {@link LIMITS.importFileBytes} before 1.7.0, so the memory limit never goes below the vault they hold. */
export const MEMORY_FLOOR_BYTES = vaultBytesForFile(LIMITS.importFileBytes)

export type CapacityLimit = 'storage' | 'memory' | 'engine'

export type CapacitySignals = {
  quota: number | null
  usage: number | null
  persisted: boolean | null
  /** `navigator.deviceMemory`: Chromium only, in GiB, rounded down to a power of two. */
  deviceMemoryGiB: number | null
  /** `performance.memory`: Chromium only. */
  jsHeap: { used: number; limit: number } | null
  mobile: boolean
}

export type Capacity = {
  /** The largest vault: decrypted database or its ciphertext, which differ by 16 bytes. */
  vaultBytes: number
  /** The largest backup file: base64 of the ciphertext plus its envelope. */
  fileBytes: number
  limitedBy: CapacityLimit
  storageBytes: number | null
  memoryBytes: number
  engineBytes: number
  /** The device memory used for the estimate, and whether the browser reported it. */
  deviceMemoryBytes: number
  deviceMemoryReported: boolean
  persisted: boolean | null
}

function floorMiB(bytes: number): number {
  return Math.max(0, Math.floor(bytes / MIB) * MIB)
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function nonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

export function computeCapacity(signals: CapacitySignals): Capacity {
  const form = signals.mobile ? 'mobile' : 'desktop'
  const reported = positive(signals.deviceMemoryGiB)
  const deviceMemoryBytes = (reported ?? FALLBACK_DEVICE_MEMORY_GIB[form]) * GIB
  const used = positive(signals.jsHeap?.used) ?? 0
  const tab = Math.max(0, deviceMemoryBytes * TAB_SHARE[form] - used)
  const memoryBytes = Math.max(MEMORY_FLOOR_BYTES, floorMiB((tab / PEAK_MEMORY_MULTIPLE) * SAFETY_MARGIN))
  const quota = positive(signals.quota)
  const usage = nonNegative(signals.usage)
  const storageBytes = quota !== null && usage !== null ? floorMiB((Math.max(0, quota - usage) / STORAGE_MULTIPLE) * SAFETY_MARGIN) : null
  const engineBytes = ENGINE_MAX_BYTES
  let limitedBy: CapacityLimit = 'engine'
  let vaultBytes = engineBytes
  if (memoryBytes < vaultBytes) [limitedBy, vaultBytes] = ['memory', memoryBytes]
  if (storageBytes !== null && storageBytes < vaultBytes) [limitedBy, vaultBytes] = ['storage', storageBytes]
  return {
    vaultBytes,
    fileBytes: backupFileBytesFor(vaultBytes),
    limitedBy,
    storageBytes,
    memoryBytes,
    engineBytes,
    deviceMemoryBytes,
    deviceMemoryReported: reported !== null,
    persisted: signals.persisted,
  }
}

/**
 * How large the open vault may grow by adding receipts. Never below the fixed budget of earlier versions, so
 * nothing that was allowed before is refused; low storage shows up in the health check instead.
 */
export function growthBudget(capacity: Capacity | null): { budgetBytes: number; warnBytes: number } {
  const budgetBytes = Math.max(LIMITS.databaseBudgetBytes, capacity?.vaultBytes ?? 0)
  return { budgetBytes, warnBytes: budgetBytes === LIMITS.databaseBudgetBytes ? LIMITS.databaseWarnBytes : floorMiB(budgetBytes * WARN_SHARE) }
}

/** The parts of the browser the budget reads. Tests pass a stand-in; the app passes `globalThis`. */
export type CapacityGlobals = {
  navigator?: {
    deviceMemory?: number
    userAgent?: string
    maxTouchPoints?: number
    userAgentData?: { mobile?: boolean }
    storage?: {
      estimate?: () => Promise<{ usage?: number; quota?: number }>
      persisted?: () => Promise<boolean>
    }
  }
  performance?: { memory?: { usedJSHeapSize?: number; jsHeapSizeLimit?: number } }
}

function attempt<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

export function isMobile(g: CapacityGlobals): boolean {
  return attempt(() => {
    const nav = g.navigator
    if (!nav) return true
    if (typeof nav.userAgentData?.mobile === 'boolean') return nav.userAgentData.mobile
    const agent = nav?.userAgent ?? ''
    // iPadOS reports a Mac user agent; touch points tell them apart.
    return /Android|iPhone|iPad|iPod|Mobile/i.test(agent) || (/Macintosh/.test(agent) && (nav?.maxTouchPoints ?? 0) > 1)
  }, true)
}

const SIGNAL_TIMEOUT_MS = 3000

function settle<T>(promise: Promise<T> | undefined, fallback: T): Promise<T> {
  if (!promise) return Promise.resolve(fallback)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), SIGNAL_TIMEOUT_MS)
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

export async function readCapacitySignals(g: CapacityGlobals = globalThis as unknown as CapacityGlobals): Promise<CapacitySignals> {
  const storage = attempt(() => g.navigator?.storage, undefined)
  const [estimate, persisted] = await Promise.all([
    settle(attempt(() => storage?.estimate?.(), undefined), null),
    settle(attempt(() => storage?.persisted?.(), undefined), null),
  ])
  const memory = attempt(() => g.performance?.memory, undefined)
  const used = positive(memory?.usedJSHeapSize)
  const limit = positive(memory?.jsHeapSizeLimit)
  return {
    quota: positive(estimate?.quota),
    usage: nonNegative(estimate?.usage),
    persisted: typeof persisted === 'boolean' ? persisted : null,
    deviceMemoryGiB: positive(attempt(() => g.navigator?.deviceMemory, undefined)),
    jsHeap: used !== null && limit !== null ? { used, limit } : null,
    mobile: isMobile(g),
  }
}

let latest: Capacity | null = null

/** The last budget measured in this tab, or null before the first measurement. */
export function currentCapacity(): Capacity | null {
  return latest
}

export async function measureCapacity(g?: CapacityGlobals): Promise<Capacity> {
  latest = computeCapacity(await readCapacitySignals(g))
  return latest
}
