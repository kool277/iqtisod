import { KeyRound, ShieldAlert } from 'lucide-react'
import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '../../context/I18nContext'
import { useSafes } from '../../context/SafeContext'
import { useVault } from '../../context/VaultContext'
import { DEFAULT_PREFS } from '../../domain/safes'
import { copySecret } from '../../lib/clipboard'
import { getSafeStatus, initializeSafes, unlockSafes, type SafeStatus } from '../../services/safe.service'
import { Button, Field, Panel, controlClass } from '../ui'
import { ErrorNotice, PasswordInput, Success, Warning, secureInputProps } from './shared'

export function useSafeStatus(): SafeStatus | null {
  const { query, user, revision } = useVault()
  const { version } = useSafes()
  return useMemo(() => (user ? query((vault) => getSafeStatus(vault)) : null), [query, user, revision, version])
}

function lastFourOf(code: string): string {
  return code.replace(/[^0-9A-Z]/gi, '').slice(-4).toUpperCase()
}

export function RecoveryCodeDisplay({ code, onDone }: { code: string; onDone: () => void }) {
  const { t } = useI18n()
  const { keyring } = useSafes()
  const [typed, setTyped] = useState('')
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null)
  const [mismatch, setMismatch] = useState(false)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (lastFourOf(typed) !== lastFourOf(code) || typed.replace(/[^0-9A-Z]/gi, '').length !== 4) {
      setMismatch(true)
      return
    }
    onDone()
  }
  const copy = async () => {
    try {
      await copySecret(code, keyring?.meta.clipboardSeconds ?? DEFAULT_PREFS.clipboardSeconds)
      setCopied('ok')
    } catch {
      setCopied('failed')
    }
  }
  return (
    <Panel className="mx-auto max-w-2xl">
      <form className="space-y-4" onSubmit={submit} data-testid="recovery-code-panel">
        <div className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brass-soft text-brass" aria-hidden="true">
            <KeyRound size={18} />
          </span>
          <h2 className="min-w-0 break-words font-display text-2xl">{t('safes.recoveryTitle')}</h2>
        </div>
        <p className="text-sm text-muted">{t('safes.recoveryBody')}</p>
        <p
          data-testid="recovery-code"
          className="select-all break-all rounded-2xl border border-dashed border-brass bg-paper px-4 py-4 text-center font-mono text-lg tracking-wider sm:text-xl"
          translate="no"
        >
          {code}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="quiet" onClick={() => void copy()} data-testid="recovery-copy">
            {t('safes.copy')}
          </Button>
          {copied === 'ok' ? <span className="text-sm text-muted">{t('safes.copied')}</span> : null}
          {copied === 'failed' ? <span className="text-sm text-clay-ink">{t('safes.copyFailed')}</span> : null}
        </div>
        <Field label={t('safes.recoveryConfirm')}>
          <input
            {...secureInputProps}
            data-testid="recovery-confirm"
            className={`${controlClass} max-w-40 font-mono uppercase`}
            maxLength={8}
            value={typed}
            onChange={(event) => {
              setTyped(event.target.value)
              setMismatch(false)
            }}
          />
        </Field>
        {mismatch ? (
          <p role="alert" data-testid="form-error" className="rounded-xl bg-clay/10 px-3 py-2 text-sm text-clay-ink">
            {t('safes.recoveryMismatch')}
          </p>
        ) : null}
        <div className="flex justify-end">
          <Button type="submit" data-testid="recovery-done">
            {t('safes.recoveryDone')}
          </Button>
        </div>
      </form>
    </Panel>
  )
}

