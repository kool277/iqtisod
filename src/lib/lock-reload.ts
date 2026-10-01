import { loginPathFor } from './return-to'

/** Carries the idle-lock notice across the reload that ends every unlocked session. Session storage, this tab only. */
export const LOCK_NOTICE_KEY = 'moliya.lockNotice'

export type LockNotice = 'idle'

type Where = { pathname: string; search: string; hash: string }

function sessionStore(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

/**
 * The document URL a lock reloads into: sign-in, keeping a way back to the page an idle lock left.
 * **Lock** ends the visit, so it always lands on plain sign-in.
 */
export function lockUrl(where: Where, reason: 'manual' | 'idle'): string {
  const route = where.hash.replace(/^#/, '') || '/'
  const mark = route.indexOf('?')
  const pathname = mark === -1 ? route : route.slice(0, mark)
  const search = mark === -1 ? '' : route.slice(mark)
  const target = reason === 'idle' && pathname.startsWith('/app') ? loginPathFor(pathname, search) : '/login'
  return `${where.pathname}${where.search}#${target}`
}

export function rememberLockNotice(reason: 'manual' | 'idle', storage = sessionStore()): void {
  try {
    if (reason === 'idle') storage?.setItem(LOCK_NOTICE_KEY, 'idle')
    else storage?.removeItem(LOCK_NOTICE_KEY)
  } catch {
    // Without session storage the notice is simply not shown after the reload.
  }
}

export function peekLockNotice(storage = sessionStore()): LockNotice | null {
  try {
    return storage?.getItem(LOCK_NOTICE_KEY) === 'idle' ? 'idle' : null
  } catch {
    return null
  }
}

export function clearLockNotice(storage = sessionStore()): void {
  try {
    storage?.removeItem(LOCK_NOTICE_KEY)
  } catch {
    // Nothing to clear.
  }
}
