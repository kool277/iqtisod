import { parseJsonSafely } from '../../lib/safe-json'
import type { SortRule } from './model'

export const PREFS_VERSION = 1
export const PAGE_SIZES = [10, 25, 50, 100, 0] as const
export type PageSize = (typeof PAGE_SIZES)[number]
export const MAX_SORT_RULES = 3

const TABLE_ID = /^[a-z][a-z0-9-]{0,40}$/
const PREFS_MAX_CHARS = 4096

/**
 * Only layout is stored: which columns are hidden, their order, the page size, the sort, and the row density.
 * Search text and filter values are never written, so nothing typed into a table (or derived from a private safe) reaches localStorage.
 */
export type TablePrefs = { hidden: string[]; order: string[]; pageSize: PageSize; sort: SortRule[]; dense: boolean }

export type PrefsShape = { columnIds: readonly string[]; hideable: readonly string[]; sortable: readonly string[] }

export function prefsKey(tableId: string): string {
  if (!TABLE_ID.test(tableId)) throw new Error(`Invalid table id: ${tableId}`)
  return `moliya.table.${tableId}`
}

export function isPageSize(value: unknown): value is PageSize {
  return typeof value === 'number' && (PAGE_SIZES as readonly number[]).includes(value)
}

function uniqueKnown(value: unknown, known: readonly string[]): string[] | null {
  if (!Array.isArray(value)) return null
  const allowed = new Set(known)
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item === 'string' && allowed.has(item)) seen.add(item)
  }
  return [...seen]
}

/** A stored order may miss columns added in a later release; they keep their default position at the end. */
export function completeOrder(order: readonly string[], columnIds: readonly string[]): string[] {
  const kept = order.filter((id) => columnIds.includes(id))
  return [...kept, ...columnIds.filter((id) => !kept.includes(id))]
}

export function parsePrefs(raw: string | null, shape: PrefsShape, defaults: TablePrefs): TablePrefs {
  if (!raw) return defaults
  let parsed: unknown
  try {
    parsed = parseJsonSafely(raw, { maxChars: PREFS_MAX_CHARS, maxDepth: 4 })
  } catch {
    return defaults
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return defaults
  const record = parsed as Record<string, unknown>
  if (record.v !== PREFS_VERSION) return defaults
  const hidden = uniqueKnown(record.hidden, shape.hideable) ?? defaults.hidden
  const order = completeOrder(uniqueKnown(record.order, shape.columnIds) ?? defaults.order, shape.columnIds)
  const pageSize = isPageSize(record.pageSize) ? record.pageSize : defaults.pageSize
  const dense = typeof record.dense === 'boolean' ? record.dense : defaults.dense
  let sort = defaults.sort
  if (Array.isArray(record.sort)) {
    const seen = new Set<string>()
    sort = []
    for (const rule of record.sort) {
      if (typeof rule !== 'object' || rule === null) continue
      const { id, desc } = rule as Record<string, unknown>
      if (typeof id !== 'string' || typeof desc !== 'boolean' || !shape.sortable.includes(id) || seen.has(id)) continue
      seen.add(id)
      sort.push({ id, desc })
      if (sort.length === MAX_SORT_RULES) break
    }
  }
  return { hidden, order, pageSize, sort, dense }
}

export function serializePrefs(prefs: TablePrefs): string {
  return JSON.stringify({ v: PREFS_VERSION, hidden: prefs.hidden, order: prefs.order, pageSize: prefs.pageSize, sort: prefs.sort, dense: prefs.dense })
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function readPrefs(tableId: string, shape: PrefsShape, defaults: TablePrefs): TablePrefs {
  try {
    return parsePrefs(storage()?.getItem(prefsKey(tableId)) ?? null, shape, defaults)
  } catch {
    return defaults
  }
}

export function writePrefs(tableId: string, prefs: TablePrefs): void {
  try {
    storage()?.setItem(prefsKey(tableId), serializePrefs(prefs))
  } catch {
    // The layout still applies to this tab.
  }
}

export function clearPrefs(tableId: string): void {
  try {
    storage()?.removeItem(prefsKey(tableId))
  } catch {
    // Nothing stored.
  }
}
