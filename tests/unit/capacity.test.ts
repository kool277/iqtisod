import { describe, expect, it } from 'vitest'
import {
  BACKUP_ENVELOPE_BYTES,
  ENGINE_MAX_BYTES,
  MEMORY_FLOOR_BYTES,
  PEAK_MEMORY_MULTIPLE,
  SAFETY_MARGIN,
  STORAGE_MULTIPLE,
  backupFileBytesFor,
  computeCapacity,
  currentCapacity,
  growthBudget,
  isMobile,
  measureCapacity,
  readCapacitySignals,
  vaultBytesForFile,
  type CapacityGlobals,
  type CapacitySignals,
} from '../../src/lib/capacity'
import { LIMITS, formatBytes } from '../../src/lib/limits'

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
  ...overrides,
})

const CHROME_DESKTOP = signals({ deviceMemoryGiB: 8, jsHeap: { used: 40 * MIB, limit: 4 * GIB }, quota: 300 * GB, usage: 2 * MIB, persisted: true })
const IPHONE_SAFARI = signals({ mobile: true, quota: 60 * GB, usage: 1 * MIB })
const LOW_END_ANDROID = signals({ mobile: true, deviceMemoryGiB: 2, jsHeap: { used: 25 * MIB, limit: 1 * GIB }, quota: 8 * GB, usage: 1 * MIB })

describe('computeCapacity', () => {
  it('gives desktop Chrome with 8 GB a budget far above the old 72 MB, limited by memory', () => {
    const capacity = computeCapacity(CHROME_DESKTOP)
    expect(capacity.limitedBy).toBe('memory')
    expect(capacity.deviceMemoryReported).toBe(true)
    const expected = Math.floor((((8 * GIB) / 4 - 40 * MIB) / PEAK_MEMORY_MULTIPLE) * SAFETY_MARGIN / MIB) * MIB
    expect(capacity.vaultBytes).toBe(expected)
    expect(capacity.vaultBytes).toBeGreaterThan(300 * MIB)
    expect(capacity.fileBytes).toBe(backupFileBytesFor(capacity.vaultBytes))
    expect(capacity.fileBytes).toBeGreaterThan(400 * MIB)
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

  it('is limited by the SQLite engine on a device with plenty of memory and space', () => {
    const capacity = computeCapacity({ ...CHROME_DESKTOP, deviceMemoryGiB: 64 })
    expect(capacity).toMatchObject({ limitedBy: 'engine', vaultBytes: ENGINE_MAX_BYTES, engineBytes: ENGINE_MAX_BYTES })
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
  it('is never below the fixed 48 MB budget and warns at three quarters of a larger one', () => {
    expect(growthBudget(null)).toEqual({ budgetBytes: LIMITS.databaseBudgetBytes, warnBytes: LIMITS.databaseWarnBytes })
    expect(growthBudget(computeCapacity({ ...CHROME_DESKTOP, quota: 100 * MIB, usage: 90 * MIB })).budgetBytes).toBe(LIMITS.databaseBudgetBytes)
    const desktop = computeCapacity(CHROME_DESKTOP)
    expect(growthBudget(desktop)).toEqual({ budgetBytes: desktop.vaultBytes, warnBytes: Math.floor((desktop.vaultBytes * 0.75) / MIB) * MIB })
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
    expect(await readCapacitySignals({})).toEqual(signals({ mobile: true }))
  })

  it('tells phones and tablets from desktops', () => {
    expect(isMobile({ navigator: { userAgentData: { mobile: false }, userAgent: 'Android Mobile' } })).toBe(false)
    expect(isMobile({ navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' } })).toBe(true)
    // iPadOS reports a Mac user agent.
    expect(isMobile({ navigator: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 } })).toBe(true)
    expect(isMobile({ navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } })).toBe(false)
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
