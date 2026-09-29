import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

export const toolButton =
  'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl border border-line bg-card px-3 text-sm text-ink transition hover:border-brass focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pine-ink/40 aria-expanded:border-pine-ink disabled:opacity-60'

/** A button that opens a small panel; closes on Escape (returning focus) or a press outside. */
export function Popover({
  label,
  button,
  testId,
  align = 'end',
  wide = false,
  buttonClassName = '',
  children,
}: {
  label: string
  button: ReactNode
  testId?: string
  align?: 'start' | 'end'
  wide?: boolean
  buttonClassName?: string
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', onPointer)
    root.current?.addEventListener('keydown', onKey)
    const node = root.current
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      node?.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        className={`${toolButton} ${buttonClassName}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        data-testid={testId}
        onClick={() => setOpen((value) => !value)}
      >
        {button}
      </button>
      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label={label}
          data-testid={testId ? `${testId}-panel` : undefined}
          className={`absolute top-full z-30 mt-2 max-h-[70vh] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-2xl border border-line bg-card p-3 text-sm shadow-[0_18px_50px_rgba(0,0,0,0.18)] ${wide ? 'w-80' : 'w-64'} ${align === 'end' ? 'right-0' : 'left-0'}`}
        >
          {children(() => {
            setOpen(false)
            trigger.current?.focus()
          })}
        </div>
      ) : null}
    </div>
  )
}
