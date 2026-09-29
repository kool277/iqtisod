import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTIVITY_EVENTS, DEFAULT_IDLE_MINUTES, IDLE_CHECK_MS, readIdleMinutes, watchIdle, type IdleMinutes } from '../../src/lib/idle'
import { createSafeSession } from '../../src/lib/safe-session'
import type { SafeKeyring } from '../../src/services/safe.service'

const MINUTE = 60_000

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible'
  set(state: DocumentVisibilityState) {
    this.visibilityState = state
    this.dispatchEvent(new Event('visibilitychange'))
  }
}

function fakeKeyring(userId = 'owner'): SafeKeyring {
  return {
    userId,
    personalKey: {} as CryptoKey,
    safeKeys: new Map(),
    openSafes: new Set(['guarded']),
    // The pre-1.3.1 safes timer would have locked after one minute.
    meta: { v: 1, order: [], defaultSafeId: '', autoLockMinutes: 1, clipboardSeconds: 30, revealSeconds: 15 },
    lastAuthAt: 0,
  }
}

/** Wires the pieces the way VaultProvider and SafeProvider do: the vault's idle lock signs out, and the safes follow. */
function openApp(idleMinutes: IdleMinutes | null) {
  const activity = new EventTarget()
  const visibility = new FakeDocument()
  const safes = createSafeSession()
  const vault = { user: 'owner' as string | null, idleLocks: 0 }
  const stop = watchIdle({
    idleMs: idleMinutes === null ? null : idleMinutes * MINUTE,
    onIdle: () => {
      vault.idleLocks += 1
      vault.user = null
      safes.follow(vault.user, false)
    },
    activity,
    visibility,
  })
  const keyring = fakeKeyring()
  safes.adopt(keyring)
  const lockVault = () => {
    vault.user = null
    safes.follow(vault.user, false)
  }
  return { activity, visibility, safes, vault, keyring, stop, lockVault }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('watchIdle', () => {
  it('fires once after the idle time without activity, and not before', () => {
    const onIdle = vi.fn()
    const stop = watchIdle({ idleMs: 5 * MINUTE, onIdle, activity: new EventTarget(), visibility: new FakeDocument() })
    vi.advanceTimersByTime(5 * MINUTE - IDLE_CHECK_MS)
    expect(onIdle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(IDLE_CHECK_MS)
    expect(onIdle).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60 * MINUTE)
    expect(onIdle).toHaveBeenCalledTimes(1)
    stop()
  })

  it.each(ACTIVITY_EVENTS)('counts %s as activity', (name) => {
    const onIdle = vi.fn()
    const activity = new EventTarget()
    const stop = watchIdle({ idleMs: 5 * MINUTE, onIdle, activity, visibility: new FakeDocument() })
    vi.advanceTimersByTime(4 * MINUTE)
    activity.dispatchEvent(new Event(name))
    vi.advanceTimersByTime(4 * MINUTE)
    expect(onIdle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(MINUTE + IDLE_CHECK_MS)
    expect(onIdle).toHaveBeenCalledTimes(1)
    stop()
  })

  it('checks as soon as a throttled background tab becomes visible again', () => {
    const onIdle = vi.fn()
    const visibility = new FakeDocument()
    const stop = watchIdle({ idleMs: 5 * MINUTE, onIdle, activity: new EventTarget(), visibility })
    visibility.set('hidden')
    vi.setSystemTime(Date.now() + 6 * MINUTE)
    expect(onIdle).not.toHaveBeenCalled()
    visibility.set('visible')
    expect(onIdle).toHaveBeenCalledTimes(1)
    stop()
  })

  it('does not fire for a short trip to another tab', () => {
    const onIdle = vi.fn()
    const visibility = new FakeDocument()
    const stop = watchIdle({ idleMs: 5 * MINUTE, onIdle, activity: new EventTarget(), visibility })
    visibility.set('hidden')
    vi.advanceTimersByTime(3 * MINUTE)
    visibility.set('visible')
    expect(onIdle).not.toHaveBeenCalled()
    stop()
  })

  it('never fires when there is no idle time', () => {
    const onIdle = vi.fn()
    const visibility = new FakeDocument()
    const stop = watchIdle({ idleMs: null, onIdle, activity: new EventTarget(), visibility })
    vi.advanceTimersByTime(48 * 60 * MINUTE)
    visibility.set('hidden')
    visibility.set('visible')
    expect(onIdle).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    stop()
  })

  it('stops watching once disposed', () => {
    const onIdle = vi.fn()
    const activity = new EventTarget()
    const stop = watchIdle({ idleMs: 5 * MINUTE, onIdle, activity, visibility: new FakeDocument() })
    stop()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(10 * MINUTE)
    expect(onIdle).not.toHaveBeenCalled()
  })
})

describe('readIdleMinutes', () => {
  it('reads the chosen time and falls back to the default', () => {
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) })
    expect(readIdleMinutes()).toBe(DEFAULT_IDLE_MINUTES)
    stored.set('moliya.idleMinutes', '30')
    expect(readIdleMinutes()).toBe(30)
    stored.set('moliya.idleMinutes', '1')
    expect(readIdleMinutes()).toBe(DEFAULT_IDLE_MINUTES)
  })
})

