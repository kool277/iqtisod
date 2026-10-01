import { useCallback, useMemo, useState, type FormEvent } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { AddUserDialog } from './AddUserDialog'
import { IssuedCode } from './IssuedCode'
import { Forbidden, PeopleStrings, ROLES, StatusBadge, ValiditySelect, roleLabel } from './shared'
import { UsersOverview } from './UsersOverview'
import { Button, Field, Notice, controlClass } from '../ui'
import { useI18n } from '../../context/I18nContext'
import { useVault } from '../../context/VaultContext'
import type { RoleName, UserStatus, VaultUser } from '../../domain/types'
import { textForError } from '../../lib/errors'
import { LIMITS } from '../../lib/limits'
import { formatWhen } from '../../lib/money'
import { Permission, canUser, seesMembers } from '../../rbac'
import {
  DEFAULT_GRANT_VALIDITY,
  issueReset,
  listGrants,
  readClockFloor,
  resetClockFloor,
  revokeGrant,
  type GrantSummary,
  type GrantValidity,
  type IssuedGrant,
} from '../../services/grant.service'
import { DataTable, type Column, type Selection } from '../table/DataTable'
import { fill } from '../table/model'
import { listGroups } from '../../services/group.service'
import { clearUserTotp } from '../../services/totp.service'
import { bulkUpdateUsers, listUsers, resetUserPassword, usersOverview, type BulkChange } from '../../services/user.service'

const STATUSES: UserStatus[] = ['ACTIVE', 'SUSPENDED', 'FORMER']

export function UsersPage() {
  const { user } = useVault()
  if (!user || !seesMembers(user)) return <Forbidden />
  return (
    <PeopleStrings>
      <UsersView />
    </PeopleStrings>
  )
}

