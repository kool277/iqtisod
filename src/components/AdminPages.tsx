import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Button, Field, Notice, controlClass } from './ui'
import { useI18n } from '../context/I18nContext'
import { useVault } from '../context/VaultContext'
import type { RoleName } from '../domain/types'
import { textForError } from '../lib/errors'
import { formatWhen } from '../lib/money'
import type { MessageKey } from '../i18n'
import { Permission, canUser } from '../rbac'
import { listArchives, readArchive, type ArchiveEntry } from '../db/storage'
import { toIsoDate } from '../lib/dates'
import { downloadFile } from '../lib/download'
import { persistenceState, type PersistenceState } from '../lib/persistence'
import { archiveFileText, backupFileName, backupFileText, noteExport, parseBackup, type ParsedBackup } from '../services/backup.service'
import { auditIntegrity, listAudit } from '../services/audit.service'
import { exportPlainDatabase, exportTransactionsCsv } from '../services/export.service'
import { createGroup, deleteGroup, listGroups } from '../services/group.service'
import { createUser, deleteUser, listUsers, resetUserPassword } from '../services/user.service'

function roleLabel(role: string, t: (key: MessageKey) => string): string {
  if (role === 'Admin' || role === 'Manager' || role === 'Viewer') return t(`roles.${role}`)
  return role
}

function Forbidden() {
  const { t } = useI18n()
  return (
    <p data-testid="forbidden" className="text-clay-ink">
      {t('errors.forbidden')}
    </p>
  )
}

