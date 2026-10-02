import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../../src/domain/errors'
import {
  BASE_LOCKOUT_MS,
  ENTRY_TTL_MS,
  FREE_FAILURES,
  GLOBAL_FREE_FAILURES,
  MAX_ENTRIES,
  MAX_LOCKOUT_MS,
  THROTTLE_KEY,
  ThrottledError,
  createThrottle,
  formatWait,
  lockoutMs,
  type ThrottleMirror,
  type ThrottleScope,
} from '../../src/lib/throttle'

const START = Date.parse('2026-09-29T10:00:00.000Z')

class MemoryStorage {
  readonly map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value))
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  clear(): void {
    this.map.clear()
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }
  get length(): number {
    return this.map.size
  }
}

function clock(start = START) {
  let current = start
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
    set: (ms: number) => {
      current = ms
    },
  }
}

function failTimes(throttle: ReturnType<typeof createThrottle>, scope: ThrottleScope, email: string, times: number): number {
  let wait = 0
  for (let index = 0; index < times; index += 1) wait = throttle.fail(scope, email)
  return wait
}

describe('lockoutMs', () => {
  it('allows the free failures, then doubles from 30 s up to 15 min', () => {
    expect(FREE_FAILURES).toBe(5)
    expect(GLOBAL_FREE_FAILURES).toBe(20)
    expect(BASE_LOCKOUT_MS).toBe(30_000)
    expect(MAX_LOCKOUT_MS).toBe(900_000)
    for (let failures = 0; failures < FREE_FAILURES; failures += 1) expect(lockoutMs(failures, FREE_FAILURES)).toBe(0)
    expect([5, 6, 7, 8, 9, 10, 11, 50].map((failures) => lockoutMs(failures, FREE_FAILURES))).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000,
    ])
    expect(lockoutMs(10_000, FREE_FAILURES)).toBe(MAX_LOCKOUT_MS)
    expect(lockoutMs(19, GLOBAL_FREE_FAILURES)).toBe(0)
    expect(lockoutMs(20, GLOBAL_FREE_FAILURES)).toBe(30_000)
  })
})

