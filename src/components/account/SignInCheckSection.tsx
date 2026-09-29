import { ShieldCheck } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { ErrorNotice, PasswordInput, Success } from '../safes/shared'
import { Button, Field, Panel, controlClass } from '../ui'
import { useI18n } from '../../context/I18nContext'
import { useVault } from '../../context/VaultContext'
import { copySecret } from '../../lib/clipboard'
import { downloadFile } from '../../lib/download'
import { beginTotpSetup, disableTotp, enableTotp, hasSignInCheck, type TotpSetup } from '../../services/totp.service'

const CLIPBOARD_SECONDS = 60

function QrCode({ text }: { text: string }) {
  const { t } = useI18n()
  const [path, setPath] = useState<{ viewBox: string; d: string } | null>(null)
  useEffect(() => {
    let cancelled = false
    void import('../../lib/qr').then(({ encodeQr, qrPath }) => {
      if (!cancelled) setPath(qrPath(encodeQr(text, 'M')))
    })
    return () => {
      cancelled = true
    }
  }, [text])
  if (!path) return <div role="status" className="grid size-48 place-items-center rounded-2xl border border-line text-xs text-muted">{t('signInCheck.qrLoading')}</div>
  return (
    <svg role="img" aria-label={t('signInCheck.qrAlt')} viewBox={path.viewBox} className="size-48 rounded-2xl bg-white p-1" shapeRendering="crispEdges">
      <path d={path.d} fill="#000" />
    </svg>
  )
}

function groupSecret(secret: string): string {
  return secret.match(/.{1,4}/g)?.join(' ') ?? secret
}

export function SignInCheckSection() {
  const { t } = useI18n()
  const { user, query, run, revision } = useVault()
  const enabled = useMemo(() => (user ? query((vault) => hasSignInCheck(vault.db, vault.user.id)) : false), [user, query, revision])
  const [setup, setSetup] = useState<TotpSetup | null>(null)
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [recovery, setRecovery] = useState<string[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [done, setDone] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [disabling, setDisabling] = useState(false)
  if (!user) return null

  const start = () => {
    setError(null)
    setDone(null)
    setSetup(beginTotpSetup(user.email))
  }

  const cancel = () => {
    setSetup(null)
    setCode('')
    setPassword('')
    setError(null)
  }

  const confirm = async (event: FormEvent) => {
    event.preventDefault()
    if (!setup) return
    setBusy(true)
    setError(null)
    try {
      const codes = await run((vault) => enableTotp(vault, password, setup, code), { dirty: true })
      setSetup(null)
      setRecovery(codes)
      setDone(t('signInCheck.enabled'))
    } catch (caught) {
      setError(caught)
    } finally {
      setCode('')
      setPassword('')
      setBusy(false)
    }
  }

  const disable = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await run((vault) => disableTotp(vault, password), { dirty: true })
      setDisabling(false)
      setDone(t('signInCheck.disabled'))
    } catch (caught) {
      setError(caught)
    } finally {
      setPassword('')
      setBusy(false)
    }
  }

  return (
    <Panel className="max-w-2xl">
      <div data-testid="sign-in-check" data-state={enabled ? 'on' : 'off'} className="space-y-4">
        <div className="flex items-center gap-3">
          <span className={`grid size-9 shrink-0 place-items-center rounded-xl ${enabled ? 'bg-pine/15 text-pine-ink' : 'bg-brass-soft text-muted'}`} aria-hidden="true">
            <ShieldCheck size={16} />
          </span>
          <h2 className="font-display text-2xl">{t('signInCheck.title')}</h2>
          <span className="ml-auto text-sm text-muted">{enabled ? t('signInCheck.statusOn') : t('signInCheck.statusOff')}</span>
        </div>
        <p className="text-sm text-muted">{t('signInCheck.intro')}</p>
        <p role="note" className="rounded-2xl border border-brass/50 bg-brass-soft px-3 py-2 text-sm">
          {t('signInCheck.honest')}
        </p>
        {done ? <Success>{done}</Success> : null}

        {recovery ? (
          <div data-testid="totp-recovery" className="space-y-3 rounded-2xl border border-pine/40 bg-paper p-4">
            <h3 className="font-medium">{t('signInCheck.recoveryTitle')}</h3>
            <p className="text-sm text-muted">{t('signInCheck.recoveryIntro')}</p>
            <ul className="grid grid-cols-1 gap-1 font-mono text-sm sm:grid-cols-2">
              {recovery.map((item) => (
                <li key={item} className="select-all">
                  {item}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button variant="quiet" onClick={() => downloadFile(`${recovery.join('\n')}\n`, 'jaybi-sign-in-recovery.txt', 'text/plain;charset=utf-8')}>
                {t('signInCheck.recoveryDownload')}
              </Button>
              <Button data-testid="totp-recovery-done" onClick={() => setRecovery(null)}>
                {t('signInCheck.recoveryDone')}
              </Button>
            </div>
          </div>
        ) : null}

        {!enabled && !setup && !recovery ? (
          <Button data-testid="totp-start" onClick={start}>
            {t('signInCheck.enable')}
          </Button>
        ) : null}

        {setup ? (
          <form data-testid="totp-setup" className="space-y-4" onSubmit={(event) => void confirm(event)}>
            <p className="text-sm">{t('signInCheck.scan')}</p>
            <div className="flex flex-wrap items-start gap-4">
              <QrCode text={setup.uri} />
              <div className="min-w-0 flex-1 space-y-2">
                <p className="text-sm font-medium">{t('signInCheck.secret')}</p>
                <p data-testid="totp-secret" className="select-all break-all font-mono text-sm tracking-wider">
                  {groupSecret(setup.secret)}
                </p>
                <Button variant="quiet" onClick={() => void copySecret(setup.secret, CLIPBOARD_SECONDS).catch(() => undefined)}>
                  {t('signInCheck.copySecret')}
                </Button>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('signInCheck.code')}>
                <input
                  data-testid="totp-setup-code"
                  className={`${controlClass} font-mono tracking-widest`}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                  required
                />
              </Field>
              <PasswordInput label={t('signInCheck.password')} value={password} onChange={setPassword} testId="totp-setup-password" />
            </div>
            <ErrorNotice error={error} />
            <div className="flex justify-end gap-2">
              <Button variant="quiet" onClick={cancel}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={busy} data-testid="totp-confirm">
                {busy ? t('signInCheck.working') : t('signInCheck.confirm')}
              </Button>
            </div>
          </form>
        ) : null}

        {enabled && !recovery ? (
          disabling ? (
            <form className="space-y-4" onSubmit={(event) => void disable(event)}>
              <p className="text-sm">{t('signInCheck.disableHelp')}</p>
              <PasswordInput label={t('signInCheck.password')} value={password} onChange={setPassword} testId="totp-disable-password" />
              <ErrorNotice error={error} />
              <div className="flex justify-end gap-2">
                <Button variant="quiet" onClick={() => setDisabling(false)}>
                  {t('common.cancel')}
                </Button>
                <Button type="submit" variant="danger" disabled={busy} data-testid="totp-disable-confirm">
                  {t('signInCheck.disable')}
                </Button>
              </div>
            </form>
          ) : (
            <Button variant="quiet" data-testid="totp-disable" onClick={() => setDisabling(true)}>
              {t('signInCheck.disable')}
            </Button>
          )
        ) : null}
      </div>
    </Panel>
  )
}