export function RecoveryChoice({
  recovery,
  onRecovery,
  acknowledged,
  onAcknowledged,
}: {
  recovery: boolean
  onRecovery: (value: boolean) => void
  acknowledged: boolean
  onAcknowledged: (value: boolean) => void
}) {
  const { t } = useI18n()
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1.5 text-sm font-medium">{t('safes.recoveryChoice')}</legend>
      <label className={`flex cursor-pointer gap-3 rounded-2xl border p-3 ${recovery ? 'border-pine-ink bg-pine/5' : 'border-line'}`}>
        <input type="radio" name="recovery" className="mt-1 accent-[var(--app-pine)]" checked={recovery} onChange={() => onRecovery(true)} data-testid="recovery-yes" />
        <span className="min-w-0">
          <span className="block text-sm font-medium">{t('safes.recoveryYes')}</span>
          <span className="block text-sm text-muted">{t('safes.recoveryYesHelp')}</span>
        </span>
      </label>
      <label className={`flex cursor-pointer gap-3 rounded-2xl border p-3 ${!recovery ? 'border-clay bg-clay/5' : 'border-line'}`}>
        <input type="radio" name="recovery" className="mt-1 accent-[var(--app-clay)]" checked={!recovery} onChange={() => onRecovery(false)} data-testid="recovery-no" />
        <span className="min-w-0">
          <span className="block text-sm font-medium">{t('safes.recoveryNo')}</span>
          <span className="block text-sm text-muted">{t('safes.recoveryNoHelp')}</span>
        </span>
      </label>
      {!recovery ? (
        <label className="flex cursor-pointer gap-3 rounded-2xl bg-clay/10 p-3 text-sm text-clay-ink">
          <input
            type="checkbox"
            required
            className="mt-0.5 accent-[var(--app-clay)]"
            checked={acknowledged}
            onChange={(event) => onAcknowledged(event.target.checked)}
            data-testid="recovery-skip-confirm"
          />
          <span className="min-w-0">{t('safes.recoverySkipConfirm')}</span>
        </label>
      ) : null}
    </fieldset>
  )
}

function Onboarding({ onCode }: { onCode: (code: string) => void }) {
  const { t } = useI18n()
  const { run } = useVault()
  const { adopt } = useSafes()
  const [password, setPassword] = useState('')
  const [recovery, setRecovery] = useState(true)
  const [acknowledged, setAcknowledged] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!recovery && !acknowledged) return
    setBusy(true)
    setError(null)
    try {
      const result = await run((vault) => initializeSafes(vault, password, { recovery, defaultSafeName: t('safes.defaultSafeName') }), { dirty: true })
      setPassword('')
      if (result.recoveryCode) onCode(result.recoveryCode)
      adopt(result.keyring, null)
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Panel className="mx-auto max-w-2xl">
      <form className="space-y-4" onSubmit={(event) => void submit(event)} data-testid="safes-setup">
        <h2 className="break-words font-display text-2xl">{t('safes.setupTitle')}</h2>
        <p className="text-sm text-muted">{t('safes.setupBody')}</p>
        <PasswordInput label={t('safes.setupPassword')} value={password} onChange={setPassword} testId="safes-setup-password" autoFocus />
        <RecoveryChoice recovery={recovery} onRecovery={setRecovery} acknowledged={acknowledged} onAcknowledged={setAcknowledged} />
        <ErrorNotice error={error} />
        <div className="flex justify-end">
          <Button type="submit" disabled={busy || (!recovery && !acknowledged)} data-testid="safes-setup-submit">
            {busy ? t('safes.setupWorking') : t('safes.setupSubmit')}
          </Button>
        </div>
      </form>
    </Panel>
  )
}

function UnlockForm() {
  const { t } = useI18n()
  const { run } = useVault()
  const { adopt, lockReason, refresh } = useSafes()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await run((vault) => unlockSafes(vault, { kind: 'password', password }), { dirty: true })
      setPassword('')
      adopt(result.keyring, result.previousUnlockAt)
    } catch (caught) {
      setError(caught)
      refresh()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Panel className="mx-auto max-w-md">
      <form className="space-y-4" onSubmit={(event) => void submit(event)} data-testid="safes-unlock">
        {lockReason === 'idle' ? <Warning testId="safes-auto-locked">{t('safes.autoLocked')}</Warning> : null}
        <h2 className="break-words font-display text-2xl">{t('safes.unlockTitle')}</h2>
        <p className="text-sm text-muted">{t('safes.unlockBody')}</p>
        <PasswordInput label={t('login.password')} value={password} onChange={setPassword} testId="safes-unlock-password" autoFocus />
        <ErrorNotice error={error} />
        <Button type="submit" className="w-full" disabled={busy} data-testid="safes-unlock-submit">
          {busy ? t('safes.unlocking') : t('safes.unlock')}
        </Button>
      </form>
    </Panel>
  )
}

