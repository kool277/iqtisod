import { X } from 'lucide-react'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { useI18n } from '../context/I18nContext'

export function Dialog({
  title,
  onClose,
  children,
  testId,
  wide,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  testId?: string
  wide?: boolean
}) {
  const { t } = useI18n()
  const titleId = useId()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const first = ref.current?.querySelector<HTMLElement>('input, select, textarea, button:not([data-dialog-close])')
    first?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      previous?.focus()
    }
  }, [onClose])
  return (
    <div className="fixed inset-0 z-40 grid place-items-center overflow-y-auto bg-ink/30 p-4" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        className={`w-full ${wide ? 'max-w-2xl' : 'max-w-md'} rounded-3xl border border-line bg-card p-5 shadow-xl`}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 id={titleId} className="min-w-0 break-words font-display text-2xl">
            {title}
          </h2>
          <button
            type="button"
            data-dialog-close
            aria-label={t('common.cancel')}
            title={t('common.cancel')}
            className="grid size-8 shrink-0 place-items-center rounded-full text-muted hover:bg-brass-soft hover:text-ink"
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
