import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from './ui'
import { useI18n } from '../context/I18nContext'
import { useVault } from '../context/VaultContext'
import { downloadFile } from '../lib/download'
import { textForError } from '../lib/errors'
import { currentHostname, moveNoticeKind, type MoveNoticeKind } from '../lib/origin-move'
import { Permission, canUser } from '../rbac'
import { backupFileName, backupFileText, noteExport } from '../services/backup.service'

const detail: Partial<Record<MoveNoticeKind, 'move.signIn' | 'move.askAdmin'>> = {
  signIn: 'move.signIn',
  askAdmin: 'move.askAdmin',
}

/** Shown only on the old address: its vaults do not follow the app to jaybi.uz. Hiding lasts until the page reloads or the situation changes. */
export function MoveNotice() {
  const { t } = useI18n()
  const { status, user, run, exportBackup } = useVault()
  const [hidden, setHidden] = useState<MoveNoticeKind | null>(null)
  const [pending, setPending] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const kind = moveNoticeKind(currentHostname(), status, Boolean(user && canUser(user, Permission.EXPORT_VAULT)))
  if (!kind || hidden === kind) return null
  const extra = detail[kind]

  async function download() {
    setPending(true)
    setError(null)
    try {
      await run((vault) => noteExport(vault), { dirty: true })
      const record = await exportBackup()
      downloadFile(backupFileText(record), backupFileName('backup'), 'application/json')
      setDone(true)
    } catch (caught) {
      setError(textForError(caught, t))
    } finally {
      setPending(false)
    }
  }

  return (
    <div role="status" data-testid="move-notice" data-kind={kind} className="border-b border-brass/50 bg-brass-soft px-4 py-3 text-sm md:px-8">
      <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 max-w-3xl">
          <p className="font-medium">{t(kind === 'setup' ? 'move.setup' : 'move.body')}</p>
          {extra ? <p className="mt-1">{t(extra)}</p> : null}
          {done ? (
            <p data-testid="move-done" className="mt-1 font-medium text-pine-ink">
              {t('move.downloaded')}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="mt-1 text-clay-ink">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {kind === 'backup' ? (
            <>
              <Button data-testid="move-download" className="py-1.5" disabled={pending} onClick={() => void download()}>
                {t('move.download')}
              </Button>
              <Link to="/app/backup" data-testid="move-backup-link" className="rounded-xl border border-line bg-card px-3 py-1.5 font-medium hover:border-brass">
                {t('move.backupPage')}
              </Link>
            </>
          ) : null}
          <button type="button" data-testid="move-dismiss" className="rounded-xl px-3 py-1.5 hover:text-ink" onClick={() => setHidden(kind)}>
            {t('move.dismiss')}
          </button>
        </div>
      </div>
    </div>
  )
}