describe('safe session', () => {
  it('locks by hand and wipes the open safes', () => {
    const session = createSafeSession()
    const keyring = fakeKeyring()
    session.adopt(keyring)
    expect(session.keyring).toBe(keyring)
    expect(session.lock()).toBe(true)
    expect(session.keyring).toBeNull()
    expect(keyring.openSafes.size).toBe(0)
    expect(session.lock()).toBe(false)
  })

  it('stays open for the same person and locks on sign-out, another person, or a forced password change', () => {
    for (const [userId, mustChange] of [
      [null, false],
      ['someone-else', false],
      ['owner', true],
    ] as const) {
      const session = createSafeSession()
      session.adopt(fakeKeyring())
      expect(session.follow('owner', false)).toBe(false)
      expect(session.keyring).not.toBeNull()
      expect(session.follow(userId, mustChange)).toBe(true)
      expect(session.keyring).toBeNull()
    }
  })
})

describe('safes and the app idle lock', () => {
  it('keeps safes open past their old 1–5 minute timer and locks them with the app at the app lock time', () => {
    const app = openApp(15)
    vi.advanceTimersByTime(14 * MINUTE)
    expect(app.safes.keyring).toBe(app.keyring)
    expect(app.keyring.openSafes.has('guarded')).toBe(true)
    vi.advanceTimersByTime(MINUTE + IDLE_CHECK_MS)
    expect(app.vault.idleLocks).toBe(1)
    expect(app.safes.keyring).toBeNull()
    expect(app.keyring.openSafes.size).toBe(0)
    app.stop()
  })

  it('uses the lock time chosen under Account → Lock automatically', () => {
    vi.stubGlobal('localStorage', { getItem: () => '30', setItem: () => undefined })
    const app = openApp(readIdleMinutes())
    vi.advanceTimersByTime(29 * MINUTE)
    expect(app.safes.keyring).not.toBeNull()
    vi.advanceTimersByTime(MINUTE + IDLE_CHECK_MS)
    expect(app.safes.keyring).toBeNull()
    app.stop()
  })

  it('treats activity anywhere in the app, including inside safes, as activity for the safes', () => {
    const app = openApp(5)
    for (let step = 0; step < 12; step += 1) {
      vi.advanceTimersByTime(4 * MINUTE)
      app.activity.dispatchEvent(new Event(step % 2 ? 'keydown' : 'pointerdown'))
    }
    expect(app.safes.keyring).toBe(app.keyring)
    expect(app.vault.idleLocks).toBe(0)
    app.stop()
  })

  it('does not lock safes when the tab is hidden for a minute or two', () => {
    const app = openApp(15)
    app.visibility.set('hidden')
    vi.advanceTimersByTime(2 * MINUTE)
    app.visibility.set('visible')
    expect(app.safes.keyring).toBe(app.keyring)
    app.stop()
  })

  it('locks safes when the app is locked by hand', () => {
    const app = openApp(15)
    app.lockVault()
    expect(app.safes.keyring).toBeNull()
    expect(app.keyring.openSafes.size).toBe(0)
    app.stop()
  })

  it('keeps safes open without an app lock time until they or the app are locked', () => {
    const app = openApp(null)
    vi.advanceTimersByTime(24 * 60 * MINUTE)
    expect(app.safes.keyring).toBe(app.keyring)
    expect(app.safes.lock()).toBe(true)
    expect(app.safes.keyring).toBeNull()
    app.safes.adopt(fakeKeyring())
    app.lockVault()
    expect(app.safes.keyring).toBeNull()
    app.stop()
  })
})
