import { useState, type FormEvent } from 'react'
import { ThrottleNotice } from './AuthBits'
import { Button, Field, Notice, controlClass } from '../ui'
import { useI18n } from '../../context/I18nContext'
import { useVault } from '../../context/VaultContext'
import { textForError } from '../../lib/errors'
import { ThrottledError } from '../../lib/throttle'
import { useCountdown } from '../../lib/use-countdown'

export function SignInCheckStep() {
  const { t } = useI18n()
  const { verifySignInCheck, cancelSignInCheck } = useVault()
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const countdown = useCountdown()

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      await verifySignInCheck(code)
    } catch (caught) {
      setCode('')
      if (caught instanceof ThrottledError) countdown.start(caught.waitMs)
      else setError(textForError(caught, t))
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <h2 className="mt-2 font-display text-4xl">{t('signInCheck.promptTitle')}</h2>
      <p className="mt-2 text-sm text-muted">{t('signInCheck.prompt')}</p>
      <form className="mt-6 grid gap-4" onSubmit={(event) => void onSubmit(event)}>
        {error ? <Notice>{error}</Notice> : null}
        <ThrottleNotice remaining={countdown.remaining} />
        <Field label={t('signInCheck.promptCode')}>
          <input
            data-testid="totp-code"
            className={`${controlClass} font-mono tracking-widest`}
            inputMode="text"
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={24}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            required
            autoFocus
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" data-testid="totp-submit" disabled={pending || countdown.remaining > 0}>
            {pending ? t('signInCheck.working') : t('signInCheck.verify')}
          </Button>
          <Button variant="quiet" data-testid="totp-cancel" onClick={cancelSignInCheck}>
            {t('signInCheck.cancel')}
          </Button>
        </div>
      </form>
    </>
  )
}
