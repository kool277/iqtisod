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
import { AUDIT_PAGE_LIMIT, auditIntegrity, listAudit } from '../services/audit.service'
import { ExportPanel } from './ExportPanel'
import { createGroup, deleteGroup, listGroups } from '../services/group.service'
import type { AuditEntry, Group } from '../domain/types'
import { DataTable, type Column } from './table/DataTable'
import { optionsFrom } from './table/model'

type ArchiveRow = Omit<ArchiveEntry, 'raw'>

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
  const allowed = Boolean(user && canUser(user, Permission.MANAGE_GROUPS))
  const groups = useMemo(() => (allowed ? query((vault) => listGroups(vault)) : []), [allowed, query, revision])
  const groupColumns = useMemo<Column<Group>[]>(
    () => [
      {
        id: 'name',
        header: t('groups.name'),
        hideable: false,
        cell: (group) => <span className="break-words font-medium">{group.name}</span>,
        sort: { type: 'text', value: (group) => group.name },
        search: (group) => group.name,
        exportAs: { kind: 'text', value: (group) => group.name },
      },
    ],
    [t],
  )
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
      <div>
        <h1 className="font-display text-4xl">{t('groups.title')}</h1>
        <p className="mt-1 text-sm text-muted">{t('groups.intro')}</p>
      </div>
      {error ? <Notice>{error}</Notice> : null}
      <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => void onCreate(event)}>
        <Field label={t('groups.name')}>
          <input data-testid="group-name" className={controlClass} value={name} onChange={(event) => setName(event.target.value)} required />
        </Field>
        <Button type="submit" data-testid="group-save">
          {t('groups.create')}
        </Button>
      </form>
      <DataTable
        id="groups"
        label={t('groups.title')}
        rows={groups}
        columns={groupColumns}
        rowKey={(group) => String(group.id)}
        rowAttributes={() => ({ 'data-testid': 'group-row' })}
        exportTable="groups"
        empty={t('groups.empty')}
        rowActions={(group) => (
          <Button variant="danger" onClick={() => void onDelete(group.id)}>
            {t('groups.remove')}
          </Button>
        )}
      />
    </div>
  )
}

const auditLabel = (action: string, t: (key: MessageKey) => string) => {
  const key = `audit.actions.${action}` as MessageKey
  const securityKey = `securityAudit.${action}` as MessageKey
  const label = t(key) === key ? t(securityKey) : t(key)
  return label === securityKey ? action : label
}