describe('createThrottle', () => {
  it('locks an email out after five failures and counts the wait down', () => {
    const time = clock()
    const throttle = createThrottle({ storage: new MemoryStorage(), now: time.now })
    for (let attempt = 1; attempt < FREE_FAILURES; attempt += 1) {
      expect(throttle.fail('login', 'a@x.uz'), `attempt ${attempt}`).toBe(0)
      expect(throttle.wait('login', 'a@x.uz')).toBe(0)
    }
    expect(throttle.fail('login', 'a@x.uz')).toBe(30_000)
    expect(throttle.wait('login', 'a@x.uz')).toBe(30_000)
    time.advance(12_000)
    expect(throttle.wait('login', 'a@x.uz')).toBe(18_000)
    time.advance(18_000)
    expect(throttle.wait('login', 'a@x.uz')).toBe(0)
    expect(throttle.fail('login', 'a@x.uz')).toBe(60_000)
    expect(throttle.fail('login', 'a@x.uz')).toBe(120_000)
  })

  it('caps the lockout at 15 minutes', () => {
    const throttle = createThrottle({ storage: new MemoryStorage(), now: clock().now })
    expect(failTimes(throttle, 'login', 'a@x.uz', 30)).toBe(MAX_LOCKOUT_MS)
  })

  it('keys by trimmed, lower-cased email and keeps emails apart', () => {
    const throttle = createThrottle({ storage: new MemoryStorage(), now: clock().now })
    failTimes(throttle, 'login', 'Ali@X.uz', 3)
    failTimes(throttle, 'login', '  ali@x.uz ', 2)
    expect(throttle.wait('login', 'ali@x.uz')).toBe(30_000)
    expect(throttle.wait('login', 'vali@x.uz')).toBe(0)
  })

  it('keeps scopes apart', () => {
    const throttle = createThrottle({ storage: new MemoryStorage(), now: clock().now })
    failTimes(throttle, 'login', 'a@x.uz', FREE_FAILURES)
    const others: ThrottleScope[] = ['code', 'totp', 'safe']
    for (const scope of others) expect(throttle.wait(scope, 'a@x.uz'), scope).toBe(0)
    for (const scope of others) expect(failTimes(throttle, scope, 'a@x.uz', FREE_FAILURES), scope).toBe(30_000)
  })

  it('locks failing emails after twenty failures spread across emails, but never a clean one', () => {
    const throttle = createThrottle({ storage: new MemoryStorage(), now: clock().now })
    for (let index = 0; index < GLOBAL_FREE_FAILURES - 1; index += 1) expect(throttle.fail('code', `u${index}@x.uz`)).toBe(0)
    expect(throttle.wait('code', 'u0@x.uz')).toBe(0)
    expect(throttle.fail('code', `u19@x.uz`)).toBe(30_000)
    expect(throttle.wait('code', 'u0@x.uz')).toBe(30_000)
    expect(throttle.wait('code', 'fresh@x.uz')).toBe(0)
    expect(throttle.wait('login', 'u0@x.uz')).toBe(0)
  })

  it('reports failures since the first one on success and resets the counters', () => {
    const time = clock()
    const throttle = createThrottle({ storage: new MemoryStorage(), now: time.now })
    expect(throttle.succeed('login', 'a@x.uz')).toEqual({ failures: 0, since: null })
    throttle.fail('login', 'a@x.uz')
    time.advance(60_000)
    failTimes(throttle, 'login', 'a@x.uz', 5)
    expect(throttle.wait('login', 'a@x.uz')).toBeGreaterThan(0)
    expect(throttle.succeed('login', 'A@x.uz')).toEqual({ failures: 6, since: new Date(START).toISOString() })
    expect(throttle.wait('login', 'a@x.uz')).toBe(0)
    expect(throttle.succeed('login', 'a@x.uz')).toEqual({ failures: 0, since: null })
    expect(throttle.fail('login', 'a@x.uz')).toBe(0)
  })

  it('success for one email does not clear another email', () => {
    const throttle = createThrottle({ storage: new MemoryStorage(), now: clock().now })
    failTimes(throttle, 'login', 'a@x.uz', FREE_FAILURES)
    failTimes(throttle, 'login', 'b@x.uz', 1)
    throttle.succeed('login', 'b@x.uz')
    expect(throttle.wait('login', 'a@x.uz')).toBe(30_000)
  })

  it('forgets entries after 24 hours', () => {
    const time = clock()
    const throttle = createThrottle({ storage: new MemoryStorage(), now: time.now })
    failTimes(throttle, 'login', 'a@x.uz', 12)
    time.advance(ENTRY_TTL_MS - 1)
    expect(throttle.wait('login', 'a@x.uz')).toBe(0)
    expect(throttle.fail('login', 'a@x.uz')).toBe(MAX_LOCKOUT_MS)
    time.advance(ENTRY_TTL_MS)
    expect(throttle.succeed('login', 'a@x.uz')).toEqual({ failures: 0, since: null })
    expect(throttle.fail('login', 'a@x.uz')).toBe(0)
  })

  it('does not shorten a lockout when the clock moves backwards', () => {
    const time = clock()
    const throttle = createThrottle({ storage: new MemoryStorage(), now: time.now })
    failTimes(throttle, 'login', 'a@x.uz', FREE_FAILURES)
    time.advance(-3_600_000)
    expect(throttle.wait('login', 'a@x.uz')).toBe(30_000)
  })

  it('persists hashed state under moliya.guard.v1 and shares it between instances', () => {
    const storage = new MemoryStorage()
    const time = clock()
    const first = createThrottle({ storage, now: time.now })
    failTimes(first, 'login', 'Secret.Person@x.uz', FREE_FAILURES)
    expect(THROTTLE_KEY).toBe('moliya.guard.v1')
    const raw = storage.getItem(THROTTLE_KEY)!
    expect(raw).not.toContain('secret')
    expect(raw).not.toContain('person')
    const state = JSON.parse(raw) as Record<string, { n: number; first: number; last: number }>
    expect(Object.keys(state).sort()).toEqual(['login|*', expect.stringMatching(/^login\|[0-9a-f]{16}$/)])
    expect(state['login|*']).toEqual({ n: 5, first: START, last: START })

    const second = createThrottle({ storage, now: time.now })
    expect(second.wait('login', 'secret.person@x.uz')).toBe(30_000)
  })

  it('keeps at most 64 entries, dropping the oldest', () => {
    const storage = new MemoryStorage()
    const time = clock()
    const throttle = createThrottle({ storage, now: time.now })
    for (let index = 0; index < 100; index += 1) {
      throttle.fail('login', `u${index}@x.uz`)
      time.advance(1)
    }
    const state = JSON.parse(storage.getItem(THROTTLE_KEY)!) as Record<string, unknown>
    expect(Object.keys(state)).toHaveLength(MAX_ENTRIES)
    expect(state).toHaveProperty(['login|*'])
    expect(throttle.succeed('login', 'u0@x.uz').failures).toBe(0)
    expect(throttle.succeed('login', 'u99@x.uz').failures).toBe(1)
  })

  it('tolerates corrupted storage', () => {
    for (const garbage of ['not json', '[]', 'null', '42', '"text"', '{"login|*":{"n":-1,"first":0,"last":0},"x":"y","z":{"n":1.5,"first":0,"last":0}}']) {
      const storage = new MemoryStorage()
      storage.setItem(THROTTLE_KEY, garbage)
      const throttle = createThrottle({ storage, now: clock().now })
      expect(throttle.wait('login', 'a@x.uz'), garbage).toBe(0)
      expect(failTimes(throttle, 'login', 'a@x.uz', FREE_FAILURES), garbage).toBe(30_000)
      expect(() => JSON.parse(storage.getItem(THROTTLE_KEY)!), garbage).not.toThrow()
    }
  })

  it('drops invalid entries but keeps valid ones', () => {
    const storage = new MemoryStorage()
    storage.setItem(THROTTLE_KEY, JSON.stringify({ 'login|*': { n: 25, first: START, last: START }, bad: { n: 'x' } }))
    const throttle = createThrottle({ storage, now: clock().now })
    expect(throttle.wait('login', 'anyone@x.uz')).toBe(0)
    throttle.fail('login', 'anyone@x.uz')
    expect(throttle.wait('login', 'anyone@x.uz')).toBe(lockoutMs(26, GLOBAL_FREE_FAILURES))
    expect(Object.keys(JSON.parse(storage.getItem(THROTTLE_KEY)!))).not.toContain('bad')
  })

  it('throttles in memory when there is no storage', () => {
    const throttle = createThrottle({ storage: null, now: clock().now })
    expect(failTimes(throttle, 'totp', 'a@x.uz', FREE_FAILURES)).toBe(30_000)
    expect(throttle.wait('totp', 'a@x.uz')).toBe(30_000)
  })

  it('throttles in memory when storage throws on read', () => {
    const storage = {
      getItem: (): string | null => {
        throw new Error('SecurityError')
      },
      setItem: () => undefined,
    }
    const throttle = createThrottle({ storage, now: clock().now })
    expect(failTimes(throttle, 'login', 'a@x.uz', FREE_FAILURES)).toBe(30_000)
  })

  it('throttles in memory when storage refuses writes', () => {
    const storage = {
      getItem: (): string | null => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    const throttle = createThrottle({ storage, now: clock().now })
    expect(failTimes(throttle, 'login', 'a@x.uz', FREE_FAILURES)).toBe(30_000)
  })
})

describe('createThrottle counter durability', () => {
  class MemoryMirror implements ThrottleMirror {
    value: unknown = undefined
    load = async () => this.value
    save = async (state: unknown) => {
      this.value = structuredClone(state)
    }
  }

  it('keeps counting in memory after local storage is cleared', () => {
    const storage = new MemoryStorage()
    const throttle = createThrottle({ storage, now: clock().now })
    failTimes(throttle, 'login', 'a@x.uz', FREE_FAILURES)
    storage.clear()
    expect(throttle.wait('login', 'a@x.uz')).toBe(30_000)
    expect(throttle.fail('login', 'a@x.uz')).toBe(60_000)
  })

  it('takes the larger of the in-memory and stored counts', () => {
    const storage = new MemoryStorage()
    const time = clock()
    const throttle = createThrottle({ storage, now: time.now })
    failTimes(throttle, 'login', 'a@x.uz', FREE_FAILURES + 1)
    const otherStorage = new MemoryStorage()
    createThrottle({ storage: otherStorage, now: time.now }).fail('login', 'a@x.uz')
    storage.setItem(THROTTLE_KEY, otherStorage.getItem(THROTTLE_KEY)!)
    expect(throttle.wait('login', 'a@x.uz')).toBe(60_000)
  })

  it('restores the counters from the mirror when local storage was wiped', async () => {
    const time = clock()
    const mirror = new MemoryMirror()
    const first = createThrottle({ storage: new MemoryStorage(), now: time.now, mirror })
    await first.ready
    failTimes(first, 'login', 'a@x.uz', FREE_FAILURES)
    await Promise.resolve()
    const second = createThrottle({ storage: new MemoryStorage(), now: time.now, mirror })
    expect(second.wait('login', 'a@x.uz')).toBe(0)
    await second.ready
    expect(second.wait('login', 'a@x.uz')).toBe(30_000)
  })

  it('does not bring back counters a success cleared from a stale mirror', async () => {
    const time = clock()
    let release: () => void = () => undefined
    const stale = { 'login|*': { n: 9, first: START, last: START } } as Record<string, unknown>
    const mirror: ThrottleMirror = {
      load: () => new Promise((resolve) => (release = () => resolve(stale))),
      save: async () => undefined,
    }
    const throttle = createThrottle({ storage: new MemoryStorage(), now: time.now, mirror })
    failTimes(throttle, 'login', 'a@x.uz', 2)
    time.advance(1)
    throttle.succeed('login', 'a@x.uz')
    release()
    await throttle.ready
    expect(throttle.fail('login', 'a@x.uz')).toBe(0)
  })

  it('survives a failing mirror', async () => {
    const mirror: ThrottleMirror = { load: async () => Promise.reject(new Error('blocked')), save: async () => Promise.reject(new Error('blocked')) }
    const throttle = createThrottle({ storage: new MemoryStorage(), now: clock().now, mirror })
    await throttle.ready
    expect(failTimes(throttle, 'login', 'a@x.uz', FREE_FAILURES)).toBe(30_000)
  })

  it('counts notes per email without locking and reports them via peek until a success', () => {
    const throttle = createThrottle({ storage: new MemoryStorage(), now: clock().now })
    for (let index = 0; index < 30; index += 1) throttle.note('check', 'a@x.uz')
    expect(throttle.peek('check', 'a@x.uz')).toEqual({ failures: 30, since: new Date(START).toISOString() })
    expect(throttle.peek('check', 'b@x.uz')).toEqual({ failures: 0, since: null })
    expect(throttle.wait('login', 'a@x.uz')).toBe(0)
    expect(throttle.succeed('check', 'a@x.uz').failures).toBe(30)
    expect(throttle.peek('check', 'a@x.uz').failures).toBe(0)
  })

  it('peek does not reset anything', () => {
    const throttle = createThrottle({ storage: new MemoryStorage(), now: clock().now })
    failTimes(throttle, 'login', 'a@x.uz', FREE_FAILURES)
    expect(throttle.peek('login', 'a@x.uz').failures).toBe(FREE_FAILURES)
    expect(throttle.wait('login', 'a@x.uz')).toBe(30_000)
  })
})

describe('createThrottle with the browser defaults', () => {
  let storage: MemoryStorage

  beforeEach(() => {
    storage = new MemoryStorage()
    vi.stubGlobal('localStorage', storage)
    vi.useFakeTimers()
    vi.setSystemTime(START)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('uses localStorage and Date.now', () => {
    const throttle = createThrottle()
    expect(failTimes(throttle, 'safe', 'a@x.uz', FREE_FAILURES)).toBe(30_000)
    expect(storage.getItem(THROTTLE_KEY)).toContain('safe|*')
    vi.advanceTimersByTime(10_000)
    expect(throttle.wait('safe', 'a@x.uz')).toBe(20_000)
    vi.setSystemTime(START + 30_000)
    expect(createThrottle().wait('safe', 'a@x.uz')).toBe(0)
  })
})

describe('ThrottledError', () => {
  it('is an AppError with code THROTTLED and the wait', () => {
    const error = new ThrottledError(12_345)
    expect(error).toBeInstanceOf(AppError)
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe('THROTTLED')
    expect(error.waitMs).toBe(12_345)
    expect(error.name).toBe('ThrottledError')
  })
})

describe('formatWait', () => {
  it('shows minutes and seconds, rounding up and never below one second', () => {
    expect(formatWait(0)).toBe('0:01')
    expect(formatWait(-5)).toBe('0:01')
    expect(formatWait(1)).toBe('0:01')
    expect(formatWait(30_000)).toBe('0:30')
    expect(formatWait(59_001)).toBe('1:00')
    expect(formatWait(90_000)).toBe('1:30')
    expect(formatWait(MAX_LOCKOUT_MS)).toBe('15:00')
  })
})
