import { useState } from 'react'
import { Button } from '../ui'
import { useI18n } from '../../context/I18nContext'
import { readVaultCopy } from '../../db/storage'
import { ValidationError } from '../../domain/errors'
import { downloadFile } from '../../lib/download'
import { textForError } from '../../lib/errors'
import { BACKUP_MIME, backupFileName, storedFileBlob } from '../../services/backup.service'
import { KeysCatalog } from '../keys/KeysCatalog'

/**
 * The way out of a blocked sign-in (design 6.1): the vault does not open, but it can be kept as a file, as this browser
 * stores it and still encrypted, for an admin or the recovery tool. Nothing in it is read or trusted.
 */
export function BlockedEscape() {
  return (
    <KeysCatalog>
      <BlockedEscapeBody />
    </KeysCatalog>
  )
}

function BlockedEscapeBody() {
  const { t } = useI18n()
  const [pending, setPending] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function download() {
    setPending(true)
    setError(null)
    try {
      const copy = await readVaultCopy()
      if (!copy) throw new ValidationError('NO_VAULT')
      downloadFile(storedFileBlob(copy), backupFileName('backup'), BACKUP_MIME)
      setDone(true)
    } catch (caught) {
      setError(textForError(caught, t))
    } finally {
      setPending(false)
    }
  }

  return (
    <div data-testid="blocked-escape" className="grid gap-2 rounded-xl border border-line p-3 text-sm">
      <p>{t('keys.blocked.help')}</p>
      <div>
        <Button type="button" variant="quiet" data-testid="blocked-download" disabled={pending} onClick={() => void download()}>
          {t('keys.blocked.download')}
        </Button>
      </div>
      {done ? (
        <p role="status" data-testid="blocked-downloaded" className="font-medium text-pine-ink">
          {t('keys.blocked.downloaded')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-clay-ink">
          {error}
        </p>
      ) : null}
    </div>
  )
}
