import { KeyRound, ShieldAlert } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '../context/I18nContext'
import { useSafes } from '../context/SafeContext'
import { useVault } from '../context/VaultContext'
import { ValidationError } from '../domain/errors'
import { AUTO_LOCK_MINUTES, CLIPBOARD_SECONDS, REVEAL_SECONDS, type SafePrefs } from '../domain/safes'
import { changeOwnPassword } from '../services/account.service'
import { createRecoveryCode, resetSafes, updateSafePrefs } from '../services/safe.service'
import { RecoveryChoice, RecoveryCodeDisplay, useSafeStatus } from './safes/SafesGate'
import { ErrorNotice, PageHeader, PasswordInput, Success, Warning, secureInputProps } from './safes/shared'
import { Button, Field, Panel, controlClass } from './ui'

export function AccountPage() {
  const { t } = useI18n()
  const { user } = useVault()
  const status = useSafeStatus()
  const [code, setCode] = useState<string | null>(null)
  if (!user) return null
  return (
    <div data-testid="account-page" className="space-y-6">
      <PageHeader title={t('account.title')} intro={user.email} />
      {user.mustChangePassword ? <Warning testId="must-change-banner">{t('account.mustChange')}</Warning> : null}
      <ChangePassword />
      {code ? (
        <RecoveryCodeDisplay code={code} onDone={() => setCode(null)} />
      ) : status && status.initialized && !status.mustChangePassword ? (
        <>
          <SafePreferences />
          <RecoverySection hasRecovery={status.hasRecovery} onCode={setCode} />
          <ResetSafes onCode={setCode} />
        </>
      ) : null}
    </div>
  )
}

function ChangePassword() {
  const { t } = useI18n()
  const { run } = useVault()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    setDone(false)
    if (next !== confirm) {
      setError(new ValidationError('PASSWORD_MISMATCH'))
      return
    }
    setBusy(true)
    try {
      await run((vault) => changeOwnPassword(vault, current, next), { dirty: true })
      setCurrent('')
      setNext('')
      setConfirm('')
      setDone(true)
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Panel className="max-w-2xl">
      <form className="space-y-4" onSubmit={(event) => void submit(event)} data-testid="change-password">
        <h2 className="font-display text-2xl">{t('account.changePassword')}</h2>
        <PasswordInput label={t('account.currentPassword')} value={current} onChange={setCurrent} testId="account-current" />
        <div className="grid gap-4 sm:grid-cols-2">
          <PasswordInput label={t('account.newPassword')} value={next} onChange={setNext} testId="account-new" autoComplete="new-password" />
          <PasswordInput label={t('account.confirmPassword')} value={confirm} onChange={setConfirm} testId="account-confirm" autoComplete="new-password" />
        </div>
        <ErrorNotice error={error} />
        {done ? <Success>{t('account.changed')}</Success> : null}
        <div className="flex justify-end">
          <Button type="submit" disabled={busy} data-testid="account-save">
            {busy ? t('account.working') : t('account.save')}
          </Button>
        </div>
      </form>
    </Panel>
  )
}

function SafesLockedHint() {
  const { t } = useI18n()
  return (
    <p className="text-sm text-muted">
      {t('account.safesPrefsLocked')}{' '}
      <Link to="/app/safes" className="text-pine-ink hover:underline">
        {t('safes.unlock')}
      </Link>
    </p>
  )
}

