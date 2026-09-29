import { Check, Pencil, X } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { useI18n } from '../../context/I18nContext'
import { textForError } from '../../lib/errors'
import type { EditSpec } from './columns'
import { fill } from './model'

const fieldClass =
  'h-8 w-full min-w-24 rounded-lg border border-pine-ink bg-card px-2 text-sm outline-none ring-2 ring-pine-ink/25'
const miniButton = 'grid size-7 shrink-0 place-items-center rounded-lg border border-line bg-card hover:border-brass disabled:opacity-50'

export function EditableCell<T>({
  row,
  spec,
  header,
  testId,
  editing,
  onStart,
  onStop,
  children,
}: {
  row: T
  spec: EditSpec<T>
  header: string
  testId: string
  editing: boolean
  onStart: () => void
  onStop: () => void
  children: ReactNode
}) {
  const { t } = useI18n()
  if (!editing) {
    return (
      <span className="group/edit flex min-w-0 items-start gap-1">
        <span className="min-w-0 flex-1">{children}</span>
        <button
          type="button"
          data-testid={`edit-${testId}`}
          aria-label={fill(t('table.editCell'), { column: header })}
          title={t('table.editHint')}
          className="grid size-6 shrink-0 place-items-center rounded-md text-muted opacity-60 transition hover:bg-brass-soft hover:text-ink focus-visible:opacity-100 group-hover/edit:opacity-100 @max-3xl:opacity-100"
          onClick={onStart}
        >
          <Pencil size={13} aria-hidden="true" />
        </button>
      </span>
    )
  }
  return <Editor row={row} spec={spec} header={header} testId={testId} onStop={onStop} />
}

function Editor<T>({ row, spec, header, testId, onStop }: { row: T; spec: EditSpec<T>; header: string; testId: string; onStop: () => void }) {
  const { t } = useI18n()
  const [value, setValue] = useState(() => spec.value(row))
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const field = useRef<HTMLInputElement & HTMLSelectElement>(null)
  const errorId = `${testId}-error`

  useEffect(() => {
    field.current?.focus()
    if (field.current instanceof HTMLInputElement && spec.input !== 'date') field.current.select()
  }, [spec.input])

  async function save(event?: FormEvent) {
    event?.preventDefault()
    if (pending) return
    if (value === spec.value(row)) {
      onStop()
      return
    }
    setPending(true)
    setError(null)
    try {
      await spec.save(row, value)
      onStop()
    } catch (caught) {
      setError(textForError(caught, t))
      setPending(false)
      field.current?.focus()
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onStop()
    }
  }

  const common = {
    ref: field,
    'aria-label': header,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? errorId : undefined,
    'data-testid': `editor-${testId}`,
    disabled: pending,
    className: fieldClass,
    onKeyDown,
  }
  return (
    <form className="grid min-w-0 gap-1" onSubmit={(event) => void save(event)} noValidate>
      <span className="flex min-w-0 items-center gap-1">
        {spec.input === 'select' ? (
          <select {...common} value={value} onChange={(event) => setValue(event.target.value)}>
            {(spec.options?.(row) ?? []).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            {...common}
            type={spec.input === 'date' ? 'date' : 'text'}
            inputMode={spec.input === 'decimal' ? 'decimal' : undefined}
            autoComplete="off"
            maxLength={spec.maxLength}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        )}
        <button type="submit" className={`${miniButton} text-pine-ink`} disabled={pending} aria-label={t('table.save')} data-testid={`save-${testId}`}>
          <Check size={14} aria-hidden="true" />
        </button>
        <button type="button" className={miniButton} disabled={pending} aria-label={t('table.cancel')} onClick={onStop} onKeyDown={onKeyDown}>
          <X size={14} aria-hidden="true" />
        </button>
      </span>
      {error ? (
        <span id={errorId} role="alert" data-testid={`error-${testId}`} className="text-xs text-clay-ink">
          {error}
        </span>
      ) : null}
    </form>
  )
}
