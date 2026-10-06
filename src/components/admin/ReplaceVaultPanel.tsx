import { useState, type FormEvent } from 'react'
import { Button, Field, Notice, controlClass } from '../ui'
import { useI18n } from '../../context/I18nContext'
import { useVault } from '../../context/VaultContext'
import { textForError } from '../../lib/errors'
import { LIMITS } from '../../lib/limits'
import { formatWhen } from '../../lib/money'
import { Permission, canUser } from '../../rbac'
import type { ParsedBackup } from '../../services/backup.service'
import { BackupTooLargeError, budgetText, tooLargeText, useBackupImport } from '../backup-import'

/** Replacing the whole vault needs the import permission, the admin's password and the vault name typed out. */
export function ReplaceVaultPanel() {
  const { t, locale } = useI18n()
  const { user, vaultName, replaceWithBackup } = useVault()
  const [backup, setBackup] = useState<ParsedBackup | null>(null)
  const [password, setPassword] = useState('')
  const [confirmName, setConfirmName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [reading, setReading] = useState(false)
  const { capacity, readFile } = useBackupImport()
  if (!user || !canUser(user, Permission.IMPORT_VAULT)) return null

  async function onFile(file: File | undefined) {
    setBackup(null)
    setError(null)
    if (!file) return
    setReading(true)
    try {
      setBackup(await readFile(file))
    } catch (caught) {
      setError(caught instanceof BackupTooLargeError ? tooLargeText(caught, t) : textForError(caught, t))
    } finally {
      setReading(false)
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!backup) return
    setPending(true)
    setError(null)
    try {
      await replaceWithBackup(backup, { password, confirmName })
    } catch (caught) {
      setError(textForError(caught, t))
    } finally {
      setPassword('')
      setPending(false)
    }
  }

  return (
    <div data-testid="replace-panel" className="rounded-3xl border border-clay/50 bg-card p-5">
      <h2 className="font-display text-2xl">{t('security.replaceTitle')}</h2>
      <p className="mt-2 text-sm text-clay-ink">{t('security.replaceWarn')}</p>
      <p data-testid="import-budget" className="mt-1 text-xs text-muted">
        {capacity ? budgetText(capacity, t) : t('security.importMeasuring')}
      </p>
      {error ? (
        <div className="mt-3">
          <Notice>{error}</Notice>
        </div>
      ) : null}
      <input
        data-testid="import-file"
        className="mt-4 block w-full text-sm"
        type="file"
        accept=".moliya,application/json"
        disabled={reading}
        onChange={(event) => void onFile(event.target.files?.[0])}
      />
      {reading ? <p data-testid="import-reading" className="mt-2 text-sm text-muted">{t('security.importReading')}</p> : null}
      {backup ? (
        <form className="mt-4 grid gap-3" onSubmit={(event) => void onSubmit(event)}>
          <p data-testid="import-summary" className="text-sm text-muted">
            {t('backup.fileVersion')} {backup.appVersion}
            {backup.exportedAt ? ` · ${t('backup.exportedAt')} ${formatWhen(backup.exportedAt, locale)}` : ''}
          </p>
          <Field label={t('security.replacePassword')}>
            <input
              data-testid="replace-password"
              type="password"
              autoComplete="current-password"
              className={controlClass}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </Field>
          <Field label={`${t('security.replaceName')}: ${vaultName}`}>
            <input
              data-testid="replace-name"
              className={controlClass}
              autoComplete="off"
              maxLength={LIMITS.nameChars}
              value={confirmName}
              onChange={(event) => setConfirmName(event.target.value)}
              required
            />
          </Field>
          <div>
            <Button type="submit" variant="danger" data-testid="confirm-import" disabled={pending}>
              {pending ? t('security.replaceWorking') : t('security.replaceSubmit')}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  )
}
