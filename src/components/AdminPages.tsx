import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Button, Field, Notice, controlClass } from './ui'
import { useI18n } from '../context/I18nContext'
import { useVault } from '../context/VaultContext'
import { textForError } from '../lib/errors'
import { formatWhen } from '../lib/money'
import type { MessageKey } from '../i18n'
import { Permission, canUser } from '../rbac'
import { listArchives, readArchive, type ArchiveEntry } from '../db/storage'
import { downloadFile } from '../lib/download'
import { persistenceState, type PersistenceState } from '../lib/persistence'
import { ReplaceVaultPanel } from './admin/ReplaceVaultPanel'
import { archiveFileText, backupFileName, backupFileText, noteExport } from '../services/backup.service'
import { auditIntegrity, listAudit } from '../services/audit.service'
import { ExportPanel } from './ExportPanel'
import { createGroup, deleteGroup, listGroups } from '../services/group.service'
import { PeriodPicker } from './PeriodPicker'
import { GroupRowSummary, GroupSummaryTotals } from './groups/GroupSummary'
import { useGroupSummaries } from './groups/useGroupSummaries'

function Forbidden() {
  const { t } = useI18n()
  return (
    <p data-testid="forbidden" className="text-clay-ink">
      {t('errors.forbidden')}
    </p>
  )
}

