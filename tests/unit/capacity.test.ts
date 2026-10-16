import { describe, expect, it } from 'vitest'
import {
  BACKUP_ENVELOPE_BYTES,
  BROWSER_MAX_BYTES,
  CHROMIUM_IDB_VALUE_MAX_BYTES,
  ENGINE_MAX_BYTES,
  GROWTH_SHARE,
  MEMORY_FLOOR_BYTES,
  PEAK_MEMORY_MULTIPLE,
  SAFETY_MARGIN,
  STORAGE_MULTIPLE,
  backupFileBytesFor,
  computeCapacity,
  currentCapacity,
  growthBudget,
  isChromium,
  isMobile,
  measureCapacity,
  onCapacity,
  readCapacitySignals,
  vaultBytesForFile,
  type CapacityGlobals,
  type CapacitySignals,
} from '../../src/lib/capacity'
import { LIMITS, formatBytes, restoreLimitBytes } from '../../src/lib/limits'

const MIB = 1024 * 1024
const GIB = 1024 * MIB
const GB = 1000 * 1000 * 1000

const signals = (overrides: Partial<CapacitySignals> = {}): CapacitySignals => ({
  quota: null,
  usage: null,
  persisted: null,
  deviceMemoryGiB: null,
  jsHeap: null,
  mobile: false,
  chromium: false,
  ...overrides,
})

const CHROME_DESKTOP = signals({ chromium: true, deviceMemoryGiB: 8, jsHeap: { used: 40 * MIB, limit: 4 * GIB }, quota: 300 * GB, usage: 2 * MIB, persisted: true })
/** The same computer in a browser that stores large IndexedDB values (Firefox and Safari report no memory signals). */
const LARGE_VALUES_DESKTOP = { ...CHROME_DESKTOP, chromium: false }
const IPHONE_SAFARI = signals({ mobile: true, quota: 60 * GB, usage: 1 * MIB })
const LOW_END_ANDROID = signals({ chromium: true, mobile: true, deviceMemoryGiB: 2, jsHeap: { used: 25 * MIB, limit: 1 * GIB }, quota: 8 * GB, usage: 1 * MIB })
const MEMORY_8GB_DESKTOP = Math.floor((((8 * GIB) / 4 - 40 * MIB) / PEAK_MEMORY_MULTIPLE) * SAFETY_MARGIN / MIB) * MIB

