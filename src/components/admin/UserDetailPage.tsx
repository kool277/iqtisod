import { ArrowLeft } from 'lucide-react'
import { useCallback, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { IssuedCode } from './IssuedCode'
import { RoleGroupFields, selectedGroupFor } from './RoleGroupFields'
import { Forbidden, PeopleStrings, StatusBadge, ValiditySelect, roleLabel } from './shared'
import { auditLabel } from '../audit-label'
import { Dialog } from '../Dialog'
import { Button, Field, Notice, controlClass } from '../ui'
import { useI18n } from '../../context/I18nContext'
import { useVault } from '../../context/VaultContext'
import type { RoleName, VaultUser } from '../../domain/types'
import { textForError } from '../../lib/errors'
import { LIMITS } from '../../lib/limits'
import { formatIsoDate, formatWhen } from '../../lib/money'
import { formatMinorExact, minorToPlainDecimal } from '../../lib/money-exact'
import { Permission, canUser, seesMembers } from '../../rbac'
import { DEFAULT_GRANT_VALIDITY, issueReset, type GrantValidity, type IssuedGrant } from '../../services/grant.service'
import { listGroups } from '../../services/group.service'
import { clearUserTotp } from '../../services/totp.service'
import {
  deleteUser,
  getUserDetail,
  listUsers,
  reactivateUser,
  requirePasswordChange,
  suspendUser,
  updateUser,
  type DeleteOptions,
  type UserDetail,
} from '../../services/user.service'
import { fill } from '../table/model'

type Action = 'edit' | 'reset' | 'clear' | 'force' | 'suspend' | 'reactivate' | 'delete'

export function UserDetailPage() {
  const { user } = useVault()
  if (!user || !seesMembers(user)) return <Forbidden />
  return (
    <PeopleStrings>
      <UserDetailView />
    </PeopleStrings>
  )
}

function UserDetailView() {
  const { t } = useI18n()
  const { userId = '' } = useParams()
  const { user, query, revision } = useVault()
  const admin = Boolean(user && canUser(user, Permission.MANAGE_USERS))
  const detail = useMemo<UserDetail | null>(() => {
    try {
      return query((vault) => getUserDetail(vault, userId))
    } catch {
      return null
    }
  }, [query, revision, userId])
  const [action, setAction] = useState<Action | null>(null)
  const [issued, setIssued] = useState<IssuedGrant | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const close = useCallback(() => setAction(null), [])

  const back = (
    <Link to="/app/users" data-testid="user-back" className="inline-flex items-center gap-1 text-sm text-pine-ink hover:underline">
      <ArrowLeft size={14} aria-hidden="true" />
      {t('people.detail.back')}
    </Link>
  )
  if (!detail) {
    return (
      <div className="grid gap-4">
        {back}
        <p data-testid="user-not-found" className="text-clay-ink">
          {t('people.detail.notFound')}
        </p>
      </div>
    )
  }
  const person = detail.user
  const self = person.id === user?.id
  const done = (text: string) => {
    setAction(null)
    setNotice(text)
  }

  return (
    <div className="grid gap-6" data-testid="user-detail" data-status={person.status}>
      {back}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="break-words font-display text-4xl" data-testid="user-detail-title">
            {person.displayName ?? person.email}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
            {person.displayName ? <span className="break-all">{person.email}</span> : null}
            <span>{roleLabel(person.roleName, t)}</span>
            {person.groupName ? <span>· {person.groupName}</span> : null}
            <StatusBadge status={person.status} />
          </p>
        </div>
        {admin ? <ActionBar person={person} self={self} onAction={setAction} /> : null}
      </div>
      {notice ? (
        <p role="status" data-testid="user-detail-notice" className="text-sm text-pine-ink">
          {notice}
        </p>
      ) : null}
      {issued ? <IssuedCode grant={issued} onDone={() => setIssued(null)} /> : null}
      <Notes person={person} self={self} admin={admin} />
      <div className="grid gap-4 lg:grid-cols-2">
        <ProfileCard detail={detail} admin={admin} />
        <RecordsCard detail={detail} />
      </div>
      {detail.activity ? <ActivityCard detail={detail} /> : null}

      {action === 'edit' ? <EditDialog person={person} onClose={close} onDone={() => done(t('people.actions.saved'))} /> : null}
      {action === 'reset' ? (
        <ResetDialog
          person={person}
          onClose={close}
          onIssued={(grant) => {
            setAction(null)
            setNotice(null)
            setIssued(grant)
          }}
        />
      ) : null}
      {action === 'clear' ? (
        <ConfirmDialog
          title={t('invites.clearCheck')}
          body={t('invites.clearCheckConfirm')}
          confirm={t('invites.clearCheck')}
          testId="user-clear-dialog"
          danger
          onClose={close}
          perform={(vault) => clearUserTotp(vault, person.id)}
          onDone={() => done(t('invites.clearCheckDone'))}
        />
      ) : null}
      {action === 'force' ? (
        <ConfirmDialog
          title={t('people.actions.force')}
          body={t('people.actions.forceConfirm')}
          confirm={t('people.actions.force')}
          testId="user-force-dialog"
          onClose={close}
          perform={(vault) => requirePasswordChange(vault, person.id)}
          onDone={() => done(t('people.actions.forceDone'))}
        />
      ) : null}
      {action === 'suspend' ? (
        <ConfirmDialog
          title={t('people.actions.suspendTitle')}
          body={t('people.actions.suspendBody')}
          note={t('people.actions.suspendLimit')}
          confirm={t('people.actions.suspend')}
          testId="user-suspend-dialog"
          danger
          onClose={close}
          perform={(vault) => suspendUser(vault, person.id)}
          onDone={() => done(t('people.actions.suspendDone'))}
        />
      ) : null}
      {action === 'reactivate' ? (
        <ReactivateDialog
          onClose={close}
          person={person}
          onIssued={(grant) => {
            setAction(null)
            setNotice(null)
            setIssued(grant)
          }}
        />
      ) : null}
      {action === 'delete' ? <DeleteDialog person={person} onClose={close} /> : null}
    </div>
  )
}

function ActionBar({ person, self, onAction }: { person: VaultUser; self: boolean; onAction: (action: Action) => void }) {
  const { t } = useI18n()
  const button = (action: Action, label: string, variant: 'quiet' | 'danger' = 'quiet') => (
    <Button key={action} variant={variant} data-testid={`user-action-${action}`} onClick={() => onAction(action)}>
      {label}
    </Button>
  )
  const actions: ReactNode[] = []
  if (person.status !== 'FORMER') actions.push(button('edit', t('people.actions.edit')))
  if (!self && person.status === 'ACTIVE') {
    actions.push(button('reset', t('people.actions.reset')))
    if (person.signInCheck) actions.push(button('clear', t('people.actions.clearTotp')))
    if (!person.mustChange) actions.push(button('force', t('people.actions.force')))
    actions.push(button('suspend', t('people.actions.suspend'), 'danger'))
  }
  if (!self && person.status === 'SUSPENDED') actions.push(button('reactivate', t('people.actions.reactivate')))
  if (!self) actions.push(button('delete', t('people.actions.delete'), 'danger'))
  return (
    <div className="flex flex-wrap gap-2" data-testid="user-actions">
      {actions}
    </div>
  )
}

function Notes({ person, self, admin }: { person: VaultUser; self: boolean; admin: boolean }) {
  const { t } = useI18n()
  const note = (text: string, testId: string) => (
    <p role="note" data-testid={testId} className="rounded-2xl border border-line bg-card px-4 py-3 text-sm text-muted">
      {text}
    </p>
  )
  return (
    <>
      {!admin ? note(t('people.detail.readOnly'), 'user-read-only') : null}
      {self ? (
        <p role="note" data-testid="user-self" className="rounded-2xl border border-line bg-card px-4 py-3 text-sm text-muted">
          {t('people.detail.you')}{' '}
          <Link to="/app/account" className="text-pine-ink hover:underline">
            {t('users.useAccount')}
          </Link>
        </p>
      ) : null}
      {person.status === 'SUSPENDED' ? note(t('people.detail.suspendedNote'), 'user-suspended-note') : null}
      {person.status === 'FORMER' ? note(t('people.detail.formerNote'), 'user-former-note') : null}
      {admin && person.status === 'ACTIVE' && person.access === 'NONE' ? note(t('people.detail.noAccessNote'), 'user-no-access-note') : null}
    </>
  )
}

function Row({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words" data-testid={testId}>
        {children}
      </dd>
    </>
  )
}

function ProfileCard({ detail, admin }: { detail: UserDetail; admin: boolean }) {
  const { t, locale } = useI18n()
  const person = detail.user
  return (
    <section className="rounded-3xl border border-line bg-card p-5" aria-labelledby="user-profile-title">
      <h2 id="user-profile-title" className="font-display text-2xl">
        {t('people.detail.profile')}
      </h2>
      <dl className="mt-3 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        <Row label={t('common.email')} testId="user-detail-email">
          <span className="break-all">{person.email}</span>
        </Row>
        <Row label={t('people.table.name')} testId="user-detail-name">
          {person.displayName ?? '—'}
        </Row>
        <Row label={t('common.role')} testId="user-detail-role">
          {roleLabel(person.roleName, t)}
        </Row>
        <Row label={t('common.group')} testId="user-detail-group">
          {person.groupName ?? '—'}
        </Row>
        <Row label={t('people.detail.created')}>{formatWhen(person.createdAt, locale)}</Row>
        <Row label={t('people.detail.updated')}>{person.updatedAt ? formatWhen(person.updatedAt, locale) : '—'}</Row>
        {admin ? (
          <>
            <Row label={t('people.detail.lastSignIn')} testId="user-detail-last-sign-in">
              {person.lastSignInAt ? formatWhen(person.lastSignInAt, locale) : t('people.table.never')}
            </Row>
            <Row label={t('people.detail.totp')} testId="user-detail-totp">
              {person.signInCheck ? t('people.detail.on') : t('people.detail.off')}
            </Row>
            <Row label={t('people.detail.mustChange')} testId="user-detail-must-change">
              {person.mustChange ? t('people.detail.yes') : t('people.detail.no')}
            </Row>
            <Row label={t('people.table.access')} testId="user-detail-access">
              {t(`people.access.${person.access}`)}
            </Row>
            {detail.openCode ? (
              <Row label={t('people.detail.openCode')} testId="user-detail-code">
                {detail.openCode.expired
                  ? `${detail.openCode.kind === 'RESET' ? t('invites.kindReset') : t('invites.kindInvite')}, ${t('invites.expired')}`
                  : fill(t('people.detail.openCodeLine'), {
                      kind: detail.openCode.kind === 'RESET' ? t('invites.kindReset') : t('invites.kindInvite'),
                      when: formatWhen(detail.openCode.expiresAt, locale),
                    })}
              </Row>
            ) : null}
          </>
        ) : null}
      </dl>
    </section>
  )
}

function RecordsCard({ detail }: { detail: UserDetail }) {
  const { t, locale } = useI18n()
  const { records } = detail
  return (
    <section data-testid="user-records" data-count={records.count} className="rounded-3xl border border-line bg-card p-5" aria-labelledby="user-records-title">
      <h2 id="user-records-title" className="font-display text-2xl">
        {t('people.detail.records')}
      </h2>
      <p className="mt-1 text-sm text-muted">{t('people.detail.recordsHelp')}</p>
      {records.count === 0 ? (
        <p className="mt-3 text-sm text-muted">{t('people.detail.recordsNone')}</p>
      ) : (
        <>
          <p className="mt-3 text-sm">
            {fill(t('people.detail.count'), { count: records.count })}
            {records.lastDate ? <span className="text-muted"> · {fill(t('people.detail.lastDate'), { date: formatIsoDate(records.lastDate, locale) })}</span> : null}
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted">
                  <th scope="col" className="py-1 pr-3 font-medium">
                    {t('people.detail.currency')}
                  </th>
                  <th scope="col" className="py-1 pr-3 text-right font-medium">
                    {t('people.detail.income')}
                  </th>
                  <th scope="col" className="py-1 pr-3 text-right font-medium">
                    {t('people.detail.expense')}
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    {t('people.detail.net')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {records.currencies.map((line) => {
                  const net = line.incomeMinor - line.expenseMinor
                  return (
                    <tr key={line.currency} data-testid="user-records-line" data-currency={line.currency} className="border-t border-line">
                      <td className="py-1.5 pr-3">{line.currency}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-pine-ink" data-amount={minorToPlainDecimal(line.incomeMinor, line.currency)}>
                        {formatMinorExact(line.incomeMinor, line.currency, locale)}
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-clay-ink" data-amount={minorToPlainDecimal(line.expenseMinor, line.currency)}>
                        {formatMinorExact(line.expenseMinor, line.currency, locale)}
                      </td>
                      <td className={`py-1.5 text-right tabular-nums ${net >= 0n ? 'text-pine-ink' : 'text-clay-ink'}`} data-amount={minorToPlainDecimal(net, line.currency)}>
                        {formatMinorExact(net, line.currency, locale)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}

function ActivityCard({ detail }: { detail: UserDetail }) {
  const { t, locale } = useI18n()
  const activity = detail.activity ?? []
  return (
    <section data-testid="user-activity" className="rounded-3xl border border-line bg-card p-5" aria-labelledby="user-activity-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="user-activity-title" className="font-display text-2xl">
          {t('people.detail.activity')}
        </h2>
        <Link to="/app/audit" className="text-sm text-pine-ink hover:underline">
          {t('people.detail.openAudit')}
        </Link>
      </div>
      <p className="mt-1 text-sm text-muted">{t('people.detail.activityHelp')}</p>
      {activity.length === 0 ? (
        <p className="mt-3 text-sm text-muted">{t('people.detail.activityNone')}</p>
      ) : (
        <ol className="mt-3 grid gap-1 text-sm">
          {activity.map((entry) => (
            <li key={entry.id} data-testid="user-activity-entry" data-action={entry.action} className="flex flex-wrap justify-between gap-x-3 border-t border-line py-1.5 first:border-t-0">
              <span>{auditLabel(entry.action, t)}</span>
              <span className="whitespace-nowrap tabular-nums text-muted">{formatWhen(entry.createdAt, locale)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function useGuard() {
  const { t } = useI18n()
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const guard = useCallback(
    (action: () => Promise<void>) => {
      setError(null)
      setWorking(true)
      action()
        .catch((caught: unknown) => setError(textForError(caught, t)))
        .finally(() => setWorking(false))
    },
    [t],
  )
  return { error, working, guard }
}

type Perform = Parameters<ReturnType<typeof useVault>['run']>[0]

function ConfirmDialog({
  title,
  body,
  note,
  confirm,
  testId,
  danger,
  onClose,
  perform,
  onDone,
}: {
  title: string
  body: string
  note?: string
  confirm: string
  testId: string
  danger?: boolean
  onClose: () => void
  perform: Perform
  onDone: () => void
}) {
  const { t } = useI18n()
  const { run } = useVault()
  const { error, working, guard } = useGuard()
  return (
    <Dialog title={title} onClose={onClose} testId={testId}>
      <div className="grid gap-3">
        <p className="text-sm">{body}</p>
        {note ? (
          <p role="note" className="rounded-2xl border border-brass/50 bg-brass-soft px-3 py-2 text-xs">
            {note}
          </p>
        ) : null}
        {error ? <Notice>{error}</Notice> : null}
        <div className="flex flex-wrap gap-2">
          <Button variant={danger ? 'danger' : 'primary'} data-testid={`${testId}-confirm`} disabled={working} onClick={() => guard(() => run(perform, { dirty: true }).then(onDone))}>
            {confirm}
          </Button>
          <Button variant="quiet" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function EditDialog({ person, onClose, onDone }: { person: VaultUser; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n()
  const { query, run, revision } = useVault()
  const groups = useMemo(() => query((vault) => listGroups(vault)), [query, revision])
  const { error, working, guard } = useGuard()
  const [email, setEmail] = useState(person.email)
  const [displayName, setDisplayName] = useState(person.displayName ?? '')
  const [role, setRole] = useState<RoleName>(person.roleName as RoleName)
  const [groupId, setGroupId] = useState(person.groupId == null ? '' : String(person.groupId))
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const group = selectedGroupFor(role, groupId, groups)
    guard(() => run((vault) => updateUser(vault, person.id, { email, displayName, roleName: role, groupId: group ? Number(group) : null }), { dirty: true }).then(onDone))
  }
  return (
    <Dialog title={t('people.actions.editTitle')} onClose={onClose} testId="user-edit-dialog" wide>
      <form className="grid gap-4 md:grid-cols-2" onSubmit={submit}>
        {error ? (
          <div className="md:col-span-2">
            <Notice>{error}</Notice>
          </div>
        ) : null}
        <Field label={t('people.table.name')}>
          <input data-testid="edit-name" className={controlClass} maxLength={LIMITS.nameChars} value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
        </Field>
        <Field label={t('common.email')}>
          <input data-testid="edit-email" type="email" className={controlClass} maxLength={LIMITS.emailChars} value={email} onChange={(event) => setEmail(event.target.value)} required />
          <span className="mt-1 block text-xs text-muted">{t('people.actions.emailHelp')}</span>
        </Field>
        <RoleGroupFields prefix="edit" role={role} groupId={groupId} groups={groups} onRole={setRole} onGroup={setGroupId} />
        <div className="flex flex-wrap gap-2 md:col-span-2">
          <Button type="submit" data-testid="edit-save" disabled={working}>
            {t('people.actions.save')}
          </Button>
          <Button variant="quiet" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function ResetDialog({ person, onClose, onIssued }: { person: VaultUser; onClose: () => void; onIssued: (grant: IssuedGrant) => void }) {
  const { t } = useI18n()
  const { run } = useVault()
  const { error, working, guard } = useGuard()
  const [validity, setValidity] = useState<GrantValidity>(DEFAULT_GRANT_VALIDITY)
  const [stopOld, setStopOld] = useState(true)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    guard(() => run((vault) => issueReset(vault, person.id, { validity, stopOldPassword: stopOld }), { dirty: true }).then(onIssued))
  }
  return (
    <Dialog title={t('people.actions.reset')} onClose={onClose} testId="user-reset-dialog">
      <form className="grid gap-3" onSubmit={submit}>
        <p role="note" className="rounded-2xl border border-brass/50 bg-brass-soft px-3 py-2 text-sm">
          {t('invites.resetSafesWarn')}
        </p>
        {error ? <Notice>{error}</Notice> : null}
        <ValiditySelect testId="detail-reset-validity" value={validity} onChange={setValidity} />
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={stopOld} onChange={(event) => setStopOld(event.target.checked)} />
          <span>
            <span className="font-medium">{t('invites.stopOld')}</span>
            <span className="block text-muted">{t('invites.stopOldHelp')}</span>
          </span>
        </label>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" data-testid="detail-reset-issue" disabled={working}>
            {t('invites.issueReset')}
          </Button>
          <Button variant="quiet" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function ReactivateDialog({ person, onClose, onIssued }: { person: VaultUser; onClose: () => void; onIssued: (grant: IssuedGrant) => void }) {
  const { t } = useI18n()
  const { run } = useVault()
  const { error, working, guard } = useGuard()
  const [validity, setValidity] = useState<GrantValidity>(DEFAULT_GRANT_VALIDITY)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    guard(() => run((vault) => reactivateUser(vault, person.id, { validity }), { dirty: true }).then(onIssued))
  }
  return (
    <Dialog title={t('people.actions.reactivateTitle')} onClose={onClose} testId="user-reactivate-dialog">
      <form className="grid gap-3" onSubmit={submit}>
        <p className="text-sm">{t('people.actions.reactivateBody')}</p>
        {error ? <Notice>{error}</Notice> : null}
        <ValiditySelect testId="reactivate-validity" value={validity} onChange={setValidity} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" data-testid="user-reactivate-dialog-confirm" disabled={working}>
            {t('people.actions.reactivate')}
          </Button>
          <Button variant="quiet" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function DeleteDialog({ person, onClose }: { person: VaultUser; onClose: () => void }) {
  const { t } = useI18n()
  const { query, run, revision } = useVault()
  const navigate = useNavigate()
  const { error, working, guard } = useGuard()
  const others = useMemo(
    () => query((vault) => listUsers(vault)).filter((other) => other.id !== person.id && other.status !== 'FORMER'),
    [query, revision, person.id],
  )
  const hasRecords = person.records > 0
  const [records, setRecords] = useState<'REASSIGN' | 'KEEP'>(person.status === 'FORMER' ? 'REASSIGN' : 'KEEP')
  const [reassignTo, setReassignTo] = useState(others[0]?.id ?? '')
  const [typed, setTyped] = useState('')
  const matches = typed.trim().toLowerCase() === person.email
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const options: DeleteOptions = { confirmEmail: typed, ...(hasRecords ? { records, ...(records === 'REASSIGN' ? { reassignTo } : {}) } : {}) }
    guard(() => run((vault) => deleteUser(vault, person.id, options), { dirty: true }).then(() => navigate('/app/users', { state: { notice: 'deleted' } })))
  }
  return (
    <Dialog title={t('people.actions.deleteTitle')} onClose={onClose} testId="user-delete-dialog" wide>
      <form className="grid gap-4" onSubmit={submit}>
        <p className="text-sm text-clay-ink" data-testid="remove-safes-warn">
          {t('users.removeSafesWarn')}
        </p>
        {hasRecords ? (
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">{fill(t('people.actions.deleteRecords'), { count: person.records })}</legend>
            {person.status !== 'FORMER' ? (
              <label className="flex items-start gap-2 text-sm">
                <input type="radio" name="records" data-testid="delete-keep" className="mt-1" checked={records === 'KEEP'} onChange={() => setRecords('KEEP')} />
                <span>
                  <span className="font-medium">{t('people.actions.keep')}</span>
                  <span className="block text-muted">{t('people.actions.keepHelp')}</span>
                </span>
              </label>
            ) : null}
            <label className="flex items-start gap-2 text-sm">
              <input type="radio" name="records" data-testid="delete-reassign" className="mt-1" checked={records === 'REASSIGN'} onChange={() => setRecords('REASSIGN')} />
              <span className="font-medium">{t('people.actions.reassign')}</span>
            </label>
            {records === 'REASSIGN' ? (
              <Field label={t('people.actions.reassignTo')}>
                <select data-testid="delete-reassign-to" className={controlClass} value={reassignTo} onChange={(event) => setReassignTo(event.target.value)} required>
                  {others.map((other) => (
                    <option key={other.id} value={other.id}>
                      {other.displayName ? `${other.displayName} (${other.email})` : other.email}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
          </fieldset>
        ) : (
          <p className="text-sm text-muted">{t('people.actions.noRecords')}</p>
        )}
        <Field label={t('people.actions.typeEmail')}>
          <input
            data-testid="delete-confirm-email"
            type="email"
            autoComplete="off"
            className={controlClass}
            maxLength={LIMITS.emailChars}
            placeholder={person.email}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            required
          />
        </Field>
        {error ? <Notice>{error}</Notice> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="danger" data-testid="delete-confirm" disabled={working || !matches}>
            {t('people.actions.confirm')}
          </Button>
          <Button variant="quiet" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