export function GroupsPage() {
  const { t } = useI18n()
  const { user, query, run, revision } = useVault()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const canManage = Boolean(user && canUser(user, Permission.MANAGE_GROUPS))
  const allowed = canManage || Boolean(user && canUser(user, Permission.READ_DASHBOARD))
  const groups = useMemo(() => (allowed ? query((vault) => listGroups(vault)) : []), [allowed, query, revision])
  const summaries = useGroupSummaries()
  if (!allowed) return <Forbidden />

  async function onCreate(event: FormEvent) {
    event.preventDefault()
    setError(null)
    try {
      await run((vault) => createGroup(vault, name), { dirty: true })
      setName('')
    } catch (caught) {
      setError(textForError(caught, t))
    }
  }

  async function onDelete(id: number) {
    setError(null)
    try {
      await run((vault) => deleteGroup(vault, id), { dirty: true })
    } catch (caught) {
      setError(textForError(caught, t))
    }
  }

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-4xl">{t('groups.title')}</h1>
          <p className="mt-1 text-sm text-muted">{t('groups.intro')}</p>
        </div>
        <PeriodPicker />
      </div>
      {error ? <Notice>{error}</Notice> : null}
      {canManage ? (
        <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => void onCreate(event)}>
          <Field label={t('groups.name')}>
            <input data-testid="group-name" className={controlClass} value={name} onChange={(event) => setName(event.target.value)} required />
          </Field>
          <Button type="submit" data-testid="group-save">
            {t('groups.create')}
          </Button>
        </form>
      ) : null}
      {summaries && groups.length > 1 ? <GroupSummaryTotals totals={summaries.total} /> : null}
      {groups.length === 0 ? <p className="text-muted">{t('groups.empty')}</p> : null}
      <ul className="grid gap-3">
        {groups.map((group) => (
          <li key={group.id} data-testid="group-row" data-group={group.name} className="grid gap-3 rounded-3xl border border-line bg-card px-4 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="min-w-0 break-words font-medium">{group.name}</p>
              {canManage ? (
                <Button variant="danger" onClick={() => void onDelete(group.id)}>
                  {t('groups.remove')}
                </Button>
              ) : null}
            </div>
            <div className="border-t border-line pt-3">
              <GroupRowSummary report={summaries} groupId={group.id} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function AuditPage() {
  const { t, locale } = useI18n()
  const { user, query, revision } = useVault()
  const allowed = Boolean(user && canUser(user, Permission.READ_AUDIT))
  const rows = useMemo(() => (allowed ? query((vault) => listAudit(vault)) : []), [allowed, query, revision])
  const chain = useMemo(() => (allowed ? query((vault) => auditIntegrity(vault)) : null), [allowed, query, revision])
  if (!allowed) return <Forbidden />
  return (
    <div className="grid gap-6">
      <h1 className="font-display text-4xl">{t('audit.title')}</h1>
      {chain ? (
        <p
          data-testid="audit-integrity"
          data-ok={String(chain.ok)}
          className={`rounded-2xl border px-4 py-3 text-sm ${chain.ok ? 'border-pine/40 text-pine-ink' : 'border-clay text-clay-ink'}`}
        >
          <span className="font-medium">{t('audit.integrity')}:</span> {chain.ok ? t('audit.intact') : t('audit.broken')} · {t('audit.entries')}:{' '}
          {chain.entries}
        </p>
      ) : null}
      {rows.length === 0 ? <p className="text-muted">{t('audit.empty')}</p> : null}
      <div className="overflow-x-auto rounded-3xl border border-line bg-card">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">{t('audit.when')}</th>
              <th className="px-4 py-3 font-medium">{t('audit.actor')}</th>
              <th className="px-4 py-3 font-medium">{t('audit.action')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const key = `audit.actions.${row.action}` as MessageKey
              const securityKey = `securityAudit.${row.action}` as MessageKey
              const label = t(key) === key ? t(securityKey) : t(key)
              return (
                <tr key={row.id} className="border-t border-line">
                  <td className="px-4 py-3">{formatWhen(row.createdAt, locale)}</td>
                  <td className="px-4 py-3">{row.actorEmail ?? '—'}</td>
                  <td className="px-4 py-3">{label === securityKey ? row.action : label}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const storageText: Record<PersistenceState, MessageKey> = {
  persistent: 'backup.storagePersistent',
  'best-effort': 'backup.storageBestEffort',
  unsupported: 'backup.storageUnsupported',
}

export function BackupPage() {
  const { t, locale } = useI18n()
  const { user, run, exportBackup, lastBackupAt } = useVault()
  const [error, setError] = useState<string | null>(null)
  const [storage, setStorage] = useState<PersistenceState | null>(null)
  const [archives, setArchives] = useState<Omit<ArchiveEntry, 'raw'>[]>([])
  const allowed = Boolean(user && canUser(user, Permission.EXPORT_VAULT))

  useEffect(() => {
    if (!allowed) return
    let cancelled = false
    void persistenceState().then((state) => {
      if (!cancelled) setStorage(state)
    })
    void listArchives()
      .then((entries) => {
        if (!cancelled) setArchives(entries)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [allowed])

  if (!allowed) return <Forbidden />

  async function guarded(action: () => Promise<void>) {
    setError(null)
    try {
      await action()
    } catch (caught) {
      setError(textForError(caught, t))
    }
  }

  const onExport = () =>
    guarded(async () => {
      await run((vault) => noteExport(vault), { dirty: true })
      const record = await exportBackup()
      downloadFile(backupFileText(record), backupFileName('backup'), 'application/json')
    })

  const onArchive = (key: string) =>
    guarded(async () => {
      const entry = await readArchive(key)
      if (!entry) throw new Error('MISSING')
      downloadFile(archiveFileText(entry), backupFileName('archive', new Date(entry.archivedAt)), 'application/json')
    })

  return (
    <div className="grid max-w-2xl gap-6">
      <div>
        <h1 className="font-display text-4xl">{t('backup.title')}</h1>
        <p className="mt-2 text-sm text-muted">{t('backup.exportHelp')}</p>
      </div>
      {error ? <Notice>{error}</Notice> : null}
      <dl className="grid gap-3 rounded-3xl border border-line bg-card p-5 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted">{t('backup.lastBackup')}</dt>
        <dd data-testid="last-backup">{lastBackupAt ? formatWhen(lastBackupAt, locale) : t('backup.never')}</dd>
        <dt className="text-muted">{t('backup.storage')}</dt>
        <dd data-testid="storage-state" data-state={storage ?? ''}>
          {storage ? t(storageText[storage]) : '…'}
        </dd>
      </dl>
      <Button data-testid="export-backup" onClick={() => void onExport()}>
        {t('backup.export')}
      </Button>
      <ReplaceVaultPanel />
      <ExportPanel />
      <div className="rounded-3xl border border-line bg-card p-5">
        <h2 className="font-display text-2xl">{t('backup.archives')}</h2>
        <p className="mt-2 text-sm text-muted">{t('backup.archivesIntro')}</p>
        {archives.length === 0 ? <p className="mt-4 text-sm text-muted">{t('backup.archivesEmpty')}</p> : null}
        <ul className="mt-4 grid gap-2">
          {archives.map((entry) => (
            <li key={entry.key} data-testid="archive-row" className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3 text-sm">
              <span className="min-w-0">
                <span className="font-medium">{entry.reason === 'upgrade' ? t('backup.archiveUpgrade') : t('backup.archiveImport')}</span>
                <span className="text-muted">
                  {' '}
                  · {formatWhen(entry.archivedAt, locale)} · {t('backup.savedBy')} {entry.sourceAppVersion}
                </span>
              </span>
              <Button variant="quiet" onClick={() => void onArchive(entry.key)}>
                {t('backup.archiveDownload')}
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
