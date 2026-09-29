import { useMemo, useState, type FormEvent } from 'react'
import { Button, Field, Notice, controlClass } from './ui'
import { useI18n } from '../context/I18nContext'
import { useVault } from '../context/VaultContext'
import type { RoleName } from '../domain/types'
import { textForError } from '../lib/errors'
import { formatWhen } from '../lib/money'
import type { MessageKey } from '../i18n'
import { Permission, canUser } from '../rbac'
import { noteExport, parseBackup, vaultToBackup } from '../services/backup.service'
import { listAudit } from '../services/audit.service'
import { createGroup, deleteGroup, listGroups } from '../services/group.service'
import { createUser, deleteUser, listUsers, resetUserPassword } from '../services/user.service'

function roleLabel(role: string, t: (key: MessageKey) => string): string {
  if (role === 'Admin' || role === 'Manager' || role === 'Viewer') return t(`roles.${role}`)
  return role
}

function Forbidden() {
  const { t } = useI18n()
  return (
    <p data-testid="forbidden" className="text-clay">
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
            groupId: groupId ? Number(groupId) : null,
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
          <select data-testid="user-group" className={controlClass} value={groupId} onChange={(event) => setGroupId(event.target.value)}>
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
              <div>
                <p className="font-medium">{person.email}</p>
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
          <li key={group.id} className="flex items-center justify-between rounded-3xl border border-line bg-card px-4 py-4">
            <p className="font-medium">{group.name}</p>
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
  if (!allowed) return <Forbidden />
  return (
    <div className="grid gap-6">
      <h1 className="font-display text-4xl">{t('audit.title')}</h1>
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

export function BackupPage() {
  const { t } = useI18n()
  const { user, run, exportBackup, importBackup } = useVault()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState<ReturnType<typeof parseBackup> | null>(null)
  if (!user || !canUser(user, Permission.EXPORT_VAULT)) return <Forbidden />

  async function onExport() {
    setError(null)
    try {
      await run((vault) => noteExport(vault), { dirty: true })
      const record = await exportBackup()
      const blob = new Blob([JSON.stringify(vaultToBackup(record))], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = 'moliya-vault.moliya'
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (caught) {
      setError(textForError(caught, t))
    }
  }

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
      {notice ? <p className="text-sm text-pine">{notice}</p> : null}
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
        ) : null}
      </div>
    </div>
  )
}
