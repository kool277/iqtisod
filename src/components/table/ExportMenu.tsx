import { Download } from 'lucide-react'
import { useState } from 'react'
import { useI18n } from '../../context/I18nContext'
import { useVault } from '../../context/VaultContext'
import { loadExportMessages } from '../../i18n'
import { downloadFile } from '../../lib/download'
import { textForError } from '../../lib/errors'
import type { ViewCell, ViewColumn } from '../../services/export/view-cells'
import type { ViewTable } from '../../services/export/view-tables'
import { Popover } from './Popover'

const FORMATS = ['csv', 'xlsx', 'pdf', 'json'] as const
type Format = (typeof FORMATS)[number]

export type ViewSnapshot = {
  columns: ViewColumn[]
  rows: ViewCell[][]
  total: number
  filtered: boolean
  scope?: { from: string | null; to: string | null; groupId: number | null }
}

export function ExportMenu({ tableId, table, title, snapshot }: { tableId: string; table: ViewTable; title: string; snapshot: () => ViewSnapshot }) {
  const { t, locale } = useI18n()
  const { run } = useVault()
  const [format, setFormat] = useState<Format>('csv')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)

  async function start() {
    setStatus(null)
    setBusy(true)
    try {
      const view = snapshot()
      const [{ exportView }] = await Promise.all([import('../../services/export/view'), loadExportMessages(locale)])
      const result = await run(
        (vault) => exportView(vault, { table, title, format, ...view, plainConfirmed: confirmed, locale }),
        { dirty: true },
      )
      downloadFile(result.blob, result.fileName, result.mime)
      setStatus({ ok: true, text: t('table.exportDone') })
    } catch (caught) {
      setStatus({ ok: false, text: textForError(caught, t) })
      // The audit entry may already be written even though the file failed; keep it.
      await run(() => undefined, { dirty: true }).catch(() => undefined)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover
      label={t('table.exportTitle')}
      testId={`${tableId}-export`}
      wide
      button={
        <>
          <Download size={15} aria-hidden="true" />
          <span className="hidden sm:inline">{t('table.export')}</span>
        </>
      }
    >
      {() => (
        <div className="grid gap-3">
          <p className="text-xs text-muted">{t('table.exportHelp')}</p>
          <fieldset className="grid grid-cols-2 gap-1.5" disabled={busy}>
            <legend className="sr-only">{t('table.exportFormat')}</legend>
            {FORMATS.map((item) => (
              <label key={item} className={`flex cursor-pointer items-center gap-2 rounded-xl border px-2.5 py-1.5 ${format === item ? 'border-pine-ink bg-pine/5' : 'border-line'}`}>
                <input type="radio" name={`${tableId}-export-format`} className="accent-[var(--app-pine)]" checked={format === item} data-testid={`${tableId}-export-${item}`} onChange={() => setFormat(item)} />
                {t(`table.formats.${item}`)}
              </label>
            ))}
          </fieldset>
          <label className="flex items-start gap-2 rounded-xl border border-clay/50 p-2.5 text-clay-ink">
            <input type="checkbox" className="mt-0.5" checked={confirmed} disabled={busy} data-testid={`${tableId}-export-confirm`} onChange={(event) => setConfirmed(event.target.checked)} />
            <span>{t('table.exportPlain')}</span>
          </label>
          <button
            type="button"
            data-testid={`${tableId}-export-start`}
            disabled={busy || !confirmed}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-xl bg-pine px-3 text-sm font-medium text-on-pine hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => void start()}
          >
            <Download size={15} aria-hidden="true" />
            {busy ? t('table.exportWorking') : t('table.exportStart')}
          </button>
          <p role="status" aria-live="polite" data-testid={`${tableId}-export-status`} className={`min-h-5 text-xs ${status?.ok === false ? 'text-clay-ink' : 'text-pine-ink'}`}>
            {status?.text ?? ''}
          </p>
        </div>
      )}
    </Popover>
  )
}
