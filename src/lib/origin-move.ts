/** The GitHub Pages address the app served from until 1.3.0. Its vaults stay behind when the domain moves. */
export const OLD_HOSTNAME = 'kool277.github.io'
export const NEW_HOSTNAME = 'jaybi.uz'

export type HostnameSource = () => string

declare global {
  interface Window {
    /** Browser tests set this to simulate another address. Read only under WebDriver automation. */
    __jaybiHostname?: unknown
  }
}

const fromLocation: HostnameSource = () => {
  if (typeof window === 'undefined') return ''
  const simulated = window.__jaybiHostname
  if (typeof navigator !== 'undefined' && navigator.webdriver && typeof simulated === 'string') return simulated
  return window.location.hostname
}

let source: HostnameSource = fromLocation

/** Replaces where the hostname comes from; call without an argument to go back to `location`. */
export function setHostnameSource(next?: HostnameSource): void {
  source = next ?? fromLocation
}

function normalize(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, '')
}

export function currentHostname(): string {
  return normalize(source())
}

export function isOldAddress(hostname = currentHostname()): boolean {
  return normalize(hostname) === OLD_HOSTNAME
}

export function isNewAddress(hostname = currentHostname()): boolean {
  const host = normalize(hostname)
  return host === NEW_HOSTNAME || host === `www.${NEW_HOSTNAME}`
}

export type MoveNoticeKind = 'setup' | 'signIn' | 'backup' | 'askAdmin'

/** Which moving notice the old address shows for a vault status, or null when none applies. */
export function moveNoticeKind(hostname: string, status: string, canExport: boolean): MoveNoticeKind | null {
  if (!isOldAddress(hostname)) return null
  if (status === 'setup') return 'setup'
  if (status === 'locked' || status === 'challenge') return 'signIn'
  if (status === 'ready') return canExport ? 'backup' : 'askAdmin'
  return null
}