export function UsersPage() {
  const { t } = useI18n()
  const { user, query, run, revision } = useVault()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<RoleName>('Viewer')
  const [groupId, setGroupId] = useState('')
  const [resetId, setResetId] = useState<string | null>(null)
  const [nextPassword, setNextPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const allowed = Boolean(user && canUser(user, Permission.MANAGE_USERS))
  const people = useMemo(() => (allowed ? query((vault) => listUsers(vault)) : []), [allowed, query, revision])
  const groups = useMemo(() => (allowed ? query((vault) => listGroups(vault)) : []), [allowed, query, revision])
  const selectedGroup = groupId || (role === 'Admin' ? '' : String(groups[0]?.id ?? ''))
  if (!allowed) return <Forbidden />

  async function onCreate(event: FormEvent) {
    event.preventDefault()
    setError(null)
    try {
      await run(
        (vault) =>
          createUser(vault, {
            email,
            password,
            roleName: role,
            groupId: selectedGroup ? Number(selectedGroup) : null,
          }),
        { dirty: true },
      )
      setEmail('')
      setPassword('')
    } catch (caught) {
      setError(textForError(caught, t))
    }
  }

  async function onReset(event: FormEvent) {
    event.preventDefault()
    if (!resetId) return
    setError(null)
    try {
      await run((vault) => resetUserPassword(vault, resetId, nextPassword), { dirty: true })
      setResetId(null)
      setNextPassword('')
    } catch (caught) {
      setError(textForError(caught, t))
    }
  }

  async function onDelete(id: string) {
    setError(null)
    try {
      await run((vault) => deleteUser(vault, id), { dirty: true })
      setPendingDelete(null)
    } catch (caught) {
      setError(textForError(caught, t))
    }
  }

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="font-display text-4xl">{t('users.title')}</h1>
        <p className="mt-1 text-sm text-muted">{t('users.intro')}</p>
      </div>
      {error ? <Notice>{error}</Notice> : null}
      <form className="grid gap-4 rounded-3xl border border-line bg-card p-5 md:grid-cols-2" onSubmit={(event) => void onCreate(event)}>
        <Field label={t('common.email')}>
          <input data-testid="user-email" type="email" className={controlClass} value={email} onChange={(event) => setEmail(event.target.value)} required />
        </Field>
        <Field label={t('common.password')}>
          <input data-testid="user-password" type="password" autoComplete="new-password" className={controlClass} value={password} onChange={(event) => setPassword(event.target.value)} required />
        </Field>
        <Field label={t('common.role')}>
          <select data-testid="user-role" className={controlClass} value={role} onChange={(event) => setRole(event.target.value as RoleName)}>
            <option value="Manager">{t('roles.Manager')}</option>
            <option value="Viewer">{t('roles.Viewer')}</option>
            <option value="Admin">{t('roles.Admin')}</option>
          </select>
        </Field>
        <Field label={t('common.group')}>
          <select data-testid="user-group" className={controlClass} value={selectedGroup} onChange={(event) => setGroupId(event.target.value)}>
            {role === 'Admin' ? <option value="">—</option> : null}
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="md:col-span-2">
          <Button type="submit" data-testid="user-save">
            {t('users.create')}
          </Button>
        </div>
      </form>
      <ul className="grid gap-3">
        {people.map((person) => (
          <li key={person.id} className="rounded-3xl border border-line bg-card px-4 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="break-all font-medium">{person.email}</p>
                <p className="text-sm text-muted">
                  {roleLabel(person.roleName, t)}
                  {person.groupName ? ` · ${person.groupName}` : ''}
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="quiet" onClick={() => setResetId(person.id)}>
                  {t('users.resetPassword')}
                </Button>
                <Button variant="danger" onClick={() => setPendingDelete(person.id)}>
                  {t('users.remove')}
                </Button>
              </div>
            </div>
            {resetId === person.id ? (
              <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(event) => void onReset(event)}>
                <Field label={t('users.newPassword')}>
                  <input type="password" className={controlClass} value={nextPassword} onChange={(event) => setNextPassword(event.target.value)} required />
                </Field>
                <Button type="submit">{t('common.save')}</Button>
              </form>
            ) : null}
            {pendingDelete === person.id ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <p className="text-sm">{t('users.removeConfirm')}</p>
                <Button variant="danger" onClick={() => void onDelete(person.id)}>
                  {t('users.remove')}
                </Button>
                <Button variant="quiet" onClick={() => setPendingDelete(null)}>
                  {t('common.cancel')}
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function GroupsPage() {
  const { t } = useI18n()
  const { user, query, run, revision } = useVault()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const allowed = Boolean(user && canUser(user, Permission.MANAGE_GROUPS))
  const groups = useMemo(() => (allowed ? query((vault) => listGroups(vault)) : []), [allowed, query, revision])
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
      {groups.length === 0 ? <p className="text-muted">{t('groups.empty')}</p> : null}
      <ul className="grid gap-3">
        {groups.map((group) => (
          <li key={group.id} className="flex flex-wrap items-center justify-between gap-3 rounded-3xl border border-line bg-card px-4 py-4">
            <p className="min-w-0 break-words font-medium">{group.name}</p>
            <Button variant="danger" onClick={() => void onDelete(group.id)}>
              {t('groups.remove')}
            </Button>
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
              const label = t(key)
              return (
                <tr key={row.id} className="border-t border-line">
                  <td className="px-4 py-3">{formatWhen(row.createdAt, locale)}</td>
                  <td className="px-4 py-3">{row.actorEmail ?? '—'}</td>
                  <td className="px-4 py-3">{label === key ? row.action : label}</td>
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
  const { user, run, exportBackup, importBackup, lastBackupAt } = useVault()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState<ParsedBackup | null>(null)
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

  const onCsv = () =>
    guarded(async () => {
      const text = await run((vault) => exportTransactionsCsv(vault), { dirty: true })
      downloadFile(text, `moliya-records-${toIsoDate(new Date())}.csv`, 'text/csv;charset=utf-8')
    })

  const onSqlite = () =>
    guarded(async () => {
      const bytes = await run((vault) => exportPlainDatabase(vault), { dirty: true })
      downloadFile(bytes, `moliya-database-${toIsoDate(new Date())}.sqlite`, 'application/vnd.sqlite3')
    })

  async function onFile(file: File | undefined) {
    setPending(null)
    setError(null)
    if (!file) return
    if (file.size > 20 * 1024 * 1024) {
      setError(t('backup.invalid'))
      return
    }
    try {
      setPending(parseBackup(await file.text()))
    } catch (caught) {
      setError(textForError(caught, t))
    }
  }

  return (
    <div className="grid max-w-2xl gap-6">
      <div>
        <h1 className="font-display text-4xl">{t('backup.title')}</h1>
        <p className="mt-2 text-sm text-muted">{t('backup.exportHelp')}</p>
      </div>
      {error ? <Notice>{error}</Notice> : null}
      {notice ? <p className="text-sm text-pine-ink">{notice}</p> : null}
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
      <div className="rounded-3xl border border-line bg-card p-5">
        <h2 className="font-display text-2xl">{t('backup.import')}</h2>
        <p className="mt-2 text-sm text-muted">{t('backup.importWarn')}</p>
        <input
          data-testid="import-file"
          className="mt-4 block w-full text-sm"
          type="file"
          accept=".moliya,application/json"
          onChange={(event) => void onFile(event.target.files?.[0])}
        />
        {pending ? (
          <>
            <p data-testid="import-summary" className="mt-4 text-sm text-muted">
              {t('backup.fileVersion')} {pending.appVersion}
              {pending.exportedAt ? ` · ${t('backup.exportedAt')} ${formatWhen(pending.exportedAt, locale)}` : ''}
            </p>
            <Button
              className="mt-4"
              variant="danger"
              data-testid="confirm-import"
              onClick={() => {
                void importBackup(pending)
                  .then(() => setNotice(t('backup.imported')))
                  .catch((caught) => setError(textForError(caught, t)))
              }}
            >
              {t('backup.confirmImport')}
            </Button>
          </>
        ) : null}
      </div>
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
      <div className="rounded-3xl border border-clay/50 bg-card p-5">
        <h2 className="font-display text-2xl">{t('backup.plainTitle')}</h2>
        <p className="mt-2 text-sm text-clay-ink">{t('backup.plainWarn')}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="quiet" data-testid="export-csv" onClick={() => void onCsv()}>
            {t('backup.exportCsv')}
          </Button>
          <Button variant="quiet" data-testid="export-sqlite" onClick={() => void onSqlite()}>
            {t('backup.exportSqlite')}
          </Button>
        </div>
      </div>
    </div>
  )
}
