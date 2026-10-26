import { Suspense, lazy, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { PasswordHint, ThrottleNotice } from './auth/AuthBits'
import { SignInCheckStep } from './auth/SignInCheckStep'
import { KeysCatalog } from './keys/KeysCatalog'
import { BrandLockup } from './Brand'
import { Preferences } from './Preferences'
import { Button, Field, Notice, controlClass } from './ui'
import { useI18n } from '../context/I18nContext'
import { useVault } from '../context/VaultContext'
import { KeysBlockedError } from '../domain/errors'
import { CURRENCIES } from '../domain/types'
import { errorText, textForError } from '../lib/errors'
import { keysEnabled } from '../lib/flags'
import { LIMITS } from '../lib/limits'
import { isNewAddress } from '../lib/origin-move'
import { ThrottledError } from '../lib/throttle'
import { useCountdown } from '../lib/use-countdown'
import { APP_VERSION } from '../lib/version'
import type { ParsedBackup } from '../services/backup.service'
import { BackupTooLargeError, budgetText, tooLargeText, useBackupImport } from './backup-import'

const HealthPage = lazy(() => import('./health/HealthPage').then((module) => ({ default: module.HealthPage })))
// Only for a vault with per-person keys.
const TrustStep = lazy(() => import('./auth/TrustStep').then((module) => ({ default: module.TrustStep })))
const BlockedEscape = lazy(() => import('./auth/BlockedEscape').then((module) => ({ default: module.BlockedEscape })))

/** Help and the health check, for people who cannot get in. */
function SupportLinks() {
  const { t } = useI18n()
  return (
    <>
      <Link to="/help" data-testid="help-entry" className="text-pine-ink hover:underline">
        {t('nav.help')}
      </Link>
      <Link to="/health" data-testid="health-entry" className="text-pine-ink hover:underline">
        {t('nav.health')}
      </Link>
    </>
  )
}

export function Splash() {
  return (
    <div className="grid min-h-screen place-items-center">
      <BrandLockup size="lg" />
    </div>
  )
}

const DATA_ERRORS = new Set(['FORMAT_TOO_NEW', 'RECORD_INVALID'])

export function BootError({ message }: { message: string }) {
  const { t } = useI18n()
  const known = DATA_ERRORS.has(message)
  const [health, setHealth] = useState(false)
  return (
    <div className="grid min-h-screen place-items-center gap-8 p-6">
      <div className="max-w-md text-center">
        <h1>
          <BrandLockup />
        </h1>
        <p data-testid="boot-error" data-code={message} className="mt-4 text-clay-ink">
          {known ? errorText(message, t) : t('errors.sqlite')}
        </p>
        {known ? null : <p className="mt-2 text-sm text-muted">{message}</p>}
        <p className="mt-6 text-xs text-muted">v{APP_VERSION}</p>
        {health ? null : (
          <button type="button" data-testid="boot-health" className="mt-4 text-sm text-pine-ink hover:underline" onClick={() => setHealth(true)}>
            {t('nav.health')}
          </button>
        )}
      </div>
      {health ? (
        <div className="w-full max-w-4xl text-left">
          <Suspense fallback={<div role="status" aria-busy="true" className="min-h-40" />}>
            <HealthPage mode="embedded" />
          </Suspense>
        </div>
      ) : null}
    </div>
  )
}

export function AuthFrame({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
      <section className="hidden flex-col justify-between bg-[#14532d] p-12 text-[#f6f1e7] lg:flex">
        <BrandLockup size="lg" />
        <div>
          <h1 className="max-w-lg font-display text-6xl leading-[0.95]">{t('app.tagline')}</h1>
        </div>
        <div>
          <p className="max-w-sm text-sm text-[#f6f1e7]/75">{t('app.localOnly')}</p>
          <p className="mt-3 text-xs text-[#f6f1e7]/75">v{APP_VERSION}</p>
        </div>
      </section>
      <section className="flex flex-col">
        <div className="flex justify-end p-4">
          <Preferences />
        </div>
        <div className="flex flex-1 items-center justify-center px-6 pb-12">
          <div className="w-full max-w-md">{children}</div>
        </div>
        <p className="pb-4 text-center text-xs text-muted lg:hidden">v{APP_VERSION}</p>
      </section>
    </div>
  )
}

export function SetupPage() {
  const { t } = useI18n()
  const { setup, importBackup } = useVault()
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [backup, setBackup] = useState<ParsedBackup | null>(null)
  const importRef = useRef<HTMLInputElement>(null)
  const [reading, setReading] = useState(false)
  const { capacity, readFile } = useBackupImport()
  // Setup creates per-person keys, which this browser may lack; importing a backup still works, so only setup stops.
  const [unsupported, setUnsupported] = useState(false)
  useEffect(() => {
    if (!keysEnabled()) return
    let live = true
    void import('../crypto/suite')
      .then(({ suiteSupported }) => suiteSupported())
      .then((supported) => {
        if (live) setUnsupported(!supported)
      })
    return () => {
      live = false
    }
  }, [])

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (password !== confirm) {
      setError(t('setup.passwordMismatch'))
      return
    }
    setPending(true)
    setError(null)
    try {
      await setup({ email, password, displayName, currency })
    } catch (caught) {
      setError(textForError(caught, t))
    } finally {
      setPending(false)
    }
  }

  async function onFile(input: HTMLInputElement) {
    setBackup(null)
    setError(null)
    const file = input.files?.[0]
    if (!file) return
    setReading(true)
    try {
      setBackup(await readFile(file))
    } catch (caught) {
      setError(caught instanceof BackupTooLargeError ? tooLargeText(caught, t) : textForError(caught, t))
      // Choosing the same file again (after freeing space, say) must fire `change` once more.
      input.value = ''
    } finally {
      setReading(false)
    }
  }

  return (
    <AuthFrame>
      <BrandLockup className="lg:hidden" />
      <h2 className="mt-2 font-display text-4xl">{t('setup.title')}</h2>
      <p className="mt-2 text-sm text-muted">{t('setup.subtitle')}</p>
      {isNewAddress() ? (
        <div data-testid="move-import-hint" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-brass/50 bg-brass-soft px-4 py-3 text-sm">
          <span className="min-w-0">{t('move.importHint')}</span>
          <button
            type="button"
            className="shrink-0 rounded-xl border border-line bg-card px-3 py-1.5 font-medium hover:border-brass"
            onClick={() => {
              importRef.current?.scrollIntoView({ block: 'center' })
              importRef.current?.focus()
            }}
          >
            {t('setup.import')}
          </button>
        </div>
      ) : null}
      <form className="mt-6 grid gap-4" onSubmit={(event) => void onSubmit(event)}>
        {unsupported ? (
          <p role="alert" data-testid="setup-unsupported" className="rounded-xl bg-clay/10 px-3 py-2 text-sm text-clay-ink">
            {errorText('V2_UNSUPPORTED_BROWSER', t)}
          </p>
        ) : null}
        {error ? <Notice>{error}</Notice> : null}
        <Field label={t('setup.displayName')}>
          <input data-testid="setup-name" className={controlClass} maxLength={LIMITS.nameChars} value={displayName} onChange={(event) => setDisplayName(event.target.value)} required />
        </Field>
        <Field label={t('setup.email')}>
          <input data-testid="setup-email" type="email" autoComplete="username" className={controlClass} maxLength={LIMITS.emailChars} value={email} onChange={(event) => setEmail(event.target.value)} required />
        </Field>
        <Field label={t('setup.password')}>
          <input data-testid="setup-password" type="password" autoComplete="new-password" className={controlClass} maxLength={LIMITS.passwordMax} value={password} onChange={(event) => setPassword(event.target.value)} required />
          <PasswordHint />
        </Field>
        <Field label={t('setup.confirmPassword')}>
          <input data-testid="setup-confirm" type="password" autoComplete="new-password" className={controlClass} value={confirm} onChange={(event) => setConfirm(event.target.value)} required />
        </Field>
        <Field label={t('setup.currency')}>
          <select data-testid="setup-currency" className={controlClass} value={currency} onChange={(event) => setCurrency(event.target.value)}>
            {CURRENCIES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </Field>
        <Button type="submit" data-testid="setup-submit" disabled={pending || unsupported}>
          {pending ? t('setup.working') : t('setup.submit')}
        </Button>
      </form>
      <div className="mt-8 border-t border-line pt-6">
        <h3 className="font-display text-2xl">{t('setup.import')}</h3>
        <p className="mt-1 text-sm text-muted">{t('backup.importHelp')}</p>
        <p data-testid="import-budget" className="mt-1 text-xs text-muted">
          {capacity ? budgetText(capacity, t) : t('security.importMeasuring')}
        </p>
        <input
          ref={importRef}
          data-testid="import-file"
          className="mt-3 block w-full text-sm"
          type="file"
          accept=".moliya,application/json"
          disabled={reading}
          onChange={(event) => void onFile(event.currentTarget)}
        />
        {reading ? <p data-testid="import-reading" className="mt-2 text-sm text-muted">{t('security.importReading')}</p> : null}
        {backup ? (
          <Button
            className="mt-3"
            variant="quiet"
            data-testid="confirm-import"
            onClick={() => {
              void importBackup(backup).catch((caught) => setError(textForError(caught, t)))
            }}
          >
            {t('backup.confirmImport')}
          </Button>
        ) : null}
      </div>
      <div className="mt-6 flex flex-wrap gap-x-4 gap-y-2 border-t border-line pt-4 text-sm">
        <SupportLinks />
      </div>
    </AuthFrame>
  )
}

export function LoginPage() {
  const { t } = useI18n()
  const { status, login, guardWait, lockReason } = useVault()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  // An older copy of a per-person-keys vault than this browser has seen: an admin may open it anyway.
  const [rollback, setRollback] = useState(false)
  // A per-person-keys vault that failed a blocking check: it can still be kept as a file.
  const [blocked, setBlocked] = useState(false)
  const [pending, setPending] = useState(false)
  const countdown = useCountdown()

  async function signIn(acceptRollback: boolean) {
    setError(null)
    setRollback(false)
    setBlocked(false)
    const wait = guardWait('login', email)
    if (wait > 0) {
      countdown.start(wait)
      return
    }
    setPending(true)
    try {
      await login(email, password, { acceptRollback })
      setPassword('')
    } catch (caught) {
      if (caught instanceof ThrottledError) countdown.start(caught.waitMs)
      else {
        setError(textForError(caught, t))
        setRollback(caught instanceof KeysBlockedError && caught.code === 'KEYS_ROSTER_ROLLBACK' && caught.admin && !acceptRollback)
        setBlocked(caught instanceof KeysBlockedError)
      }
    } finally {
      setPending(false)
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    await signIn(false)
  }

  if (status === 'challenge') {
    return (
      <AuthFrame>
        <BrandLockup className="lg:hidden" />
        <SignInCheckStep />
      </AuthFrame>
    )
  }

  if (status === 'trust') {
    return (
      <AuthFrame>
        <BrandLockup className="lg:hidden" />
        <Suspense fallback={<div role="status" aria-busy="true" className="min-h-40" />}>
          <TrustStep />
        </Suspense>
      </AuthFrame>
    )
  }

  return (
    <AuthFrame>
      <BrandLockup className="lg:hidden" />
      <h2 className="mt-2 font-display text-4xl">{t('login.title')}</h2>
      <p className="mt-2 text-sm text-muted">{t('login.subtitle')}</p>
      <form className="mt-6 grid gap-4" onSubmit={(event) => void onSubmit(event)}>
        {lockReason === 'idle' && !error ? (
          <p role="status" data-testid="idle-locked" className="rounded-xl bg-brass-soft px-3 py-2 text-sm">
            {t('login.idleLocked')}
          </p>
        ) : null}
        {error ? <Notice>{error}</Notice> : null}
        {rollback ? <RollbackOverride disabled={pending} onConfirm={() => void signIn(true)} /> : null}
        {blocked ? (
          <Suspense fallback={null}>
            <BlockedEscape />
          </Suspense>
        ) : null}
        <ThrottleNotice remaining={countdown.remaining} />
        <Field label={t('login.email')}>
          <input data-testid="login-email" type="email" autoComplete="username" className={controlClass} maxLength={LIMITS.emailChars} value={email} onChange={(event) => setEmail(event.target.value)} required />
        </Field>
        <Field label={t('login.password')}>
          <input data-testid="login-password" type="password" autoComplete="current-password" className={controlClass} value={password} onChange={(event) => setPassword(event.target.value)} required />
        </Field>
        <Button type="submit" data-testid="login-submit" disabled={pending || countdown.remaining > 0}>
          {pending ? t('login.working') : t('login.submit')}
        </Button>
      </form>
      <div className="mt-6 flex flex-wrap gap-x-4 gap-y-2 border-t border-line pt-4 text-sm">
        <Link to="/register" data-testid="join-link" className="text-pine-ink hover:underline">
          {t('register.joinLink')}
        </Link>
        <Link to="/register?kind=reset" data-testid="reset-link" className="text-pine-ink hover:underline">
          {t('register.resetLink')}
        </Link>
        <SupportLinks />
      </div>
    </AuthFrame>
  )
}

/** Asks again before an admin opens an older copy of a per-person-keys vault (design 4.10). */
function RollbackOverride({ disabled, onConfirm }: { disabled: boolean; onConfirm: () => void }) {
  return (
    <KeysCatalog>
      <RollbackOverrideBody disabled={disabled} onConfirm={onConfirm} />
    </KeysCatalog>
  )
}

function RollbackOverrideBody({ disabled, onConfirm }: { disabled: boolean; onConfirm: () => void }) {
  const { t } = useI18n()
  const [asking, setAsking] = useState(false)
  if (!asking) {
    return (
      <Button type="button" variant="quiet" data-testid="rollback-open" disabled={disabled} onClick={() => setAsking(true)}>
        {t('keys.rollback.open')}
      </Button>
    )
  }
  return (
    <div className="grid gap-2 rounded-xl border border-line p-3 text-sm" data-testid="rollback-confirm">
      <p>{t('keys.rollback.confirm')}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" data-testid="rollback-confirm-open" disabled={disabled} onClick={onConfirm}>
          {t('keys.rollback.open')}
        </Button>
        <Button type="button" variant="quiet" onClick={() => setAsking(false)}>
          {t('keys.trust.cancel')}
        </Button>
      </div>
    </div>
  )
}
