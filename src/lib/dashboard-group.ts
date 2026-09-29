export const DASHBOARD_GROUP_KEY = 'moliya.dashboard.group'

/** `null` means every group the reader may see. */
export type GroupChoice = number | null

/**
 * Accepts a stored choice only when it names a group the current reader is allowed to see.
 * Another person may have used this browser, so anything else falls back to all groups.
 */
export function parseGroupChoice(raw: string | null, permitted: readonly { id: number }[]): GroupChoice {
  if (raw == null || !/^[1-9]\d{0,9}$/.test(raw)) return null
  const id = Number(raw)
  return permitted.some((group) => group.id === id) ? id : null
}

export function readGroupChoice(permitted: readonly { id: number }[]): GroupChoice {
  try {
    return parseGroupChoice(localStorage.getItem(DASHBOARD_GROUP_KEY), permitted)
  } catch {
    return null
  }
}

export function writeGroupChoice(choice: GroupChoice): void {
  try {
    if (choice == null) localStorage.removeItem(DASHBOARD_GROUP_KEY)
    else localStorage.setItem(DASHBOARD_GROUP_KEY, String(choice))
  } catch {
    // The choice still applies until the page reloads.
  }
}
