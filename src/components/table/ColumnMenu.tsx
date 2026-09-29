import { ArrowDown, ArrowUp, Columns3 } from 'lucide-react'
import { useI18n } from '../../context/I18nContext'
import type { Column } from './columns'
import { Popover } from './Popover'

const iconButton = 'grid size-7 shrink-0 place-items-center rounded-lg text-muted hover:bg-brass-soft hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent'

export function ColumnMenu<T>({
  tableId,
  ordered,
  hidden,
  dense,
  onToggle,
  onMove,
  onDense,
  onReset,
}: {
  tableId: string
  ordered: readonly Column<T>[]
  hidden: ReadonlySet<string>
  dense: boolean
  onToggle: (column: string) => void
  onMove: (column: string, delta: -1 | 1) => void
  onDense: (dense: boolean) => void
  onReset: () => void
}) {
  const { t } = useI18n()
  const shown = ordered.length - hidden.size
  return (
    <Popover
      label={t('table.columns')}
      testId={`${tableId}-columns`}
      wide
      button={
        <>
          <Columns3 size={15} aria-hidden="true" />
          <span className="hidden sm:inline">{t('table.columns')}</span>
          {hidden.size > 0 ? <span className="rounded-full bg-brass-soft px-1.5 text-xs tabular-nums text-brass">{shown}/{ordered.length}</span> : null}
        </>
      }
    >
      {() => (
        <div className="grid gap-2">
          <p className="text-xs text-muted">{t('table.columnsHint')}</p>
          <ul className="grid gap-0.5">
            {ordered.map((column, position) => {
              const locked = column.hideable === false
              const visible = !hidden.has(column.id)
              return (
                <li key={column.id} className="flex min-w-0 items-center gap-1 rounded-lg px-1 hover:bg-paper">
                  <label className={`flex min-w-0 flex-1 items-center gap-2 py-1 ${locked ? 'text-muted' : 'cursor-pointer'}`}>
                    <input
                      type="checkbox"
                      className="size-4 shrink-0 accent-[var(--app-pine)]"
                      checked={visible}
                      disabled={locked || (visible && shown === 1)}
                      data-testid={`column-toggle-${column.id}`}
                      onChange={() => onToggle(column.id)}
                    />
                    <span className="min-w-0 truncate">{column.header}</span>
                  </label>
                  <button
                    type="button"
                    className={iconButton}
                    aria-label={`${t('table.moveUp')}: ${column.header}`}
                    disabled={position === 0}
                    onClick={() => onMove(column.id, -1)}
                  >
                    <ArrowUp size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={iconButton}
                    aria-label={`${t('table.moveDown')}: ${column.header}`}
                    disabled={position === ordered.length - 1}
                    onClick={() => onMove(column.id, 1)}
                  >
                    <ArrowDown size={14} aria-hidden="true" />
                  </button>
                </li>
              )
            })}
          </ul>
          <label className="flex cursor-pointer items-center gap-2 border-t border-line pt-2">
            <input type="checkbox" className="size-4 accent-[var(--app-pine)]" checked={dense} data-testid={`${tableId}-dense`} onChange={(event) => onDense(event.target.checked)} />
            {t('table.dense')}
          </label>
          <button type="button" data-testid={`${tableId}-reset`} className="justify-self-start text-sm text-pine-ink hover:underline" onClick={onReset}>
            {t('table.resetLayout')}
          </button>
        </div>
      )}
    </Popover>
  )
}
