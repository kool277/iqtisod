import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import type { Column } from './columns'
import {
  applyView,
  buildSearchIndex,
  isFilterActive,
  makeCollator,
  nextSort,
  pageWindow,
  type FilterState,
  type FilterValue,
  type SortRule,
} from './model'
import { MAX_SORT_RULES, clearPrefs, readPrefs, writePrefs, type PageSize, type PrefsShape, type TablePrefs } from './prefs'

export const SEARCH_DEBOUNCE_MS = 200

export type TableOptions<T> = {
  id: string
  rows: readonly T[]
  columns: readonly Column<T>[]
  locale: string
  persist: boolean
  defaultSort?: SortRule[]
  defaultPageSize?: PageSize
  /** Filters in place on the first render, such as a group from a ledger link. Never stored. */
  initialFilters?: FilterState
  rowKey: (row: T) => string
}

function useDebounced<V>(value: V, delay: number): V {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, delay])
  return settled
}

export function useTableState<T>({ id, rows, columns, locale, persist, defaultSort = [], defaultPageSize = 25, initialFilters, rowKey }: TableOptions<T>) {
  const shape = useMemo<PrefsShape>(
    () => ({
      columnIds: columns.map((column) => column.id),
      hideable: columns.filter((column) => column.hideable !== false).map((column) => column.id),
      sortable: columns.filter((column) => column.sort).map((column) => column.id),
    }),
    [columns],
  )
  const defaults = useMemo<TablePrefs>(
    () => ({
      hidden: columns.filter((column) => column.hidden && column.hideable !== false).map((column) => column.id),
      order: shape.columnIds.slice(),
      pageSize: defaultPageSize,
      sort: defaultSort.filter((rule) => shape.sortable.includes(rule.id)),
      dense: false,
    }),
    // Defaults are fixed for the lifetime of the table; later column changes only add or drop ids.
    [shape],
  )
  const [prefs, setPrefs] = useState<TablePrefs>(() => (persist ? readPrefs(id, shape, defaults) : defaults))
  const [dirtyPrefs, setDirtyPrefs] = useState(false)
  useEffect(() => {
    if (persist && dirtyPrefs) writePrefs(id, prefs)
  }, [id, persist, prefs, dirtyPrefs])

  const updatePrefs = useCallback((change: (current: TablePrefs) => TablePrefs) => {
    setPrefs(change)
    setDirtyPrefs(true)
  }, [])

  const [query, setQuery] = useState('')
  const search = useDebounced(query, SEARCH_DEBOUNCE_MS)
  const [filters, setFilters] = useState<FilterState>(() => initialFilters ?? {})
  const deferredFilters = useDeferredValue(filters)
  const [page, setPage] = useState(0)

  const byId = useMemo(() => new Map(columns.map((column) => [column.id, column])), [columns])
  const hidden = useMemo(() => new Set(prefs.hidden.filter((column) => shape.hideable.includes(column))), [prefs.hidden, shape])
  const ordered = useMemo(
    () =>
      prefs.order
        .filter((column) => byId.has(column))
        .concat(shape.columnIds.filter((column) => !prefs.order.includes(column)))
        .map((column) => byId.get(column)!),
    [prefs.order, byId, shape],
  )
  const visible = useMemo(() => ordered.filter((column) => !hidden.has(column.id)), [ordered, hidden])
  const collator = useMemo(() => makeCollator(locale), [locale])
  const index = useMemo(() => buildSearchIndex(rows, visible), [rows, visible])
  const sort = useMemo(() => prefs.sort.filter((rule) => byId.get(rule.id)?.sort), [prefs.sort, byId])
  const view = useMemo(
    () => applyView(rows, columns, { search, filters: deferredFilters, sort }, collator, index),
    [rows, columns, search, deferredFilters, sort, collator, index],
  )
  const activeFilters = useMemo(
    () => Object.entries(filters).filter(([column, value]) => byId.get(column)?.filter && isFilterActive(value)).length,
    [filters, byId],
  )
  const filtered = search.trim() !== '' || activeFilters > 0
  const window_ = pageWindow(view.length, prefs.pageSize, page)
  const pageRows = useMemo(() => view.slice(window_.start, window_.end), [view, window_.start, window_.end])

  useEffect(() => {
    setPage(0)
  }, [search, deferredFilters, sort, prefs.pageSize])

  const toggleSort = useCallback(
    (column: string, multi: boolean) => updatePrefs((current) => ({ ...current, sort: nextSort(current.sort, column, multi, MAX_SORT_RULES) })),
    [updatePrefs],
  )
  const setSort = useCallback((rules: SortRule[]) => updatePrefs((current) => ({ ...current, sort: rules })), [updatePrefs])
  const setFilter = useCallback((column: string, value: FilterValue | null) => {
    setFilters((current) => {
      const next = { ...current }
      if (value) next[column] = value
      else delete next[column]
      return next
    })
  }, [])
  const clearFilters = useCallback(() => setFilters({}), [])
  const toggleColumn = useCallback(
    (column: string) =>
      updatePrefs((current) => ({
        ...current,
        hidden: current.hidden.includes(column) ? current.hidden.filter((item) => item !== column) : [...current.hidden, column],
      })),
    [updatePrefs],
  )
  const moveColumn = useCallback(
    (column: string, delta: -1 | 1) =>
      updatePrefs((current) => {
        const order = ordered.map((item) => item.id)
        const from = order.indexOf(column)
        const to = from + delta
        if (from < 0 || to < 0 || to >= order.length) return current
        ;[order[from], order[to]] = [order[to], order[from]]
        return { ...current, order }
      }),
    [ordered, updatePrefs],
  )
  const setPageSize = useCallback((pageSize: PageSize) => updatePrefs((current) => ({ ...current, pageSize })), [updatePrefs])
  const setDense = useCallback((dense: boolean) => updatePrefs((current) => ({ ...current, dense })), [updatePrefs])
  const resetLayout = useCallback(() => {
    if (persist) clearPrefs(id)
    setPrefs(defaults)
    setDirtyPrefs(false)
  }, [defaults, id, persist])

  const keys = useMemo(() => new Set(view.map(rowKey)), [view, rowKey])

  return {
    prefs,
    query,
    setQuery,
    search,
    filters,
    setFilter,
    clearFilters,
    activeFilters,
    filtered,
    ordered,
    visible,
    hidden,
    sort,
    toggleSort,
    setSort,
    toggleColumn,
    moveColumn,
    setPageSize,
    setDense,
    resetLayout,
    view,
    keys,
    pageRows,
    window: window_,
    setPage,
    total: rows.length,
  }
}

export type TableState<T> = ReturnType<typeof useTableState<T>>
