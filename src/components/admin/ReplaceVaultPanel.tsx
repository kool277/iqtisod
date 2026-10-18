import { useState, type FormEvent } from 'react'
import { Button, Field, Notice, controlClass } from '../ui'
import { useI18n } from '../../context/I18nContext'
import { useVault } from '../../context/VaultContext'
import { AppError, OlderBackupError } from '../../domain/errors'
import { textForError } from '../../lib/errors'
import { LIMITS } from '../../lib/limits'
import { formatWhen } from '../../lib/money'
import { Permission, canUser } from '../../rbac'
import type { ParsedBackup } from '../../services/backup.service'
import { BackupTooLargeError, budgetText, tooLargeText, useBackupImport } from '../backup-import'
import { KeysCatalog } from '../keys/KeysCatalog'

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
  // A backup with per-person keys: the person's password in it, asked for when the current one does not open it.
  const [askBackupPassword, setAskBackupPassword] = useState(false)
  const [backupPassword, setBackupPassword] = useState('')
  // A backup older than this browser has seen, waiting for the admin to choose to restore it (design 4.10).
  const [older, setOlder] = useState<OlderBackupError['older'] | null>(null)
  const { capacity, readFile } = useBackupImport()
  if (!user || !canUser(user, Permission.IMPORT_VAULT)) return null

  async function onFile(input: HTMLInputElement) {
    setBackup(null)
    setError(null)
    setAskBackupPassword(false)
    setBackupPassword('')
    setOlder(null)
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

  async function replace(acceptOlder: boolean) {
    if (!backup) return
    setPending(true)
    setError(null)
    let again = false
    try {
      await replaceWithBackup(backup, { password, confirmName, backupPassword: askBackupPassword ? backupPassword : undefined, acceptOlder })
    } catch (caught) {
      setError(textForError(caught, t))
      // Both ask for one more step with the same passwords; anything else starts over.
      if (caught instanceof OlderBackupError) {
        setOlder(caught.older)
        again = true
      } else if (caught instanceof AppError && caught.code === 'BACKUP_KEYS_PASSWORD') {
        setAskBackupPassword(true)
        setOlder(null)
        again = true
      } else {
        setOlder(null)
      }
    } finally {
      if (!again) {
        setPassword('')
        setBackupPassword('')
      }
      setPending(false)
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    await replace(false)
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
        onChange={(event) => void onFile(event.currentTarget)}
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
          {askBackupPassword ? (
            <KeysCatalog>
              <BackupPasswordField value={backupPassword} onChange={setBackupPassword} />
            </KeysCatalog>
          ) : null}
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
          {older ? (
            <KeysCatalog>
              <OlderBackup older={older} pending={pending} onRestore={() => void replace(true)} onCancel={() => setOlder(null)} />
            </KeysCatalog>
          ) : (
            <div>
              <Button type="submit" variant="danger" data-testid="confirm-import" disabled={pending}>
                {pending ? t('security.replaceWorking') : t('security.replaceSubmit')}
              </Button>
            </div>
          )}
        </form>
      ) : null}
    </div>
  )
}

function BackupPasswordField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useI18n()
  return (
    <Field label={t('keys.restore.backupPassword')}>
      <input
        data-testid="replace-backup-password"
        type="password"
        autoComplete="current-password"
        className={controlClass}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required
      />
    </Field>
  )
}

/** An older backup than this browser has seen: who is taken out again, and the admin's choice to restore it anyway. */
function OlderBackup({ older, pending, onRestore, onCancel }: { older: OlderBackupError['older']; pending: boolean; onRestore: () => void; onCancel: () => void }) {
  const { t } = useI18n()
  const members = older.removals?.filter((removal) => !removal.invite) ?? []
  const invites = older.removals?.filter((removal) => removal.invite) ?? []
  const list = (testId: string, items: typeof members) => (
    <ul data-testid={testId} className="list-disc pl-5">
      {items.map((removal) => (
        <li key={removal.id} className="break-all">
          {removal.email}
        </li>
      ))}
    </ul>
  )
  return (
    <div data-testid="replace-older" className="grid gap-2 rounded-2xl border border-clay/50 bg-brass-soft px-3 py-3 text-sm">
      {older.legacy ? (
        <p data-testid="replace-older-legacy">{t('keys.restore.legacy')}</p>
      ) : older.removals === null ? (
        <p data-testid="replace-older-unknown">{t('keys.restore.unknown')}</p>
      ) : members.length + invites.length === 0 ? (
        <p>{t('keys.restore.noRemovals')}</p>
      ) : (
        <>
          {members.length > 0 ? (
            <>
              <p>{t('keys.restore.removals')}</p>
              {list('replace-older-removals', members)}
            </>
          ) : null}
          {invites.length > 0 ? (
            <>
              <p>{t('keys.restore.invites')}</p>
              {list('replace-older-invites', invites)}
            </>
          ) : null}
        </>
      )}
      <p className="text-xs text-muted">{t('keys.restore.audit')}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="danger" data-testid="replace-older-confirm" disabled={pending} onClick={onRestore}>
          {t('keys.restore.confirm')}
        </Button>
        <Button type="button" variant="quiet" disabled={pending} onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  )
}