function StaleForm({ hasRecovery, onRecovered }: { hasRecovery: boolean; onRecovered: (withCode: boolean) => void }) {
  const { t } = useI18n()
  const { run } = useVault()
  const { adopt } = useSafes()
  const [mode, setMode] = useState<'previous' | 'recovery'>('previous')
  const [secret, setSecret] = useState('')
  const [current, setCurrent] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await run(
        (vault) =>
          unlockSafes(
            vault,
            mode === 'previous' ? { kind: 'previousPassword', previous: secret, current } : { kind: 'recoveryCode', code: secret, current },
          ),
        { dirty: true },
      )
      setSecret('')
      setCurrent('')
      onRecovered(result.usedRecovery)
      adopt(result.keyring, result.previousUnlockAt)
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }
  const switchMode = (next: 'previous' | 'recovery') => {
    setMode(next)
    setSecret('')
    setError(null)
  }
  return (
    <Panel className="mx-auto max-w-2xl">
      <form className="space-y-4" onSubmit={(event) => void submit(event)} data-testid="safes-stale">
        <div className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-clay/15 text-clay-ink" aria-hidden="true">
            <ShieldAlert size={18} />
          </span>
          <h2 className="min-w-0 break-words font-display text-2xl">{t('safes.staleTitle')}</h2>
        </div>
        <p className="text-sm">{t('safes.staleBody')}</p>
        {!hasRecovery ? <Warning testId="stale-no-recovery">{t('safes.staleNoRecovery')}</Warning> : null}
        {mode === 'previous' ? (
          <PasswordInput label={t('safes.previousPassword')} value={secret} onChange={setSecret} testId="stale-previous" autoComplete="off" autoFocus />
        ) : (
          <Field label={t('safes.recoveryCode')}>
            <input
              {...secureInputProps}
              required
              data-testid="stale-recovery-code"
              className={`${controlClass} font-mono uppercase`}
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
          </Field>
        )}
        <PasswordInput label={t('safes.currentPassword')} value={current} onChange={setCurrent} testId="stale-current" />
        <ErrorNotice error={error} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          {hasRecovery ? (
            <button
              type="button"
              className="text-sm text-pine-ink underline-offset-2 hover:underline"
              data-testid="stale-switch"
              onClick={() => switchMode(mode === 'previous' ? 'recovery' : 'previous')}
            >
              {mode === 'previous' ? t('safes.useRecoveryCode') : t('safes.usePreviousPassword')}
            </button>
          ) : (
            <span />
          )}
          <Button type="submit" disabled={busy} data-testid="stale-submit">
            {busy ? t('safes.unlocking') : t('safes.unlock')}
          </Button>
        </div>
        <p className="text-xs text-muted">
          {t('safes.staleLost')}{' '}
          <Link to="/app/account" className="text-pine-ink hover:underline">
            {t('safes.goToAccount')}
          </Link>
        </p>
      </form>
    </Panel>
  )
}

export function SafesGate({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const { keyring } = useSafes()
  const status = useSafeStatus()
  const [pendingCode, setPendingCode] = useState<string | null>(null)
  const [recovered, setRecovered] = useState<'password' | 'code' | null>(null)
  if (!status) return null
  if (status.mustChangePassword) {
    return (
      <Panel className="mx-auto max-w-md space-y-4" >
        <p className="text-sm">{t('safes.mustChangeFirst')}</p>
        <Link to="/app/account" className="inline-flex rounded-xl bg-pine px-4 py-2.5 text-sm font-medium text-on-pine">
          {t('safes.goToAccount')}
        </Link>
      </Panel>
    )
  }
  if (pendingCode) return <RecoveryCodeDisplay code={pendingCode} onDone={() => setPendingCode(null)} />
  if (!status.initialized) return <Onboarding onCode={setPendingCode} />
  if (!keyring) {
    if (status.stale) return <StaleForm hasRecovery={status.hasRecovery} onRecovered={(withCode) => setRecovered(withCode ? 'code' : 'password')} />
    return <UnlockForm />
  }
  return (
    <>
      {recovered ? (
        <div className="mb-4">
          <Success>{recovered === 'code' ? t('safes.recoveredWithCode') : t('safes.recovered')}</Success>
        </div>
      ) : null}
      {children}
    </>
  )
}
