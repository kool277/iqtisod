import { Briefcase, CreditCard, Heart, House, Plane, Shield, Vault, Wallet, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useI18n } from '../../context/I18nContext'
import { useSafes } from '../../context/SafeContext'
import { useVault } from '../../context/VaultContext'
import { AuthError } from '../../domain/errors'
import type { SafeColor, SafeIcon } from '../../domain/safes'
import type { OpenVault } from '../../domain/types'
import { toIsoDate } from '../../lib/dates'
import { textForError } from '../../lib/errors'
import { confirmRecentAuth, type SafeKeyring } from '../../services/safe.service'
import { Button, Field, Notice, controlClass } from '../ui'
import { HelpLink, type HelpSectionId } from '../help/HelpLink'

export const secureInputProps = {
  autoComplete: 'off',
  spellCheck: false,
  autoCorrect: 'off',
  autoCapitalize: 'off',
} as const

const ICONS: Record<SafeIcon, typeof Vault> = {
  vault: Vault,
  'credit-card': CreditCard,
  wallet: Wallet,
  briefcase: Briefcase,
  home: House,
  plane: Plane,
  heart: Heart,
  shield: Shield,
}

export const COLOR_CLASSES: Record<SafeColor, string> = {
  pine: 'bg-pine/15 text-pine-ink',
  brass: 'bg-brass-soft text-brass',
  clay: 'bg-clay/15 text-clay-ink',
  slate: 'bg-muted/15 text-muted',
}

export function SafeGlyph({ icon, color, size = 'md' }: { icon: SafeIcon; color: SafeColor; size?: 'sm' | 'md' | 'lg' }) {
  const Icon = ICONS[icon] ?? Vault
  const box = size === 'lg' ? 'size-12 rounded-2xl' : size === 'sm' ? 'size-7 rounded-lg' : 'size-10 rounded-xl'
  return (
    <span className={`grid shrink-0 place-items-center ${box} ${COLOR_CLASSES[color] ?? COLOR_CLASSES.pine}`} aria-hidden="true">
      <Icon size={size === 'lg' ? 22 : size === 'sm' ? 14 : 18} />
    </span>
  )
}

export function iconFor(icon: SafeIcon): typeof Vault {
  return ICONS[icon] ?? Vault
}

export function useSafeQuery<T>(fn: (vault: OpenVault, keyring: SafeKeyring) => Promise<T>, deps: readonly unknown[]): { data: T | null; error: unknown } {
  const { withKeyring, version, keyring } = useSafes()
  const { revision } = useVault()
  const [state, setState] = useState<{ data: T | null; error: unknown }>({ data: null, error: null })
  const fnRef = useRef(fn)
  fnRef.current = fn
  useEffect(() => {
    if (!keyring) return
    let cancelled = false
    withKeyring((vault, current) => fnRef.current(vault, current)).then(
      (data) => !cancelled && setState({ data, error: null }),
      (error: unknown) => !cancelled && setState({ data: null, error }),
    )
    return () => {
      cancelled = true
    }
  }, [withKeyring, keyring, version, revision, ...deps])
  return state
}

export function todayIso(): string {
  return toIsoDate(new Date())
}

export function PageHeader({ title, intro, actions, help }: { title: string; intro?: string; actions?: ReactNode; help?: HelpSectionId }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h1 className="break-words font-display text-4xl">{title}</h1>
          {help ? <HelpLink section={help} /> : null}
        </div>
        {intro ? <p className="mt-1 max-w-2xl text-sm text-muted">{intro}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

export function ErrorNotice({ error }: { error: unknown }) {
  const { t } = useI18n()
  if (error == null) return null
  return <Notice>{error instanceof AuthError ? t('safes.wrongPassword') : textForError(error, t)}</Notice>
}

export function Success({ children }: { children: ReactNode }) {
  return (
    <p role="status" data-testid="form-success" className="rounded-xl bg-pine/10 px-3 py-2 text-sm text-pine-ink">
      {children}
    </p>
  )
}

export function Warning({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div role="note" data-testid={testId} className="rounded-2xl border border-brass/50 bg-brass-soft px-4 py-3 text-sm">
      {children}
    </div>
  )
}

export function PasswordInput({
  label,
  value,
  onChange,
  testId,
  autoComplete = 'current-password',
  autoFocus,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  testId: string
  autoComplete?: 'current-password' | 'new-password' | 'off'
  autoFocus?: boolean
}) {
  return (
    <Field label={label}>
      <input
        type="password"
        required
        data-testid={testId}
        className={controlClass}
        value={value}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  )
}

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

export function ReauthDialog({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { t } = useI18n()
  const { withKeyring } = useSafes()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await withKeyring((vault, keyring) => confirmRecentAuth(vault, keyring, password))
      setPassword('')
      onDone()
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog title={t('safes.reauthTitle')} onClose={onCancel} testId="reauth-dialog">
      <form className="space-y-4" onSubmit={(event) => void submit(event)}>
        <p className="text-sm text-muted">{t('safes.reauthBody')}</p>
        <PasswordInput label={t('login.password')} value={password} onChange={setPassword} testId="reauth-password" autoFocus />
        <ErrorNotice error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="quiet" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={busy} data-testid="reauth-submit">
            {t('safes.reauthSubmit')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
