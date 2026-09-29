import { useState, type FormEvent } from 'react'
import { useI18n } from '../../context/I18nContext'
import { SAFE_COLORS, SAFE_ICONS, SAFE_LIMITS, type SafeColor, type SafeInput } from '../../domain/safes'
import { Button, Field, controlClass } from '../ui'
import { ErrorNotice, iconFor, secureInputProps } from './shared'

const SWATCHES: Record<SafeColor, string> = { pine: 'bg-pine', brass: 'bg-brass', clay: 'bg-clay', slate: 'bg-muted' }

export const EMPTY_SAFE: SafeInput = { name: '', description: '', icon: 'vault', color: 'pine', requirePassword: false }

export function SafeForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: SafeInput
  submitLabel: string
  onSubmit: (input: SafeInput) => Promise<void>
  onCancel?: () => void
}) {
  const { t } = useI18n()
  const [input, setInput] = useState<SafeInput>(initial)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await onSubmit(input)
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="space-y-4" onSubmit={(event) => void submit(event)} data-testid="safe-form">
      <Field label={t('safes.safeName')}>
        <input
          {...secureInputProps}
          required
          maxLength={SAFE_LIMITS.safeName}
          data-testid="safe-name"
          className={controlClass}
          value={input.name}
          onChange={(event) => setInput({ ...input, name: event.target.value })}
        />
      </Field>
      <Field label={t('safes.description')}>
        <textarea
          {...secureInputProps}
          rows={2}
          maxLength={SAFE_LIMITS.description}
          data-testid="safe-description"
          className={controlClass}
          value={input.description}
          onChange={(event) => setInput({ ...input, description: event.target.value })}
        />
      </Field>
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">{t('safes.icon')}</legend>
        <div className="flex flex-wrap gap-2">
          {SAFE_ICONS.map((icon) => {
            const Icon = iconFor(icon)
            const selected = input.icon === icon
            return (
              <label
                key={icon}
                className={`grid size-10 cursor-pointer place-items-center rounded-xl border ${selected ? 'border-pine-ink bg-pine/10 text-pine-ink' : 'border-line text-muted hover:text-ink'}`}
              >
                <input type="radio" name="safe-icon" className="sr-only" checked={selected} onChange={() => setInput({ ...input, icon })} />
                <Icon size={18} aria-hidden="true" />
                <span className="sr-only">{t(`safes.icons.${icon}`)}</span>
              </label>
            )
          })}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">{t('safes.color')}</legend>
        <div className="flex flex-wrap gap-2">
          {SAFE_COLORS.map((color) => {
            const selected = input.color === color
            return (
              <label
                key={color}
                className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm ${selected ? 'border-pine-ink' : 'border-line'}`}
              >
                <input type="radio" name="safe-color" className="sr-only" checked={selected} onChange={() => setInput({ ...input, color })} />
                <span className={`size-4 rounded-full ${SWATCHES[color]}`} aria-hidden="true" />
                {t(`safes.colors.${color}`)}
              </label>
            )
          })}
        </div>
      </fieldset>
      <label className="flex cursor-pointer items-start gap-3 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 accent-[var(--app-pine)]"
          data-testid="safe-require-password"
          checked={input.requirePassword}
          onChange={(event) => setInput({ ...input, requirePassword: event.target.checked })}
        />
        <span className="min-w-0">{t('safes.requirePassword')}</span>
      </label>
      <ErrorNotice error={error} />
      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button variant="quiet" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        ) : null}
        <Button type="submit" disabled={busy} data-testid="safe-submit">
          {submitLabel}
        </Button>
      </div>
    </form>
  )
}