function UsersView() {
  const { t, locale } = useI18n()
  const { user, query, run, revision } = useVault()
  const [error, setError] = useState<string | null>(null)
  const location = useLocation()
  const [notice, setNotice] = useState<string | null>(() => ((location.state as { notice?: string } | null)?.notice === 'deleted' ? t('people.actions.done') : null))
  const [issued, setIssued] = useState<IssuedGrant | null>(null)
  const [adding, setAdding] = useState(false)
  const admin = Boolean(user && canUser(user, Permission.MANAGE_USERS))
  const people = useMemo(() => query((vault) => listUsers(vault)), [query, revision])
  const groups = useMemo(() => (admin ? query((vault) => listGroups(vault)) : []), [admin, query, revision])
  const grants = useMemo(() => (admin ? query((vault) => listGrants(vault)) : []), [admin, query, revision])
  const overview = useMemo(() => (admin ? query((vault) => usersOverview(vault)) : null), [admin, query, revision])
  const [open, setOpen] = useState<{ id: string; mode: RowMode } | null>(null)
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set())
  const selection = useMemo<Selection>(
    () => ({
      picked,
      toggle: (key) =>
        setPicked((current) => {
          const next = new Set(current)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        }),
      set: (keys, on) =>
        setPicked((current) => {
          const next = new Set(current)
          for (const key of keys) {
            if (on) next.add(key)
            else next.delete(key)
          }
          return next
        }),
    }),
    [picked],
  )
  const roleOptions = useMemo(() => ROLES.map((role) => ({ value: role, label: roleLabel(role, t) })), [t])
  const yesNo = useMemo(
    () => [
      { value: 'yes', label: t('table.yes') },
      { value: 'no', label: t('table.no') },
    ],
    [t],
  )

  const peopleColumns = useMemo<Column<VaultUser>[]>(() => {
    const role = (person: VaultUser) => roleLabel(person.roleName, t)
    const group = (person: VaultUser) => person.groupName ?? '—'
    const check = (person: VaultUser) => (person.signInCheck ? t('invites.checkOn') : '—')
    const status = (person: VaultUser) => t(`people.status.${person.status}`)
    const access = (person: VaultUser) => t(`people.access.${person.access}`)
    const columns: Column<VaultUser>[] = [
      {
        id: 'email',
        header: t('common.email'),
        hideable: false,
        cell: (person) => (
          <span className="grid min-w-0">
            <Link to={`/app/users/${person.id}`} className="break-all font-medium hover:underline" data-testid="user-link">
              {person.email}
            </Link>
            {person.displayName ? <span className="break-words text-xs text-muted">{person.displayName}</span> : null}
          </span>
        ),
        sort: { type: 'text', value: (person) => person.email },
        search: (person) => `${person.email} ${person.displayName ?? ''}`,
        filter: { kind: 'text', value: (person) => person.email },
        exportAs: { kind: 'text', value: (person) => person.email },
      },
      {
        id: 'name',
        header: t('people.table.name'),
        hidden: true,
        cell: (person) => person.displayName ?? '—',
        sort: { type: 'text', value: (person) => person.displayName },
        exportAs: { kind: 'text', value: (person) => person.displayName },
      },
      {
        id: 'role',
        header: t('common.role'),
        cell: role,
        sort: { type: 'text', value: role },
        search: role,
        filter: { kind: 'select', value: (person) => person.roleName, options: roleOptions },
        exportAs: { kind: 'text', value: role },
      },
      {
        id: 'group',
        header: t('common.group'),
        cell: group,
        sort: { type: 'text', value: (person) => person.groupName },
        search: (person) => person.groupName,
        filter: { kind: 'select', value: group, options: [] },
        exportAs: { kind: 'text', value: (person) => person.groupName },
      },
      {
        id: 'status',
        header: t('people.table.status'),
        cell: (person) => <StatusBadge status={person.status} />,
        sort: { type: 'text', value: status },
        search: status,
        filter: { kind: 'select', value: (person) => person.status, options: STATUSES.map((value) => ({ value, label: t(`people.status.${value}`) })) },
        exportAs: { kind: 'text', value: status },
      },
      {
        id: 'records',
        header: t('people.table.records'),
        align: 'end',
        cell: (person) => person.records,
        sort: { type: 'number', value: (person) => person.records },
        exportAs: { kind: 'number', value: (person) => person.records },
      },
    ]
    if (!admin) return columns
    return [
      ...columns,
      {
        id: 'signInCheck',
        header: t('table.col.signInCheck'),
        cell: (person) => (person.signInCheck ? <span className="rounded-full bg-pine/10 px-2 py-0.5 text-xs text-pine-ink">{t('invites.checkOn')}</span> : '—'),
        sort: { type: 'text', value: check },
        filter: { kind: 'select', value: (person) => (person.signInCheck ? 'yes' : 'no'), options: yesNo },
        exportAs: { kind: 'boolean', value: (person) => person.signInCheck },
      },
      {
        id: 'lastSignIn',
        header: t('people.table.lastSignIn'),
        cell: (person) => <span className="whitespace-nowrap tabular-nums">{person.lastSignInAt ? formatWhen(person.lastSignInAt, locale) : t('people.table.never')}</span>,
        sort: { type: 'date', value: (person) => person.lastSignInAt },
        filter: { kind: 'date', value: (person) => person.lastSignInAt },
        exportAs: { kind: 'when', value: (person) => person.lastSignInAt },
      },
      {
        id: 'mustChange',
        header: t('people.table.mustChange'),
        hidden: true,
        cell: (person) => (person.mustChange ? t('table.yes') : '—'),
        filter: { kind: 'select', value: (person) => (person.mustChange ? 'yes' : 'no'), options: yesNo },
        exportAs: { kind: 'boolean', value: (person) => person.mustChange },
      },
      {
        id: 'access',
        header: t('people.table.access'),
        hidden: true,
        cell: access,
        sort: { type: 'text', value: access },
        filter: { kind: 'select', value: (person) => person.access, options: (['PASSWORD', 'CODE', 'NONE'] as const).map((value) => ({ value, label: t(`people.access.${value}`) })) },
        exportAs: { kind: 'text', value: access },
      },
      {
        id: 'created',
        header: t('table.col.created'),
        hidden: true,
        cell: (person) => <span className="whitespace-nowrap tabular-nums">{formatWhen(person.createdAt, locale)}</span>,
        sort: { type: 'date', value: (person) => person.createdAt },
        filter: { kind: 'date', value: (person) => person.createdAt },
        exportAs: { kind: 'when', value: (person) => person.createdAt },
      },
      {
        id: 'updated',
        header: t('people.table.updated'),
        hidden: true,
        cell: (person) => <span className="whitespace-nowrap tabular-nums">{person.updatedAt ? formatWhen(person.updatedAt, locale) : '—'}</span>,
        sort: { type: 'date', value: (person) => person.updatedAt },
        exportAs: { kind: 'when', value: (person) => person.updatedAt },
      },
    ]
  }, [admin, locale, roleOptions, t, yesNo])

  const grantColumns = useMemo<Column<GrantSummary>[]>(() => {
    const kind = (grant: GrantSummary) => (grant.kind === 'RESET' ? t('invites.kindReset') : t('invites.kindInvite'))
    const role = (grant: GrantSummary) => roleLabel(grant.roleName, t) || '—'
    return [
      {
        id: 'email',
        header: t('common.email'),
        hideable: false,
        cell: (grant) => <span className="break-all font-medium">{grant.email}</span>,
        sort: { type: 'text', value: (grant) => grant.email },
        search: (grant) => grant.email,
        exportAs: { kind: 'text', value: (grant) => grant.email },
      },
      {
        id: 'kind',
        header: t('table.col.kind'),
        cell: kind,
        sort: { type: 'text', value: kind },
        search: kind,
        filter: {
          kind: 'select',
          value: (grant) => grant.kind,
          options: [
            { value: 'INVITE', label: t('invites.kindInvite') },
            { value: 'RESET', label: t('invites.kindReset') },
          ],
        },
        exportAs: { kind: 'text', value: kind },
      },
      {
        id: 'role',
        header: t('common.role'),
        cell: role,
        sort: { type: 'text', value: (grant) => roleLabel(grant.roleName, t) },
        search: (grant) => roleLabel(grant.roleName, t),
        filter: { kind: 'select', value: (grant) => grant.roleName ?? '', options: roleOptions },
        exportAs: { kind: 'text', value: (grant) => roleLabel(grant.roleName, t) },
      },
      {
        id: 'group',
        header: t('common.group'),
        cell: (grant) => grant.groupName ?? '—',
        sort: { type: 'text', value: (grant) => grant.groupName },
        search: (grant) => grant.groupName,
        exportAs: { kind: 'text', value: (grant) => grant.groupName },
      },
      {
        id: 'expires',
        header: t('table.col.expires'),
        cell: (grant) =>
          grant.expired ? (
            <span className="text-clay-ink">{t('invites.expired')}</span>
          ) : (
            <span className="whitespace-nowrap tabular-nums">{formatWhen(grant.expiresAt, locale)}</span>
          ),
        sort: { type: 'date', value: (grant) => grant.expiresAt },
        filter: {
          kind: 'select',
          value: (grant) => (grant.expired ? 'expired' : 'active'),
          options: [
            { value: 'active', label: t('table.active') },
            { value: 'expired', label: t('invites.expired') },
          ],
        },
        exportAs: { kind: 'when', value: (grant) => grant.expiresAt },
      },
      {
        id: 'created',
        header: t('table.col.created'),
        hidden: true,
        cell: (grant) => <span className="whitespace-nowrap tabular-nums">{formatWhen(grant.createdAt, locale)}</span>,
        sort: { type: 'date', value: (grant) => grant.createdAt },
        exportAs: { kind: 'when', value: (grant) => grant.createdAt },
      },
    ]
  }, [locale, roleOptions, t])

  const guarded = useCallback(
    async (action: () => Promise<void>) => {
      setError(null)
      setNotice(null)
      try {
        await action()
      } catch (caught) {
        setError(textForError(caught, t))
      }
    },
    [t],
  )

  const onRevoke = (id: string) =>
    guarded(async () => {
      await run((vault) => revokeGrant(vault, id), { dirty: true })
      setNotice(t('invites.revoked'))
    })

  const closeAdd = useCallback(() => setAdding(false), [])

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-4xl">{t('users.title')}</h1>
          <p className="mt-1 text-sm text-muted">{t('users.intro')}</p>
        </div>
        {admin ? (
          <Button data-testid="user-add" onClick={() => setAdding(true)}>
            {t('people.add.button')}
          </Button>
        ) : null}
      </div>
      {error ? <Notice>{error}</Notice> : null}
      {notice ? (
        <p role="status" className="text-sm text-pine-ink">
          {notice}
        </p>
      ) : null}
      {issued ? <IssuedCode grant={issued} onDone={() => setIssued(null)} /> : null}
      {!admin ? (
        <p role="note" data-testid="users-read-only" className="rounded-2xl border border-line bg-card px-4 py-3 text-sm text-muted">
          {t('people.detail.readOnly')}
        </p>
      ) : null}
      {overview ? <UsersOverview overview={overview} /> : null}
      {adding ? (
        <AddUserDialog
          groups={groups}
          onClose={closeAdd}
          onIssued={(grant) => {
            setAdding(false)
            setNotice(null)
            setIssued(grant)
          }}
          onCreated={() => {
            setAdding(false)
            setNotice(t('people.add.created'))
          }}
        />
      ) : null}

      <section className="grid gap-3" aria-labelledby="users-table-title">
        <h2 id="users-table-title" className="sr-only">
          {t('users.title')}
        </h2>
        {admin && picked.size > 0 ? (
          <BulkBar
            ids={[...picked]}
            people={people}
            groups={groups}
            onDone={(count) => {
              setPicked(new Set())
              setNotice(fill(t('people.bulk.done'), { count }))
            }}
            onClear={() => setPicked(new Set())}
            guarded={guarded}
          />
        ) : null}
        <DataTable
          id="users"
          label={t('users.title')}
          rows={people}
          columns={peopleColumns}
          rowKey={(person) => person.id}
          groupAttributes={(person) => ({ 'data-testid': 'person-row', 'data-status': person.status })}
          exportTable="users"
          empty={t('people.table.empty')}
          selection={admin ? selection : undefined}
          rowActions={(person) =>
            admin ? (
              <PersonActions person={person} self={person.id === user?.id} mode={open?.id === person.id ? open.mode : 'idle'} setMode={(mode) => setOpen({ id: person.id, mode })} />
            ) : (
              <OpenLink person={person} />
            )
          }
          expanded={(person) =>
            admin && open?.id === person.id && open.mode !== 'idle' ? (
              <PersonPanel
                key={`${person.id}:${open.mode}`}
                person={person}
                mode={open.mode}
                setMode={(mode) => setOpen({ id: person.id, mode })}
                onIssued={setIssued}
                guarded={guarded}
                setNotice={setNotice}
              />
            ) : null
          }
        />
      </section>

      {admin ? (
        <section className="rounded-3xl border border-line bg-card p-5">
          <h2 className="font-display text-2xl">{t('invites.pending')}</h2>
          <div className="mt-3">
            <DataTable
              id="grants"
              label={t('invites.pending')}
              rows={grants}
              columns={grantColumns}
              rowKey={(grant) => grant.id}
              rowAttributes={() => ({ 'data-testid': 'grant-row' })}
              exportTable="grants"
              empty={t('invites.pendingNone')}
              rowActions={(grant) => (
                <Button variant="quiet" data-testid="grant-revoke" onClick={() => void onRevoke(grant.id)}>
                  {t('invites.revoke')}
                </Button>
              )}
            />
          </div>
        </section>
      ) : null}

      {admin ? <ClockFloorPanel guarded={guarded} setNotice={setNotice} /> : null}
    </div>
  )
}

