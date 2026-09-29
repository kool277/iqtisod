import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { AuthFrame } from '../AuthScreens'
import { BrandLockup } from '../Brand'
import { PasswordHint, ThrottleNotice } from './AuthBits'
import { Button, Field, Notice, controlClass } from '../ui'
import { useI18n } from '../../context/I18nContext'
import { useVault } from '../../context/VaultContext'
import { textForError } from '../../lib/errors'
import { LIMITS } from '../../lib/limits'
import { ThrottledError } from '../../lib/throttle'
import { useCountdown } from '../../lib/use-countdown'

export function RegisterPage() {
  const { t } = useI18n()
  const { status, redeem, guardWait } = useVault()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const kind = params.get('kind') === 'reset' ? 'RESET' : 'INVITE'
  const [email, setEmail] = useState(() => params.get('email') ?? '')
  const [code, setCode] = useState(() => params.get('code') ?? '')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const countdown = useCountdown()

  // A shared link may carry the email and code; keep them out of the address bar and history.
  useEffect(() => {
    if (params.has('email') || params.has('code')) {
      navigate({ pathname: '/register', search: kind === 'RESET' ? '?kind=reset' : '' }, { replace: true })
    }
  }, [params, navigate, kind])

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    if (password !== confirm) {
      setError(t('setup.passwordMismatch'))
      return
    }
    const wait = guardWait('code', email)
    if (wait > 0) {
      countdown.start(wait)
      return
    }
    setPending(true)
    try {
      await redeem({ kind, email, code, password })
    } catch (caught) {
      if (caught instanceof ThrottledError) countdown.start(caught.waitMs)
      else setError(textForError(caught, t))
    } finally {
      setPending(false)
    }
  }

  const reset = kind === 'RESET'
  return (
    <AuthFrame>
      <BrandLockup className="lg:hidden" />
      <h2 className="mt-2 font-display text-4xl">{reset ? t('register.titleReset') : t('register.title')}</h2>
      <p className="mt-2 text-sm text-muted">{reset ? t('register.subtitleReset') : t('register.subtitle')}</p>
      {status === 'setup' ? (
        <div className="mt-6 grid gap-3">
          <p role="note" data-testid="register-no-vault" className="rounded-2xl border border-brass/50 bg-brass-soft px-3 py-2 text-sm">
            {t('register.noVault')}
          </p>
          <Link to="/setup" className="text-sm text-pine-ink hover:underline">
            {t('register.importFirst')}
          </Link>
        </div>
      ) : (
        <form className="mt-6 grid gap-4" onSubmit={(event) => void onSubmit(event)}>
          {error ? <Notice>{error}</Notice> : null}
          <ThrottleNotice remaining={countdown.remaining} />
          <Field label={t('register.email')}>
            <input
              data-testid="register-email"
              type="email"
              autoComplete="username"
              className={controlClass}
              maxLength={LIMITS.emailChars}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </Field>
          <Field label={t('register.code')}>
            <input
              data-testid="register-code"
              className={`${controlClass} font-mono tracking-wider`}
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={64}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
            />
            <span className="mt-1 block text-xs text-muted">{t('register.codeHint')}</span>
          </Field>
          <Field label={t('register.password')}>
            <input
              data-testid="register-password"
              type="password"
              autoComplete="new-password"
              className={controlClass}
              maxLength={LIMITS.passwordMax}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            <PasswordHint />
          </Field>
          <Field label={t('register.confirm')}>
            <input
              data-testid="register-confirm"
              type="password"
              autoComplete="new-password"
              className={controlClass}
              maxLength={LIMITS.passwordMax}
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              required
            />
          </Field>
          <Button type="submit" data-testid="register-submit" disabled={pending || countdown.remaining > 0}>
            {pending ? t('register.working') : reset ? t('register.submitReset') : t('register.submit')}
          </Button>
          <p className="text-xs text-muted">{t('register.sameDevice')}</p>
        </form>
      )}
      <div className="mt-6 border-t border-line pt-4 text-sm">
        <Link to={status === 'setup' ? '/setup' : '/login'} className="text-pine-ink hover:underline">
          {t('register.backToLogin')}
        </Link>
      </div>
    </AuthFrame>
  )
}
