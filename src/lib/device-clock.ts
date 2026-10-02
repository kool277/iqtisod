/**
 * The latest time this browser has seen, kept outside the vault so it moves on every load and focus, not only on
 * saves. Code expiry and the clock check use the larger of this and the vault's own mark, so turning the device clock
 * back does not revive an expired code. Each observation may raise it by at most {@link CLOCK_STEP_MAX_MS}, so one
 * wrong far-future reading cannot block codes for years; an Admin can reset it.
 */
export const DEVICE_CLOCK_KEY = 'moliya.clock.v1'
export const CLOCK_STEP_MAX_MS = 2 * 24 * 60 * 60_000

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>

let memory: number | null = null

function browserStorage(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function readStored(storage: KeyValueStore | null): number | null {
  if (!storage) return null
  try {
    const value = storage.getItem(DEVICE_CLOCK_KEY)
    if (value === null || !/^\d{1,15}$/.test(value)) return null
    const time = Number(value)
    return Number.isSafeInteger(time) ? time : null
  } catch {
    return null
  }
}

function write(storage: KeyValueStore | null, time: number): void {
  memory = time
  try {
    storage?.setItem(DEVICE_CLOCK_KEY, String(time))
  } catch {
    // The in-memory mark still applies for this tab.
  }
}

/** Never lower than `previous`, never more than one step above it. */
export function boundedRaise(previous: number | null, now: number): number {
  if (previous === null) return now
  return Math.max(previous, Math.min(now, previous + CLOCK_STEP_MAX_MS))
}

export function deviceClockFloor(storage: KeyValueStore | null = browserStorage()): number | null {
  const stored = readStored(storage)
  if (stored === null) return memory
  return memory === null ? stored : Math.max(stored, memory)
}

export function observeClock(now = Date.now(), storage: KeyValueStore | null = browserStorage()): number {
  const next = boundedRaise(deviceClockFloor(storage), now)
  write(storage, next)
  return next
}

export function resetDeviceClock(now = Date.now(), storage: KeyValueStore | null = browserStorage()): void {
  write(storage, now)
}