function SafePreferences() {
  const { t } = useI18n()
  const { keyring, withKeyring } = useSafes()
  const [prefs, setPrefs] = useState<SafePrefs | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [done, setDone] = useState(false)
  const current: SafePrefs | null = keyring
    ? prefs ?? { autoLockMinutes: keyring.meta.autoLockMinutes, clipboardSeconds: keyring.meta.clipboardSeconds, revealSeconds: keyring.meta.revealSeconds }
    : null
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!current) return
    setError(null)
    setDone(false)
    try {
      await withKeyring((vault, ring) => updateSafePrefs(vault, ring, current), { dirty: true })
      setDone(true)
    } catch (caught) {
      setError(caught)
    }
  }
  return (
    <Panel className="max-w-2xl">
      <h2 className="mb-4 font-display text-2xl">{t('account.safesPrefs')}</h2>
      {!current ? (
        <SafesLockedHint />
      ) : (
        <form className="space-y-4" onSubmit={(event) => void submit(event)} data-testid="safe-prefs">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t('safes.autoLock')}>
              <select
                className={controlClass}
                value={current.autoLockMinutes}
                data-testid="pref-auto-lock"
                onChange={(event) => setPrefs({ ...current, autoLockMinutes: Number(event.target.value) as SafePrefs['autoLockMinutes'] })}
              >
                {AUTO_LOCK_MINUTES.map((value) => (
                  <option key={value} value={value}>
                    {value} {t('safes.minutes')}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('safes.clipboardClear')}>
              <select
                className={controlClass}
                value={current.clipboardSeconds}
                onChange={(event) => setPrefs({ ...current, clipboardSeconds: Number(event.target.value) as SafePrefs['clipboardSeconds'] })}
              >
                {CLIPBOARD_SECONDS.map((value) => (
                  <option key={value} value={value}>
                    {value} {t('safes.seconds')}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('safes.revealHide')}>
              <select
                className={controlClass}
                value={current.revealSeconds}
                onChange={(event) => setPrefs({ ...current, revealSeconds: Number(event.target.value) as SafePrefs['revealSeconds'] })}
              >
                {REVEAL_SECONDS.map((value) => (
                  <option key={value} value={value}>
                    {value} {t('safes.seconds')}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <ErrorNotice error={error} />
          {done ? <Success>{t('safes.saved')}</Success> : null}
          <div className="flex justify-end">
            <Button type="submit" data-testid="pref-save">
              {t('safes.savePrefs')}
            </Button>
          </div>
        </form>
      )}
    </Panel>
  )
}

function RecoverySection({ hasRecovery, onCode }: { hasRecovery: boolean; onCode: (code: string) => void }) {
  const { t } = useI18n()
  const { keyring, withKeyring } = useSafes()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<unknown>(null)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    try {
      const code = await withKeyring((vault, ring) => createRecoveryCode(vault, ring, password), { dirty: true })
      setPassword('')
      onCode(code)
    } catch (caught) {
      setError(caught)
    }
  }
  return (
    <Panel className="max-w-2xl">
      <div className="mb-3 flex items-center gap-3">
        <span className={`grid size-9 shrink-0 place-items-center rounded-xl ${hasRecovery ? 'bg-pine/15 text-pine-ink' : 'bg-clay/15 text-clay-ink'}`} aria-hidden="true">
          <KeyRound size={16} />
        </span>
        <h2 className="font-display text-2xl">{t('account.recovery')}</h2>
      </div>
      <p className={`mb-4 text-sm ${hasRecovery ? 'text-muted' : 'text-clay-ink'}`} data-testid="recovery-status" data-state={hasRecovery ? 'set' : 'none'}>
        {hasRecovery ? t('account.recoveryHas') : t('account.recoveryNone')}
      </p>
      {!keyring ? (
        <SafesLockedHint />
      ) : (
        <form className="space-y-4" onSubmit={(event) => void submit(event)} data-testid="recovery-create">
          <PasswordInput label={t('login.password')} value={password} onChange={setPassword} testId="recovery-password" />
          <ErrorNotice error={error} />
          <div className="flex justify-end">
            <Button type="submit" variant={hasRecovery ? 'quiet' : 'primary'} data-testid="recovery-create-submit">
              {hasRecovery ? t('account.recoveryReplace') : t('account.recoveryCreate')}
            </Button>
          </div>
        </form>
      )}
    </Panel>
  )
}

function ResetSafes({ onCode }: { onCode: (code: string) => void }) {
  const { t } = useI18n()
  const { run } = useVault()
  const { adopt } = useSafes()
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [typed, setTyped] = useState('')
  const [recovery, setRecovery] = useState(true)
  const [acknowledged, setAcknowledged] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [done, setDone] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!recovery && !acknowledged) return
    setError(null)
    try {
      const result = await run((vault) => resetSafes(vault, password, typed, { recovery, defaultSafeName: t('safes.defaultSafeName') }), { dirty: true })
      setPassword('')
      setTyped('')
      setOpen(false)
      setDone(true)
      if (result.recoveryCode) onCode(result.recoveryCode)
      adopt(result.keyring, null)
    } catch (caught) {
      setError(caught)
    }
  }
  return (
    <Panel className="max-w-2xl border-clay/40">
      <div className="mb-3 flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-clay/15 text-clay-ink" aria-hidden="true">
          <ShieldAlert size={16} />
        </span>
        <h2 className="font-display text-2xl">{t('account.dangerZone')}</h2>
      </div>
      <p className="mb-4 text-sm text-muted">{t('safes.resetBody')}</p>
      {done ? <Success>{t('safes.resetDone')}</Success> : null}
      {!open ? (
        <Button variant="danger" onClick={() => setOpen(true)} data-testid="reset-safes-open">
          {t('safes.resetTitle')}
        </Button>
      ) : (
        <form className="space-y-4" onSubmit={(event) => void submit(event)} data-testid="reset-safes">
          <PasswordInput label={t('login.password')} value={password} onChange={setPassword} testId="reset-password" />
          <Field label={t('safes.resetConfirm')}>
            <input {...secureInputProps} required className={`${controlClass} max-w-48`} value={typed} onChange={(event) => setTyped(event.target.value)} data-testid="reset-typed" />
          </Field>
          <RecoveryChoice recovery={recovery} onRecovery={setRecovery} acknowledged={acknowledged} onAcknowledged={setAcknowledged} />
          <ErrorNotice error={error} />
          <div className="flex justify-end gap-2">
            <Button variant="quiet" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="danger" disabled={!recovery && !acknowledged} data-testid="reset-safes-submit">
              {t('safes.reset')}
            </Button>
          </div>
        </form>
      )}
    </Panel>
  )
}
