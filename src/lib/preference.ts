/** Display preferences in localStorage. Blocked or full storage (private modes, strict cookie settings) must never stop the app from starting. */
export function readPreference(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // The choice still applies until the page reloads.
  }
}
