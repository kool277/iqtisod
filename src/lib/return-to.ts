/** `#/login?next=/app/transactions`: the page to reopen once the vault is unlocked. */
export const RETURN_PARAM = 'next'

const MAX_LENGTH = 512
const APP_PATH = /^\/app(?:\/[A-Za-z0-9._~-]+)*\/?$/
const QUERY = /^(?:[A-Za-z0-9._~+=&-]|%[0-9A-Fa-f]{2})*$/

/**
 * The in-app path a sign-in should return to, or null. Only `/app` pages qualify, so a crafted link can
 * neither leave the app nor send someone to the setup or join screens after they sign in.
 */
export function returnPath(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length > MAX_LENGTH) return null
  const mark = value.indexOf('?')
  const path = mark === -1 ? value : value.slice(0, mark)
  const query = mark === -1 ? '' : value.slice(mark + 1)
  if (!APP_PATH.test(path) || path.split('/').some((part) => part === '.' || part === '..')) return null
  if (!QUERY.test(query)) return null
  return query ? `${path}?${query}` : path
}

/** The sign-in route for someone who asked for `pathname` + `search` while the vault was locked. */
export function loginPathFor(pathname: string, search: string): string {
  const back = returnPath(`${pathname}${search}`)
  if (!back || back === '/app') return '/login'
  return `/login?${RETURN_PARAM}=${encodeURIComponent(back)}`
}