describe('computeCapacity', () => {
  it('limits Chrome to the largest vault it can save, far below what its memory allows', () => {
    const capacity = computeCapacity(CHROME_DESKTOP)
    expect(capacity.limitedBy).toBe('browser')
    expect(capacity.deviceMemoryReported).toBe(true)
    expect(capacity.memoryBytes).toBe(MEMORY_8GB_DESKTOP)
    expect(capacity.browserBytes).toBe(BROWSER_MAX_BYTES)
    expect(capacity.vaultBytes).toBe(126 * MIB)
    // The stored record fits what Chromium accepts: ciphertext and GCM tag, plus an envelope of up to 256 wraps and
    // 64 codes, which the backup budget puts at 512 KiB.
    expect(BROWSER_MAX_BYTES + 16 + BACKUP_ENVELOPE_BYTES).toBeLessThanOrEqual(CHROMIUM_IDB_VALUE_MAX_BYTES)
    expect(capacity.fileBytes).toBe(backupFileBytesFor(capacity.vaultBytes))
    expect(capacity.fileBytes).toBeGreaterThan(72 * MIB)
  })

  it('does not hold a vault stored in chunks to Chromium\'s single-value limit', () => {
    const capacity = computeCapacity(CHROME_DESKTOP, { chunked: true })
    expect(capacity.browserBytes).toBeNull()
    expect(capacity.limitedBy).toBe('memory')
    expect(capacity.vaultBytes).toBe(MEMORY_8GB_DESKTOP)
    expect(computeCapacity(CHROME_DESKTOP, { chunked: false }).limitedBy).toBe('browser')
  })

  it('gives a desktop browser that stores large values a budget far above the old 72 MB, limited by memory', () => {
    const capacity = computeCapacity(LARGE_VALUES_DESKTOP)
    expect(capacity.limitedBy).toBe('memory')
    expect(capacity.browserBytes).toBeNull()
    expect(capacity.vaultBytes).toBe(MEMORY_8GB_DESKTOP)
    expect(capacity.vaultBytes).toBeGreaterThan(300 * MIB)
    expect(capacity.fileBytes).toBeGreaterThan(400 * MIB)
  })

  it('counts at most 8 GB of device memory, though Chrome now reports 16 and 32', () => {
    for (const deviceMemoryGiB of [16, 32, 64]) {
      const capacity = computeCapacity({ ...LARGE_VALUES_DESKTOP, deviceMemoryGiB })
      expect(capacity.deviceMemoryBytes).toBe(8 * GIB)
      expect(capacity).toMatchObject({ limitedBy: 'memory', vaultBytes: MEMORY_8GB_DESKTOP })
    }
  })

  it('assumes 3 GB for a phone that does not report its memory (Safari)', () => {
    const capacity = computeCapacity(IPHONE_SAFARI)
    expect(capacity.deviceMemoryReported).toBe(false)
    expect(capacity.deviceMemoryBytes).toBe(3 * GIB)
    expect(capacity.limitedBy).toBe('memory')
    expect(capacity.vaultBytes).toBe(Math.floor((((3 * GIB) * 0.2) / PEAK_MEMORY_MULTIPLE) * SAFETY_MARGIN / MIB) * MIB)
    expect(capacity.fileBytes).toBeGreaterThan(72 * MIB)
  })

  it('assumes 8 GB for a desktop browser that does not report its memory (Safari, Firefox)', () => {
    expect(computeCapacity(signals()).deviceMemoryBytes).toBe(8 * GIB)
  })

  it('never goes below the 72 MB every device accepted before 1.7.0', () => {
    const tiny = computeCapacity(signals({ mobile: true, deviceMemoryGiB: 0.5, jsHeap: { used: 200 * MIB, limit: GIB } }))
    expect(tiny.limitedBy).toBe('memory')
    expect(tiny.vaultBytes).toBe(MEMORY_FLOOR_BYTES)
    expect(tiny.fileBytes).toBe(LIMITS.importFileBytes)
    const lowEnd = computeCapacity(LOW_END_ANDROID)
    expect(lowEnd.vaultBytes).toBeGreaterThanOrEqual(tiny.vaultBytes)
  })

  it('is limited by free storage when the browser offers little room, without a floor', () => {
    const capacity = computeCapacity({ ...CHROME_DESKTOP, quota: 200 * MIB, usage: 50 * MIB })
    expect(capacity.limitedBy).toBe('storage')
    expect(capacity.storageBytes).toBe(Math.floor(((150 * MIB) / STORAGE_MULTIPLE) * SAFETY_MARGIN / MIB) * MIB)
    expect(capacity.vaultBytes).toBe(capacity.storageBytes)
    expect(computeCapacity({ ...CHROME_DESKTOP, quota: 10 * MIB, usage: 20 * MIB })).toMatchObject({ limitedBy: 'storage', vaultBytes: 0 })
  })

  it('keeps every budget below the 640 MiB the SQLite engine can open, since memory counts up to 8 GB', () => {
    const capacity = computeCapacity({ ...LARGE_VALUES_DESKTOP, deviceMemoryGiB: 64, jsHeap: null })
    expect(capacity.limitedBy).toBe('memory')
    expect(capacity.vaultBytes).toBeLessThan(ENGINE_MAX_BYTES)
    expect(capacity.engineBytes).toBe(ENGINE_MAX_BYTES)
    expect(ENGINE_MAX_BYTES).toBe(640 * MIB)
  })

  it('ignores signals that are missing, negative or not numbers', () => {
    const odd = computeCapacity(signals({ quota: Number.NaN, usage: -1, deviceMemoryGiB: -4, jsHeap: { used: Number.POSITIVE_INFINITY, limit: 1 } }))
    expect(odd.storageBytes).toBeNull()
    expect(odd.deviceMemoryReported).toBe(false)
    expect(odd.limitedBy).toBe('memory')
    expect(computeCapacity(signals({ quota: 100 * GB, usage: null })).storageBytes).toBeNull()
  })

  it('round-trips between vault size and backup file size', () => {
    for (const vault of [0, 1, 2, 3, 1000, 48 * MIB, 321 * MIB + 7]) {
      const file = backupFileBytesFor(vault)
      expect(file).toBe(Math.ceil(vault / 3) * 4 + BACKUP_ENVELOPE_BYTES)
      expect(vaultBytesForFile(file)).toBeGreaterThanOrEqual(vault)
      expect(vaultBytesForFile(file) - vault).toBeLessThan(3)
    }
    expect(vaultBytesForFile(100)).toBe(0)
  })
})

describe('growthBudget', () => {
  it('stops receipts at nine tenths of the budget, never below the fixed 48 MB, and warns at three quarters of that', () => {
    expect(growthBudget(null)).toEqual({ budgetBytes: LIMITS.databaseBudgetBytes, warnBytes: LIMITS.databaseWarnBytes })
    expect(growthBudget(computeCapacity({ ...CHROME_DESKTOP, quota: 100 * MIB, usage: 90 * MIB })).budgetBytes).toBe(LIMITS.databaseBudgetBytes)
    // 13 MiB of room in Chrome for records added after the last receipt, before the vault could no longer be saved.
    expect(growthBudget(computeCapacity(CHROME_DESKTOP))).toEqual({ budgetBytes: 113 * MIB, warnBytes: 84 * MIB })
    const desktop = computeCapacity(LARGE_VALUES_DESKTOP)
    const budget = Math.floor((desktop.vaultBytes * GROWTH_SHARE) / MIB) * MIB
    expect(growthBudget(desktop)).toEqual({ budgetBytes: budget, warnBytes: Math.floor((budget * 0.75) / MIB) * MIB })
    expect(budget).toBeLessThan(desktop.vaultBytes)
  })
})

