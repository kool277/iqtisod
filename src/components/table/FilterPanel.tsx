import { X } from 'lucide-react'
import { useI18n } from '../../context/I18nContext'
import type { Column } from './columns'
import { fill, isFilterActive, type FilterOption, type FilterValue } from './model'
import { Popover } from './Popover'

const inputClass =
  'h-9 w-full min-w-0 rounded-xl border border-line bg-card px-2.5 text-sm outline-none transition focus:border-pine-ink focus:ring-2 focus:ring-pine-ink/30'

type Props<T> = {
  tableId: string
  columns: readonly Column<T>[]
  filters: Record<string, FilterValue>
  options: Record<string, FilterOption[]>
  onChange: (column: string, value: FilterValue | null) => void
  onClear: () => void
  active: number
  secure?: boolean
}

const secureProps = { autoComplete: 'off', spellCheck: false, autoCorrect: 'off', autoCapitalize: 'off' } as const

export function FilterPanel<T>({ tableId, columns, filters, options, onChange, onClear, active, secure }: Props<T>) {
  const { t } = useI18n()
  const filterable = columns.filter((column) => column.filter)
  if (filterable.length === 0) return null
  return (
    <div role="group" aria-label={t('table.filters')} data-testid={`${tableId}-filters`} className="grid gap-3 rounded-2xl border border-line bg-paper/60 p-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {filterable.map((column) => {
        const spec = column.filter!
        const value = filters[column.id]
        const labelId = `${tableId}-filter-${column.id}`
        return (
          <div key={column.id} className="grid min-w-0 content-start gap-1">
            <span id={labelId} className="flex items-center justify-between gap-2 text-xs font-medium text-muted">
              <span className="truncate">{column.header}</span>
              {isFilterActive(value) ? (
                <button type="button" className="rounded-md p-0.5 hover:text-ink" aria-label={`${t('table.clearFilter')}: ${column.header}`} onClick={() => onChange(column.id, null)}>
                  <X size={12} aria-hidden="true" />
                </button>
              ) : null}
            </span>
            {spec.kind === 'text' ? (
              <input
                {...(secure ? secureProps : {})}
                type="search"
                aria-labelledby={labelId}
                data-testid={labelId}
                className={inputClass}
                placeholder={t('table.contains')}
                value={value?.kind === 'text' ? value.text : ''}
                onChange={(event) => onChange(column.id, event.target.value ? { kind: 'text', text: event.target.value } : null)}
              />
            ) : null}
            {spec.kind === 'select' ? (
              <SelectFilter
                label={column.header}
                testId={labelId}
                options={options[column.id] ?? spec.options}
                secure={secure}
                selected={value?.kind === 'select' ? value.values : []}
                onChange={(values) => onChange(column.id, values.length ? { kind: 'select', values } : null)}
              />
            ) : null}
            {spec.kind === 'date' ? (
              <div className="grid grid-cols-2 gap-1.5">
                <input
                  type="date"
                  aria-label={`${column.header}: ${t('table.from')}`}
                  data-testid={`${labelId}-from`}
                  className={inputClass}
                  value={value?.kind === 'date' ? value.from : ''}
                  onChange={(event) => onChange(column.id, { kind: 'date', from: event.target.value, to: value?.kind === 'date' ? value.to : '' })}
                />
                <input
                  type="date"
                  aria-label={`${column.header}: ${t('table.to')}`}
                  data-testid={`${labelId}-to`}
                  className={inputClass}
                  value={value?.kind === 'date' ? value.to : ''}
                  onChange={(event) => onChange(column.id, { kind: 'date', from: value?.kind === 'date' ? value.from : '', to: event.target.value })}
                />
              </div>
            ) : null}
            {spec.kind === 'number' || spec.kind === 'money' ? (
              <div className="grid grid-cols-2 gap-1.5">
                <input
                  {...secureProps}
                  inputMode="decimal"
                  aria-label={`${column.header}: ${t('table.min')}`}
                  data-testid={`${labelId}-min`}
                  placeholder={t('table.min')}
                  className={`${inputClass} tabular-nums`}
                  value={value?.kind === 'range' ? value.min : ''}
                  onChange={(event) => onChange(column.id, { kind: 'range', min: event.target.value, max: value?.kind === 'range' ? value.max : '' })}
                />
                <input
                  {...secureProps}
                  inputMode="decimal"
                  aria-label={`${column.header}: ${t('table.max')}`}
                  data-testid={`${labelId}-max`}
                  placeholder={t('table.max')}
                  className={`${inputClass} tabular-nums`}
                  value={value?.kind === 'range' ? value.max : ''}
                  onChange={(event) => onChange(column.id, { kind: 'range', min: value?.kind === 'range' ? value.min : '', max: event.target.value })}
                />
              </div>
            ) : null}
          </div>
        )
      })}
      {active > 0 ? (
        <div className="flex items-end sm:col-span-full">
          <button type="button" data-testid={`${tableId}-clear-filters`} className="text-sm text-pine-ink hover:underline" onClick={onClear}>
            {t('table.clearFilters')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

function SelectFilter({
  label,
  testId,
  options,
  selected,
  onChange,
  secure,
}: {
  label: string
  testId: string
  options: FilterOption[]
  secure?: boolean
  selected: string[]
  onChange: (values: string[]) => void
}) {
  const { t } = useI18n()
  const chosen = new Set(selected)
  const summary =
    selected.length === 0
      ? t('table.any')
      : selected.length === 1
        ? (options.find((option) => option.value === selected[0])?.label ?? selected[0])
        : fill(t('table.selectedCount'), { count: selected.length })
  return (
    <Popover
      label={label}
      testId={testId}
      align="start"
      buttonClassName="w-full justify-between"
      button={<span className="max-w-full truncate">{summary}</span>}
    >
      {() => (
        <div className="grid gap-1">
          {options.length === 0 ? <p className="text-muted">{t('table.noRows')}</p> : null}
          {options.map((option) => (
            <label key={option.value} className="flex min-w-0 cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-brass-soft">
              <input
                type="checkbox"
                className="size-4 shrink-0 accent-[var(--app-pine)]"
                checked={chosen.has(option.value)}
                data-testid={`${testId}-option`}
                data-value={secure ? undefined : option.value}
                onChange={() => onChange(chosen.has(option.value) ? selected.filter((item) => item !== option.value) : [...selected, option.value])}
              />
              <span className="min-w-0 break-words">{option.label}</span>
            </label>
          ))}
          {selected.length > 0 ? (
            <button type="button" className="mt-1 justify-self-start text-sm text-pine-ink hover:underline" onClick={() => onChange([])}>
              {t('table.clearFilter')}
            </button>
          ) : null}
        </div>
      )}
    </Popover>
  )
}