export function AuditPage() {
  const { t, locale } = useI18n()
  const { user, query, revision } = useVault()
  const allowed = Boolean(user && canUser(user, Permission.READ_AUDIT))
  const rows = useMemo(() => (allowed ? query((vault) => listAudit(vault, AUDIT_PAGE_LIMIT)) : []), [allowed, query, revision])
  const chain = useMemo(() => (allowed ? query((vault) => auditIntegrity(vault)) : null), [allowed, query, revision])
  const columns = useMemo<Column<AuditEntry>[]>(() => {
    const collator = new Intl.Collator(locale)
    const label = (row: AuditEntry) => auditLabel(row.action, t)
    const actor = (row: AuditEntry) => row.actorEmail ?? '—'
    const actions = optionsFrom(rows, (row) => row.action, (action) => auditLabel(action, t), collator)
    const actors = optionsFrom(rows, actor, (value) => value, collator)
    const entities = optionsFrom(rows, (row) => row.entityType ?? '—', (value) => value, collator)
    return [
      {
        id: 'when',
        header: t('audit.when'),
        hideable: false,
        cell: (row) => <span className="whitespace-nowrap tabular-nums">{formatWhen(row.createdAt, locale)}</span>,
        sort: { type: 'date', value: (row) => row.createdAt },
        search: (row) => formatWhen(row.createdAt, locale),
        filter: { kind: 'date', value: (row) => row.createdAt },
        exportAs: { kind: 'when', value: (row) => row.createdAt },
      },
      {
        id: 'actor',
        header: t('audit.actor'),
        cell: (row) => <span className="break-all">{actor(row)}</span>,
        sort: { type: 'text', value: (row) => row.actorEmail },
        search: (row) => row.actorEmail,
        filter: { kind: 'select', value: actor, options: actors },
        exportAs: { kind: 'text', value: (row) => row.actorEmail },
      },
      {
        id: 'action',
        header: t('audit.action'),
        cell: label,
        sort: { type: 'text', value: label },
        search: (row) => `${label(row)} ${row.action}`,
        filter: { kind: 'select', value: (row) => row.action, options: actions },
        exportAs: { kind: 'text', value: label },
      },
      {
        id: 'entity',
        header: t('table.col.entity'),
        hidden: true,
        cell: (row) => row.entityType ?? '—',
        sort: { type: 'text', value: (row) => row.entityType },
        search: (row) => row.entityType,
        filter: { kind: 'select', value: (row) => row.entityType ?? '—', options: entities },
        exportAs: { kind: 'text', value: (row) => row.entityType },
      },
      {
        id: 'entityId',
        header: t('table.col.entityId'),
        hidden: true,
        cell: (row) => <span className="break-all font-mono text-xs">{row.entityId ?? '—'}</span>,
        sort: { type: 'text', value: (row) => row.entityId },
        search: (row) => row.entityId,
        exportAs: { kind: 'text', value: (row) => row.entityId },
      },
      {
        id: 'details',
        header: t('table.col.details'),
        hidden: true,
        cell: (row) => <span className="line-clamp-3 break-all font-mono text-xs">{row.details ?? '—'}</span>,
        search: (row) => row.details,
        filter: { kind: 'text', value: (row) => row.details },
        exportAs: { kind: 'text', value: (row) => row.details },
      },
    ]
  }, [locale, rows, t])
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
      <DataTable
        id="audit"
        label={t('audit.title')}
        rows={rows}
        columns={columns}
        rowKey={(row) => row.id}
        exportTable="audit"
        defaultPageSize={100}
        empty={t('audit.empty')}
      />
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
  const [archives, setArchives] = useState<ArchiveRow[]>([])
  const allowed = Boolean(user && canUser(user, Permission.EXPORT_VAULT))
  const archiveColumns = useMemo<Column<ArchiveRow>[]>(() => {
    const reason = (entry: ArchiveRow) => (entry.reason === 'upgrade' ? t('backup.archiveUpgrade') : t('backup.archiveImport'))
    return [
      {
        id: 'reason',
        header: t('table.col.reason'),
        cell: (entry) => <span className="font-medium">{reason(entry)}</span>,
        sort: { type: 'text', value: reason },
        search: reason,
        filter: {
          kind: 'select',
          value: (entry) => (entry.reason === 'upgrade' ? 'upgrade' : 'import'),
          options: [
            { value: 'upgrade', label: t('backup.archiveUpgrade') },
            { value: 'import', label: t('backup.archiveImport') },
          ],
        },
        exportAs: { kind: 'text', value: reason },
      },
      {
        id: 'archived',
        header: t('table.col.archived'),
        hideable: false,
        cell: (entry) => <span className="whitespace-nowrap tabular-nums">{formatWhen(entry.archivedAt, locale)}</span>,
        sort: { type: 'date', value: (entry) => entry.archivedAt },
        search: (entry) => formatWhen(entry.archivedAt, locale),
        filter: { kind: 'date', value: (entry) => entry.archivedAt },
        exportAs: { kind: 'when', value: (entry) => entry.archivedAt },
      },
      {
        id: 'version',
        header: t('table.col.version'),
        cell: (entry) => <span className="text-muted">{t('backup.savedBy')} {entry.sourceAppVersion}</span>,
        sort: { type: 'text', value: (entry) => entry.sourceAppVersion },
        search: (entry) => entry.sourceAppVersion,
        exportAs: { kind: 'text', value: (entry) => entry.sourceAppVersion },
      },
    ]
  }, [locale, t])

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
        <div className="mt-4">
          <DataTable
            id="archives"
            label={t('backup.archives')}
            rows={archives}
            columns={archiveColumns}
            rowKey={(entry) => entry.key}
            rowAttributes={() => ({ 'data-testid': 'archive-row' })}
            exportTable="archives"
            defaultSort={[{ id: 'archived', desc: true }]}
            empty={t('backup.archivesEmpty')}
            rowActions={(entry) => (
              <Button variant="quiet" onClick={() => void onArchive(entry.key)}>
                {t('backup.archiveDownload')}
              </Button>
            )}
          />
        </div>
      </div>
    </div>
  )
}
