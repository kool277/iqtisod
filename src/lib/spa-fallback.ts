/**
 * GitHub Pages answers any address without a file of its own with 404.html. The app routes inside the
 * fragment (`/#/app/transactions`), so that page turns a path-style address into the same route on `/`.
 * The result always starts with `/#/`: it can only point back at this origin, whatever the address holds.
 */

/** The repository path the site lived under on github.io until 1.3.0; links copied from then still carry it. */
const LEGACY_BASE = '/iqtisod'
const MAX_PATH = 512
const MAX_QUERY = 512
const SEGMENT = /^[A-Za-z0-9._~-]+$/
const QUERY = /^(?:[A-Za-z0-9._~+=&-]|%[0-9A-Fa-f]{2})*$/
const FILE = /\.[A-Za-z0-9]{1,16}$/
const STATIC_DIRS = ['assets', 'rates']

export const FALLBACK_HOME = '/#/'

export type AddressParts = { pathname: string; search: string; hash: string }

function stripLegacyBase(pathname: string): string {
  if (pathname === LEGACY_BASE) return '/'
  return pathname.startsWith(`${LEGACY_BASE}/`) ? pathname.slice(LEGACY_BASE.length) : pathname
}

/** Splits a fragment like `#/app/transactions?group=3` into path and query, or null when it is not a route. */
function hashRoute(hash: string): { path: string; query: string } | null {
  if (!hash.startsWith('#/')) return null
  const route = hash.slice(1)
  const mark = route.indexOf('?')
  return mark === -1 ? { path: route, query: '' } : { path: route.slice(0, mark), query: route.slice(mark + 1) }
}

/** Decoded, validated path segments, or null when anything about the path is off. */
function segmentsOf(path: string): string[] | null {
  if (path.length > MAX_PATH || !path.startsWith('/')) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return null
  }
  const parts = decoded.slice(1).split('/')
  if (parts.at(-1) === '') parts.pop()
  for (const part of parts) {
    if (!SEGMENT.test(part) || part === '.' || part === '..') return null
  }
  return parts
}

function cleanQuery(query: string): string {
  return query.length <= MAX_QUERY && QUERY.test(query) && query !== '' ? `?${query}` : ''
}

/**
 * Where the 404 page should send the browser: `/#/<route>[?query]`, FALLBACK_HOME when the address is
 * malformed, or null when it names a missing file (an asset, a rates snapshot) that the app cannot show.
 */
export function fallbackTarget({ pathname, search, hash }: AddressParts): string | null {
  const local = stripLegacyBase(pathname)
  const atRoot = local === '/' || local === '/index.html'
  const route = atRoot ? hashRoute(hash) : null
  const path = route ? route.path : local
  const query = route ? route.query : search.startsWith('?') ? search.slice(1) : ''
  const segments = segmentsOf(path)
  if (!segments) return FALLBACK_HOME
  if (segments.length === 1 && segments[0] === 'index.html') return FALLBACK_HOME
  const last = segments.at(-1)
  if (last && (FILE.test(last) || STATIC_DIRS.includes(segments[0]))) return null
  return `/#/${segments.join('/')}${cleanQuery(query)}`
}
