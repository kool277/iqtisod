export const IDLE_KEY = 'moliya.idleMinutes'
export const IDLE_CHOICES = [5, 15, 30, 60] as const
export type IdleMinutes = (typeof IDLE_CHOICES)[number]
export const DEFAULT_IDLE_MINUTES: IdleMinutes = 15

export const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const
export const IDLE_CHECK_MS = 15_000

export function isIdleMinutes(value: number): value is IdleMinutes {
  return (IDLE_CHOICES as readonly number[]).includes(value)
}

export function readIdleMinutes(): IdleMinutes {
  try {
    const value = Number(localStorage.getItem(IDLE_KEY))
    return isIdleMinutes(value) ? value : DEFAULT_IDLE_MINUTES
  } catch {
    return DEFAULT_IDLE_MINUTES
  }
}

export function storeIdleMinutes(value: IdleMinutes): void {
  try {
    localStorage.setItem(IDLE_KEY, String(value))
  } catch {
    // The choice still applies to this tab.
  }
}

type VisibilitySource = EventTarget & { readonly visibilityState: DocumentVisibilityState }

export type IdleWatchOptions = {
  /** `null` never fires. */
  idleMs: number | null
  onIdle: () => void
  activity?: EventTarget
  visibility?: VisibilitySource
  checkMs?: number
}

/**
 * Calls `onIdle` once after `idleMs` without activity. Returns a function that stops watching.
 * Listens in the capture phase so a handler that stops propagation still counts as activity.
 */
export function watchIdle({ idleMs, onIdle, activity = window, visibility = document, checkMs = IDLE_CHECK_MS }: IdleWatchOptions): () => void {
  if (idleMs === null || !Number.isFinite(idleMs) || idleMs <= 0) return () => undefined
  let lastActivity = Date.now()
  let fired = false
  const touch = () => {
    lastActivity = Date.now()
  }
  const check = () => {
    if (fired || Date.now() - lastActivity < idleMs) return
    fired = true
    onIdle()
  }
  // Background tabs throttle timers, so also check the moment the tab comes back.
  const onVisibility = () => {
    if (visibility.visibilityState === 'visible') check()
  }
  const options = { capture: true, passive: true }
  for (const name of ACTIVITY_EVENTS) activity.addEventListener(name, touch, options)
  visibility.addEventListener('visibilitychange', onVisibility)
  const interval = setInterval(check, checkMs)
  return () => {
    for (const name of ACTIVITY_EVENTS) activity.removeEventListener(name, touch, options)
    visibility.removeEventListener('visibilitychange', onVisibility)
    clearInterval(interval)
  }
}
