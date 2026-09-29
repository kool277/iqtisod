export const IDLE_KEY = 'moliya.idleMinutes'
export const IDLE_CHOICES = [5, 15, 30, 60] as const
export type IdleMinutes = (typeof IDLE_CHOICES)[number]
export const DEFAULT_IDLE_MINUTES: IdleMinutes = 15

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
