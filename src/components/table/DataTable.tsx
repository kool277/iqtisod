import { ArrowDown, ArrowUp, ArrowUpDown, ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Filter, Search, Trash2 } from 'lucide-react'
import { Fragment, useCallback, useMemo, useState, type ReactNode } from 'react'
import { useI18n } from '../../context/I18nContext'
import { useVault } from '../../context/VaultContext'
import { textForError } from '../../lib/errors'
import { intlLocale } from '../../lib/money'
import { canExportView, type ViewTable } from '../../services/export/view-tables'
import type { Column } from './columns'
import { ColumnMenu } from './ColumnMenu'
import { EditableCell } from './EditableCell'
import { ExportMenu, type ViewSnapshot } from './ExportMenu'
import { FilterPanel } from './FilterPanel'
import { fill, optionsFrom, type FilterOption, type SortRule } from './model'
import { toolButton } from './Popover'
import { PAGE_SIZES, isPageSize, type PageSize } from './prefs'
import { useTableState } from './useTableState'

export type { Column, EditSpec } from './columns'

type DataAttributes = Record<`data-${string}`, string | undefined>

export type Selection = { picked: ReadonlySet<string>; toggle: (key: string) => void; set: (keys: string[], on: boolean) => void }

export type DataTableProps<T> = {
  /** Also the layout key: `moliya.table.<id>`. */
  id: string
  label: string
  rows: readonly T[]
  columns: readonly Column<T>[]
  rowKey: (row: T) => string
  rowActions?: (row: T) => ReactNode
  /** Extra content under a row, such as a confirmation or an edit form. */
  expanded?: (row: T) => ReactNode
  rowAttributes?: (row: T) => DataAttributes
  /** Wraps each row and its expanded content in its own `<tbody>` carrying these attributes. */
  groupAttributes?: (row: T) => DataAttributes
  selectedKey?: string | null
  /** Controls shown above the search box, such as a period picker. */
  toolbar?: ReactNode
  exportTable?: ViewTable
  exportScope?: ViewSnapshot['scope']
  persist?: boolean
  /** Private-safe data: no export and no autocomplete or spellcheck on inputs. */
  secure?: boolean
  empty?: ReactNode
  defaultSort?: SortRule[]
  defaultPageSize?: PageSize
  bulkDelete?: { run: (rows: T[]) => Promise<void>; can?: (row: T) => boolean }
  selection?: Selection
}

const secureProps = { autoComplete: 'off', spellCheck: false, autoCorrect: 'off', autoCapitalize: 'off' } as const

const narrow = {
  table: '@max-3xl:block',
  body: '@max-3xl:grid @max-3xl:gap-2',
  group: '@max-3xl:mb-2 @max-3xl:grid @max-3xl:gap-2',
  row: '@max-3xl:grid @max-3xl:grid-cols-2 @max-3xl:gap-x-4 @max-3xl:gap-y-2 @max-3xl:rounded-2xl @max-3xl:border @max-3xl:border-line @max-3xl:bg-card @max-3xl:p-3',
  cell: '@max-3xl:block @max-3xl:min-w-0 @max-3xl:border-0 @max-3xl:p-0 @max-3xl:before:mb-0.5 @max-3xl:before:block @max-3xl:before:text-[11px] @max-3xl:before:uppercase @max-3xl:before:tracking-[0.12em] @max-3xl:before:text-muted @max-3xl:before:content-[attr(data-label)]',
  wide: '@max-3xl:col-span-2',
}