const KEEP = ''

function BulkBar({
  ids,
  people,
  groups,
  onDone,
  onClear,
  guarded,
}: {
  ids: string[]
  people: VaultUser[]
  groups: { id: number; name: string }[]
  onDone: (count: number) => void
  onClear: () => void
  guarded: (action: () => Promise<void>) => Promise<void>
}) {
  const { t } = useI18n()
  const { run } = useVault()
  const [role, setRole] = useState<RoleName | typeof KEEP>(KEEP)
  const [group, setGroup] = useState(KEEP)
  const [confirming, setConfirming] = useState(false)
  const targets = ids.filter((id) => people.some((person) => person.id === id && person.status !== 'FORMER'))
  const change: BulkChange = {
    ...(role !== KEEP ? { roleName: role } : {}),
    ...(group !== KEEP ? { groupId: group === 'none' ? null : Number(group) } : {}),
  }
  const empty = Object.keys(change).length === 0 || targets.length === 0

  const apply = () =>
    guarded(async () => {
      const count = await run((vault) => bulkUpdateUsers(vault, targets, change), { dirty: true })
      onDone(count)
    })

  return (
    <div data-testid="users-bulk" className="grid gap-3 rounded-2xl border border-line bg-card px-4 py-3">
      <div className="flex flex-wrap items-end gap-3">
        <p className="self-center text-sm font-medium" role="status">
          {fill(t('people.bulk.selected'), { count: ids.length })}
        </p>
        <div className="w-full sm:w-44">
          <Field label={t('people.bulk.role')}>
            <select data-testid="bulk-role" className={controlClass} value={role} onChange={(event) => setRole(event.target.value as RoleName | typeof KEEP)}>
              <option value={KEEP}>{t('people.bulk.keep')}</option>
              {ROLES.map((item) => (
                <option key={item} value={item}>
                  {roleLabel(item, t)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="w-full sm:w-44">
          <Field label={t('people.bulk.group')}>
            <select data-testid="bulk-group" className={controlClass} value={group} onChange={(event) => setGroup(event.target.value)}>
              <option value={KEEP}>{t('people.bulk.keep')}</option>
              <option value="none">{t('people.overview.noGroupLabel')}</option>
              {groups.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Button data-testid="bulk-apply" disabled={empty} onClick={() => setConfirming(true)}>
          {t('people.bulk.apply')}
        </Button>
        <Button variant="quiet" data-testid="bulk-clear" onClick={onClear}>
          {t('people.bulk.clear')}
        </Button>
      </div>
      {confirming && !empty ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="w-full text-sm">{fill(t('people.bulk.confirm'), { count: targets.length })}</p>
          <Button data-testid="bulk-confirm" onClick={() => void apply().finally(() => setConfirming(false))}>
            {t('people.bulk.apply')}
          </Button>
          <Button variant="quiet" onClick={() => setConfirming(false)}>
            {t('common.cancel')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function ClockFloorPanel({ guarded, setNotice }: { guarded: (action: () => Promise<void>) => Promise<void>; setNotice: (notice: string | null) => void }) {
  const { t, locale } = useI18n()
  const { query, run, revision } = useVault()
  const [password, setPassword] = useState('')
  const [working, setWorking] = useState(false)
  const floor = useMemo(() => query((vault) => readClockFloor(vault)), [query, revision])
  const onReset = (event: FormEvent) => {
    event.preventDefault()
    setWorking(true)
    void guarded(async () => {
      await run((vault) => resetClockFloor(vault, password), { dirty: true })
      setPassword('')
      setNotice(t('invites.clockDone'))
    }).finally(() => setWorking(false))
  }
  return (
    <details data-testid="clock-floor" className="rounded-3xl border border-line bg-card p-5">
      <summary className="cursor-pointer font-medium">{t('invites.clockTitle')}</summary>
      <p className="mt-2 text-sm text-muted">{t('invites.clockHelp')}</p>
      <dl className="mt-3 grid gap-1 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-4">
        <dt className="text-muted">{t('invites.clockVault')}</dt>
        <dd className="tabular-nums">{floor.vault ? formatWhen(floor.vault, locale) : '—'}</dd>
        <dt className="text-muted">{t('invites.clockDevice')}</dt>
        <dd className="tabular-nums">{floor.device ? formatWhen(floor.device, locale) : '—'}</dd>
      </dl>
      <form className="mt-4 grid gap-4 md:grid-cols-2" onSubmit={onReset}>
        <Field label={t('security.replacePassword')}>
          <input
            data-testid="clock-floor-password"
            type="password"
            autoComplete="current-password"
            className={controlClass}
            maxLength={LIMITS.passwordMax}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </Field>
        <div className="flex items-end">
          <Button type="submit" variant="quiet" data-testid="clock-floor-reset" disabled={working}>
            {t('invites.clockReset')}
          </Button>
        </div>
      </form>
    </details>
  )
}

type RowMode = 'idle' | 'reset' | 'temp' | 'clear'

function PersonActions({ person, self, mode, setMode }: { person: VaultUser; self: boolean; mode: RowMode; setMode: (mode: RowMode) => void }) {
  const { t } = useI18n()
  const toggle = (next: RowMode) => setMode(mode === next ? 'idle' : next)
  return (
    <>
      {self ? (
        <Link to="/app/account" className="self-center text-sm text-pine-ink hover:underline" data-testid="user-use-account">
          {t('users.useAccount')}
        </Link>
      ) : person.status === 'ACTIVE' ? (
        <>
          <Button variant="quiet" aria-expanded={mode === 'reset' || mode === 'temp'} onClick={() => toggle('reset')} data-testid="user-issue-reset">
            {t('invites.issueReset')}
          </Button>
          {person.signInCheck ? (
            <Button variant="quiet" aria-expanded={mode === 'clear'} onClick={() => toggle('clear')} data-testid="user-clear-check">
              {t('invites.clearCheck')}
            </Button>
          ) : null}
        </>
      ) : null}
      <OpenLink person={person} />
    </>
  )
}

function OpenLink({ person }: { person: VaultUser }) {
  const { t } = useI18n()
  return (
    <Link
      to={`/app/users/${person.id}`}
      data-testid="user-open"
      aria-label={`${t('people.table.open')}: ${person.email}`}
      className="inline-flex items-center justify-center rounded-xl border border-line bg-card px-4 py-2.5 text-sm font-medium hover:border-brass"
    >
      {t('people.table.open')}
    </Link>
  )
}

function PersonPanel({
  person,
  mode,
  setMode,
  onIssued,
  guarded,
  setNotice,
}: {
  person: VaultUser
  mode: RowMode
  setMode: (mode: RowMode) => void
  onIssued: (grant: IssuedGrant) => void
  guarded: (action: () => Promise<void>) => Promise<void>
  setNotice: (text: string | null) => void
}) {
  const { t } = useI18n()
  const { run } = useVault()
  const [validity, setValidity] = useState<GrantValidity>(DEFAULT_GRANT_VALIDITY)
  const [stopOld, setStopOld] = useState(true)
  const [nextPassword, setNextPassword] = useState('')

  const onIssue = (event: FormEvent) => {
    event.preventDefault()
    void guarded(async () => {
      const grant = await run((vault) => issueReset(vault, person.id, { validity, stopOldPassword: stopOld }), { dirty: true })
      onIssued(grant)
      setMode('idle')
    })
  }

  const onTemp = (event: FormEvent) => {
    event.preventDefault()
    void guarded(async () => {
      await run((vault) => resetUserPassword(vault, person.id, nextPassword), { dirty: true })
      setNextPassword('')
      setMode('idle')
    })
  }

  const onClear = () =>
    guarded(async () => {
      await run((vault) => clearUserTotp(vault, person.id), { dirty: true })
      setNotice(t('invites.clearCheckDone'))
      setMode('idle')
    })

  return (
    <div>
      {mode === 'reset' ? (
        <form className="mt-3 grid gap-3" onSubmit={onIssue}>
          <p role="note" data-testid="reset-safes-warn" className="rounded-2xl border border-brass/50 bg-brass-soft px-3 py-2 text-sm">
            {t('invites.resetSafesWarn')}
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-full sm:w-56">
              <ValiditySelect testId="reset-validity" value={validity} onChange={setValidity} />
            </div>
            <label className="flex max-w-md items-start gap-2 text-sm">
              <input type="checkbox" data-testid="reset-stop-old" className="mt-1" checked={stopOld} onChange={(event) => setStopOld(event.target.checked)} />
              <span>
                <span className="font-medium">{t('invites.stopOld')}</span>
                <span className="block text-muted">{t('invites.stopOldHelp')}</span>
              </span>
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" data-testid="reset-issue-save">
              {t('invites.issueReset')}
            </Button>
            <Button variant="quiet" data-testid="user-reset" onClick={() => setMode('temp')}>
              {t('invites.tempPassword')}
            </Button>
            <Button variant="quiet" onClick={() => setMode('idle')}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      ) : null}
      {mode === 'temp' ? (
        <form className="mt-3 space-y-3" onSubmit={onTemp}>
          <p role="note" data-testid="reset-safes-warn" className="rounded-2xl border border-brass/50 bg-brass-soft px-3 py-2 text-sm">
            {t('users.resetSafesWarn')}
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <Field label={t('users.newPassword')}>
              <input
                type="password"
                autoComplete="new-password"
                data-testid="user-reset-password"
                className={controlClass}
                maxLength={LIMITS.passwordMax}
                value={nextPassword}
                onChange={(event) => setNextPassword(event.target.value)}
                required
              />
            </Field>
            <Button type="submit" data-testid="user-reset-save">
              {t('common.save')}
            </Button>
            <Button variant="quiet" onClick={() => setMode('idle')}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      ) : null}
      {mode === 'clear' ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p className="w-full text-sm">{t('invites.clearCheckConfirm')}</p>
          <Button variant="danger" data-testid="user-clear-check-confirm" onClick={() => void onClear()}>
            {t('invites.clearCheck')}
          </Button>
          <Button variant="quiet" onClick={() => setMode('idle')}>
            {t('common.cancel')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