describe('restoreLimitBytes', () => {
  it('accepts the 72 MB of earlier versions when free storage is the tighter limit, and the budget above it', () => {
    for (const [quota, usage] of [[120 * MIB, 0], [3 * MIB, 0], [10 * MIB, 20 * MIB]]) {
      const low = computeCapacity({ ...CHROME_DESKTOP, quota, usage })
      expect(low.limitedBy).toBe('storage')
      expect(low.fileBytes).toBeLessThan(LIMITS.importFileBytes)
      expect(restoreLimitBytes(low.fileBytes)).toBe(LIMITS.importFileBytes)
    }
    const desktop = computeCapacity(CHROME_DESKTOP)
    expect(restoreLimitBytes(desktop.fileBytes)).toBe(desktop.fileBytes)
  })
})

describe('reading the signals', () => {
  it('reads storage, memory and form factor from the browser', async () => {
    const g: CapacityGlobals = {
      navigator: {
        deviceMemory: 4,
        userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile',
        storage: { estimate: async () => ({ quota: 5 * GB, usage: 3 * MIB }), persisted: async () => true },
      },
      performance: { memory: { usedJSHeapSize: 30 * MIB, jsHeapSizeLimit: GIB } },
    }
    expect(await readCapacitySignals(g)).toEqual({
      quota: 5 * GB,
      usage: 3 * MIB,
      persisted: true,
      deviceMemoryGiB: 4,
      jsHeap: { used: 30 * MIB, limit: GIB },
      mobile: true,
      chromium: false,
    })
  })

  it('falls back when the APIs are missing, throw or reject', async () => {
    const throwing: CapacityGlobals = {
      navigator: {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605.1.15',
        maxTouchPoints: 0,
        storage: {
          estimate: () => {
            throw new Error('denied')
          },
          persisted: () => Promise.reject(new Error('denied')),
        },
      },
    }
    expect(await readCapacitySignals(throwing)).toEqual(signals({ mobile: false }))
    // Nothing known about the browser: the stricter limits of a phone and of Chromium.
    expect(await readCapacitySignals({})).toEqual(signals({ mobile: true, chromium: true }))
  })

  it('tells Chromium browsers, whose IndexedDB caps the vault, from Firefox and Safari', () => {
    const agent = (userAgent: string) => isChromium({ navigator: { userAgent } })
    expect(agent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36')).toBe(true)
    expect(agent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0')).toBe(true)
    expect(agent('Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/29.0 Chrome/140.0.0.0 Mobile Safari/537.36')).toBe(true)
    expect(agent('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:157.0) Gecko/20100101 Firefox/157.0')).toBe(false)
    expect(agent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15')).toBe(false)
    // Every iOS browser, Chrome included, runs on WebKit.
    expect(agent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/151.0 Mobile/15E148 Safari/604.1')).toBe(false)
    expect(isChromium({ navigator: { userAgent: 'Firefox/157.0', userAgentData: { mobile: false } } })).toBe(true)
    expect(isChromium({ navigator: { userAgent: '' } })).toBe(true)
    expect(isChromium({})).toBe(true)
  })

  it('tells phones and tablets from desktops', () => {
    expect(isMobile({ navigator: { userAgentData: { mobile: false }, userAgent: 'Android Mobile' } })).toBe(false)
    expect(isMobile({ navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' } })).toBe(true)
    // iPadOS reports a Mac user agent.
    expect(isMobile({ navigator: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 } })).toBe(true)
    expect(isMobile({ navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } })).toBe(false)
  })

  it('tells subscribers about every new measurement until they stop listening', async () => {
    const seen: number[] = []
    const stop = onCapacity((capacity) => seen.push(capacity.vaultBytes))
    const roomy = { navigator: { userAgent: 'Windows', storage: { estimate: async () => ({ quota: 50 * GB, usage: 0 }) } } }
    const cramped = { navigator: { userAgent: 'Windows', storage: { estimate: async () => ({ quota: 200 * MIB, usage: 0 }) } } }
    const first = await measureCapacity(roomy)
    const second = await measureCapacity(cramped)
    expect(seen).toEqual([first.vaultBytes, second.vaultBytes])
    expect(second.vaultBytes).toBeLessThan(first.vaultBytes)
    stop()
    await measureCapacity(roomy)
    expect(seen).toHaveLength(2)
  })

  it('remembers the last measurement for the rest of the app', async () => {
    const measured = await measureCapacity({ navigator: { deviceMemory: 8, userAgent: 'Windows', storage: { estimate: async () => ({ quota: 50 * GB, usage: 0 }) } } })
    expect(currentCapacity()).toBe(measured)
    expect(measured.limitedBy).toBe('memory')
  })

  it('formats sizes for people', () => {
    expect(formatBytes(72 * MIB)).toBe('72 MB')
    expect(formatBytes(1.5 * GIB)).toBe('1.5 GB')
    expect(formatBytes(10)).toBe('1 MB')
  })
})