export function DataTable<T>(props: DataTableProps<T>) {
  const { id, label, rows, columns, rowKey, rowActions, expanded, rowAttributes, groupAttributes, selectedKey, toolbar, exportTable, exportScope, secure = false, empty, bulkDelete } = props
  const { t, locale } = useI18n()
  const { user } = useVault()
  const state = useTableState({
    id,
    rows,
    columns,
    locale: intlLocale(locale),
    persist: props.persist ?? true,
    defaultSort: props.defaultSort,
    defaultPageSize: props.defaultPageSize,
    rowKey,
  })
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [ownPicked, setOwnPicked] = useState<ReadonlySet<string>>(new Set())
  const [confirmBulk, setConfirmBulk] = useState(false)
  const [bulkError, setBulkError] = useState<string | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)

  const own = useMemo<Selection>(
    () => ({
      picked: ownPicked,
      toggle: (key) =>
        setOwnPicked((current) => {
          const next = new Set(current)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        }),
      set: (keys, on) =>
        setOwnPicked((current) => {
          const next = new Set(current)
          for (const key of keys) {
            if (on) next.add(key)
            else next.delete(key)
          }
          return next
        }),
    }),
    [ownPicked],
  )
  const selection = props.selection ?? (bulkDelete ? own : null)
  const selectable = useCallback((row: T) => !bulkDelete?.can || bulkDelete.can(row), [bulkDelete])
  const picked = useMemo(() => (selection ? state.view.filter((row) => selection.picked.has(rowKey(row))) : []), [selection, state.view, rowKey])

  const collator = useMemo(() => new Intl.Collator(intlLocale(locale), { sensitivity: 'base', numeric: true }), [locale])
  const options = useMemo(() => {
    const result: Record<string, FilterOption[]> = {}
    for (const column of columns) {
      if (column.filter?.kind === 'select' && column.filter.options.length === 0) {
        const spec = column.filter
        result[column.id] = optionsFrom(rows, spec.value, (value) => value, collator)
      }
    }
    return result
  }, [columns, rows, collator])

  const canExport = Boolean(!secure && exportTable && user && canExportView(user, exportTable))
  const snapshot = useCallback((): ViewSnapshot => {
    const exported = state.visible.filter((column) => column.exportAs)
    return {
      columns: exported.map((column) => ({ id: column.id, header: column.header, kind: column.exportAs!.kind })),
      rows: state.view.map((row) => exported.map((column) => column.exportAs!.value(row))),
      total: state.total,
      filtered: state.filtered,
      scope: exportScope,
    }
  }, [state.visible, state.view, state.total, state.filtered, exportScope])

  const sortable = state.ordered.filter((column) => column.sort)
  const sortValue = state.sort[0] ? `${state.sort[0].id}:${state.sort[0].desc ? 'desc' : 'asc'}` : ''
  const hasActions = Boolean(rowActions)
  const columnCount = state.visible.length + (hasActions ? 1 : 0) + (selection ? 1 : 0)
  const pageKeys = state.pageRows.filter(selectable).map(rowKey)
  const allOnPage = pageKeys.length > 0 && pageKeys.every((key) => selection?.picked.has(key))
  const { start, end, page, pages } = state.window
  const dense = state.prefs.dense
  const pad = dense ? 'px-3 py-1.5' : 'px-4 py-3'

  async function runBulk() {
    if (!bulkDelete) return
    setBulkBusy(true)
    setBulkError(null)
    try {
      await bulkDelete.run(picked.filter(selectable))
      setOwnPicked(new Set())
      setConfirmBulk(false)
    } catch (caught) {
      setBulkError(textForError(caught, t))
    } finally {
      setBulkBusy(false)
    }
  }

  const wrapRows = (content: ReactNode[]) =>
    groupAttributes ? content : content.length > 0 ? <tbody className={narrow.body}>{content}</tbody> : null

  const summary =
    state.view.length === 0
      ? t('table.showingNone')
      : fill(t('table.showing'), { from: start + 1, to: end, total: state.view.length })

  return (
    <section aria-label={label} data-testid={`table-${id}`} className="@container grid min-w-0 gap-3">
      {toolbar ? <div className="flex min-w-0 flex-wrap items-end gap-2">{toolbar}</div> : null}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1 basis-56">
          <span className="sr-only">{t('table.search')}</span>
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
          <input
            {...(secure ? secureProps : { autoComplete: 'off' })}
            type="search"
            data-testid={`${id}-search`}
            placeholder={t('table.searchPlaceholder')}
            className="h-9 w-full rounded-xl border border-line bg-card pl-9 pr-3 text-sm outline-none transition focus:border-pine-ink focus:ring-2 focus:ring-pine-ink/30"
            value={state.query}
            onChange={(event) => state.setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && state.query) {
                event.preventDefault()
                state.setQuery('')
              }
            }}
          />
        </label>
        {columns.some((column) => column.filter) ? (
          <button
            type="button"
            className={toolButton}
            aria-expanded={filtersOpen}
            aria-controls={`${id}-filters`}
            data-testid={`${id}-filters-toggle`}
            onClick={() => setFiltersOpen((value) => !value)}
          >
            <Filter size={15} aria-hidden="true" />
            <span className="hidden sm:inline">{t('table.filters')}</span>
            {state.activeFilters > 0 ? <span className="rounded-full bg-pine px-1.5 text-xs tabular-nums text-on-pine">{state.activeFilters}</span> : null}
          </button>
        ) : null}
        <ColumnMenu
          tableId={id}
          ordered={state.ordered}
          hidden={state.hidden}
          dense={dense}
          onToggle={state.toggleColumn}
          onMove={state.moveColumn}
          onDense={state.setDense}
          onReset={state.resetLayout}
        />
        {canExport && exportTable ? <ExportMenu tableId={id} table={exportTable} title={label} snapshot={snapshot} /> : null}
      </div>
      {sortable.length > 0 ? (
        <label className="flex items-center gap-2 text-sm @3xl:hidden">
          <span className="shrink-0 text-muted">{t('table.sortBy')}</span>
          <select
            data-testid={`${id}-sort-select`}
            className="h-9 min-w-0 flex-1 rounded-xl border border-line bg-card px-2.5 text-sm"
            value={sortValue}
            onChange={(event) => {
              const [column, direction] = event.target.value.split(':')
              state.setSort(column ? [{ id: column, desc: direction === 'desc' }] : [])
            }}
          >
            <option value="">{t('table.sortDefault')}</option>
            {sortable.map((column) => (
              <Fragment key={column.id}>
                <option value={`${column.id}:asc`}>
                  {column.header} ↑
                </option>
                <option value={`${column.id}:desc`}>
                  {column.header} ↓
                </option>
              </Fragment>
            ))}
          </select>
        </label>
      ) : null}
      {filtersOpen ? (
        <div id={`${id}-filters`}>
          <FilterPanel
            tableId={id}
            columns={state.ordered}
            filters={state.filters}
            options={options}
            onChange={state.setFilter}
            onClear={state.clearFilters}
            active={state.activeFilters}
            secure={secure}
          />
        </div>
      ) : null}
      {selection && bulkDelete && picked.length > 0 ? (
        <div className="grid gap-2 rounded-2xl border border-line bg-card px-3 py-2" data-testid={`${id}-bulk`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-auto text-sm tabular-nums">{fill(t('table.selected'), { count: picked.length })}</span>
            <button type="button" className="text-sm text-muted hover:text-ink" onClick={() => setOwnPicked(new Set())}>
              {t('table.clearSelection')}
            </button>
            <button
              type="button"
              data-testid={`${id}-bulk-delete`}
              className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-clay px-3 text-sm text-clay-ink hover:bg-clay/10"
              onClick={() => setConfirmBulk(true)}
            >
              <Trash2 size={14} aria-hidden="true" />
              {t('table.deleteSelected')}
            </button>
          </div>
          {confirmBulk ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-2" role="alertdialog" aria-label={t('table.deleteSelected')}>
              <p className="w-full text-sm">{fill(t('table.deleteSelectedConfirm'), { count: picked.length })}</p>
              <button
                type="button"
                data-testid={`${id}-bulk-confirm`}
                disabled={bulkBusy}
                className="inline-flex h-8 items-center rounded-xl border border-clay bg-clay px-3 text-sm text-on-pine hover:opacity-90 disabled:opacity-60"
                onClick={() => void runBulk()}
              >
                {t('common.delete')}
              </button>
              <button type="button" className="inline-flex h-8 items-center rounded-xl border border-line px-3 text-sm" onClick={() => setConfirmBulk(false)}>
                {t('common.cancel')}
              </button>
            </div>
          ) : null}
          {bulkError ? (
            <p role="alert" className="text-sm text-clay-ink">
              {bulkError}
            </p>
          ) : null}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-3xl border border-line bg-card px-4 py-6 text-center text-sm text-muted">{empty ?? t('table.noRows')}</div>
      ) : (
        <div className="min-w-0 rounded-3xl border border-line bg-card @max-3xl:border-0 @max-3xl:bg-transparent @3xl:max-h-[min(75vh,56rem)] @3xl:overflow-auto">
          <table className={`w-full border-separate border-spacing-0 text-left text-sm ${narrow.table}`} aria-label={label}>
            <thead className="@max-3xl:hidden">
              <tr>
                {selection ? (
                  <th scope="col" className="sticky top-0 z-10 w-10 bg-card px-3 py-2.5 shadow-[inset_0_-1px_0_var(--app-line)]">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--app-pine)]"
                      aria-label={t('table.selectAll')}
                      checked={allOnPage}
                      disabled={pageKeys.length === 0}
                      data-testid={`${id}-select-page`}
                      onChange={() => selection.set(pageKeys, !allOnPage)}
                    />
                  </th>
                ) : null}
                {state.visible.map((column) => {
                  const position = state.sort.findIndex((rule) => rule.id === column.id)
                  const rule = position >= 0 ? state.sort[position] : null
                  const Icon = rule ? (rule.desc ? ArrowDown : ArrowUp) : ArrowUpDown
                  return (
                    <th
                      key={column.id}
                      scope="col"
                      aria-sort={rule ? (rule.desc ? 'descending' : 'ascending') : column.sort ? 'none' : undefined}
                      data-column={column.id}
                      className={`sticky top-0 z-10 whitespace-nowrap bg-card font-medium text-muted shadow-[inset_0_-1px_0_var(--app-line)] ${dense ? 'px-3 py-2' : 'px-4 py-2.5'} ${column.align === 'end' ? 'text-right' : ''}`}
                    >
                      {column.sort ? (
                        <button
                          type="button"
                          data-testid={`sort-${id}-${column.id}`}
                          title={t('table.sortHint')}
                          className={`group inline-flex items-center gap-1 rounded-md hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pine-ink/40 ${rule ? 'text-ink' : ''} ${column.align === 'end' ? 'flex-row-reverse' : ''}`}
                          onClick={(event) => state.toggleSort(column.id, event.shiftKey)}
                        >
                          {column.header}
                          <Icon size={13} aria-hidden="true" className={rule ? 'text-pine-ink' : 'opacity-40 group-hover:opacity-80'} />
                          {rule && state.sort.length > 1 ? <span className="text-[10px] tabular-nums text-pine-ink">{position + 1}</span> : null}
                        </button>
                      ) : (
                        column.header
                      )}
                    </th>
                  )
                })}
                {hasActions ? (
                  <th scope="col" className={`sticky top-0 z-10 bg-card text-right font-medium text-muted shadow-[inset_0_-1px_0_var(--app-line)] ${dense ? 'px-3 py-2' : 'px-4 py-2.5'}`}>
                    <span className="sr-only">{t('common.actions')}</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            {state.view.length === 0 ? (
              <tbody className={narrow.body}>
                <tr className="@max-3xl:block">
                  <td colSpan={columnCount} className="px-4 py-6 text-center text-muted @max-3xl:block">
                    {t('table.noMatches')}{' '}
                    <button
                      type="button"
                      className="text-pine-ink hover:underline"
                      onClick={() => {
                        state.setQuery('')
                        state.clearFilters()
                      }}
                    >
                      {t('table.clearFilters')}
                    </button>
                  </td>
                </tr>
              </tbody>
            ) : null}
            {wrapRows(
              state.pageRows.map((row) => {
                const key = rowKey(row)
                const extra = expanded?.(row)
                const isSelected = selectedKey === key
                const checked = selection?.picked.has(key) ?? false
                const Group = groupAttributes ? 'tbody' : Fragment
                const groupProps = groupAttributes ? { ...groupAttributes(row), className: narrow.group } : {}
                return (
                  <Group key={key} {...groupProps}>
                    <tr
                      {...rowAttributes?.(row)}
                      aria-current={isSelected ? true : undefined}
                      data-selected={checked || undefined}
                      className={`group/row ${narrow.row} ${extra ? '@max-3xl:rounded-b-none @max-3xl:border-b-0' : ''} align-middle transition-colors ${isSelected || checked ? 'bg-pine/5 @max-3xl:border-pine-ink' : 'hover:bg-paper/70'}`}
                    >
                      {selection ? (
                        <td className={`${pad} border-t border-line ${narrow.cell} @max-3xl:before:hidden`}>
                          <input
                            type="checkbox"
                            className="size-4 accent-[var(--app-pine)]"
                            aria-label={t('table.selectRow')}
                            checked={checked}
                            disabled={!selectable(row)}
                            data-testid={`${id}-select`}
                            onChange={() => selection.toggle(key)}
                          />
                        </td>
                      ) : null}
                      {state.visible.map((column, position) => {
                        const cellKey = `${key}:${column.id}`
                        const content = column.cell(row)
                        const editable = column.edit && (!column.edit.enabled || column.edit.enabled(row))
                        return (
                          <td
                            key={column.id}
                            data-label={position === 0 ? undefined : column.header}
                            data-column={column.id}
                            className={`${pad} border-t border-line ${narrow.cell} ${position === 0 ? `${narrow.wide} @max-3xl:text-base @max-3xl:font-medium` : ''} ${column.align === 'end' ? 'text-right tabular-nums @max-3xl:text-left' : ''} ${column.className ?? ''}`}
                          >
                            {editable ? (
                              <EditableCell
                                row={row}
                                spec={column.edit!}
                                header={column.header}
                                testId={`${column.id}-${key}`}
                                editing={editing === cellKey}
                                onStart={() => setEditing(cellKey)}
                                onStop={() => setEditing((current) => (current === cellKey ? null : current))}
                              >
                                {content}
                              </EditableCell>
                            ) : (
                              content
                            )}
                          </td>
                        )
                      })}
                      {hasActions ? (
                        <td className={`${pad} border-t border-line text-right ${narrow.cell} ${narrow.wide} @max-3xl:before:hidden`}>
                          <div className="flex flex-wrap justify-end gap-1.5 [&_button]:rounded-lg [&_button]:px-3 [&_button]:py-1.5 [&_button]:text-xs">{rowActions!(row)}</div>
                        </td>
                      ) : null}
                    </tr>
                    {extra ? (
                      <tr className="@max-3xl:-mt-2 @max-3xl:block">
                        <td colSpan={columnCount} className="px-4 pb-4 @max-3xl:block @max-3xl:rounded-b-2xl @max-3xl:border @max-3xl:border-t-0 @max-3xl:border-line @max-3xl:bg-card @max-3xl:px-3">
                          {extra}
                        </td>
                      </tr>
                    ) : null}
                  </Group>
                )
              }),
            )}
          </table>
        </div>
      )}

      {rows.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <p role="status" aria-live="polite" data-testid={`${id}-summary`} className="text-muted tabular-nums">
            {summary}
            {state.filtered ? ` ${fill(t('table.filteredFrom'), { total: state.total })}` : ''}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2">
              <span className="text-muted">{t('table.rowsPerPage')}</span>
              <select
                data-testid={`${id}-page-size`}
                className="h-8 rounded-lg border border-line bg-card px-2 text-sm"
                value={state.prefs.pageSize}
                onChange={(event) => {
                  const size = Number(event.target.value)
                  if (isPageSize(size)) state.setPageSize(size)
                }}
              >
                {PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size === 0 ? t('table.allRows') : size}
                  </option>
                ))}
              </select>
            </label>
            {pages > 1 ? (
              <nav aria-label={t('table.pagination')} className="flex items-center gap-1">
                <PagerButton label={t('table.first')} disabled={page === 0} onClick={() => state.setPage(0)} icon={<ChevronFirst size={15} />} />
                <PagerButton label={t('table.previous')} disabled={page === 0} onClick={() => state.setPage(page - 1)} icon={<ChevronLeft size={15} />} testId={`${id}-prev`} />
                <span className="px-1.5 tabular-nums text-muted" data-testid={`${id}-page`}>
                  {fill(t('table.page'), { page: page + 1, pages })}
                </span>
                <PagerButton label={t('table.next')} disabled={page >= pages - 1} onClick={() => state.setPage(page + 1)} icon={<ChevronRight size={15} />} testId={`${id}-next`} />
                <PagerButton label={t('table.last')} disabled={page >= pages - 1} onClick={() => state.setPage(pages - 1)} icon={<ChevronLast size={15} />} />
              </nav>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  )
}

function PagerButton({ label, disabled, onClick, icon, testId }: { label: string; disabled: boolean; onClick: () => void; icon: ReactNode; testId?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className="grid size-8 place-items-center rounded-lg border border-line bg-card text-muted hover:border-brass hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line"
    >
      <span aria-hidden="true">{icon}</span>
    </button>
  )
}
