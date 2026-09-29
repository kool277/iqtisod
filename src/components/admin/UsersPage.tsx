import { useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { IssuedCode } from './IssuedCode'
import { RoleGroupFields, selectedGroupFor } from './RoleGroupFields'
import { PasswordHint } from '../auth/AuthBits'
import { Button, Field, Notice, controlClass } from '../ui'
import { useI18n } from '../../context/I18nContext'
import { useVault } from '../../context/VaultContext'
import type { RoleName, VaultUser } from '../../domain/types'
import type { MessageKey } from '../../i18n'
import { textForError } from '../../lib/errors'
import { LIMITS } from '../../lib/limits'
import { formatWhen } from '../../lib/money'
import { Permission, canUser } from '../../rbac'
import {
  DEFAULT_GRANT_VALIDITY,
  GRANT_VALIDITY,
  createInvite,
  isGrantValidity,
  issueReset,
  listGrants,
  revokeGrant,
  type GrantValidity,
  type IssuedGrant,
} from '../../services/grant.service'
import { listGroups } from '../../services/group.service'
import { clearUserTotp } from '../../services/totp.service'
import { createUser, deleteUser, listUsers, resetUserPassword } from '../../services/user.service'

const VALIDITY_LABELS: Record<GrantValidity, MessageKey> = {
  '15m': 'invites.v15m',
  '1h': 'invites.v1h',
  '24h': 'invites.v24h',
  '72h': 'invites.v72h',
  '7d': 'invites.v7d',
}

function roleLabel(role: string | null, t: (key: MessageKey) => string): string {
  if (role === 'Admin' || role === 'Manager' || role === 'Viewer') return t(`roles.${role}`)
  return role ?? ''
}

function ValiditySelect({ testId, value, onChange }: { testId: string; value: GrantValidity; onChange: (value: GrantValidity) => void }) {
  const { t } = useI18n()
  return (
    <Field label={t('invites.validity')}>
      <select
        data-testid={testId}
        className={controlClass}
        value={value}
        onChange={(event) => {
          if (isGrantValidity(event.target.value)) onChange(event.target.value)
        }}
      >
        {(Object.keys(GRANT_VALIDITY) as GrantValidity[]).map((key) => (
          <option key={key} value={key}>
            {t(VALIDITY_LABELS[key])}
          </option>
        ))}
      </select>
    </Field>
  )
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
  const { t, locale } = useI18n()
  const { user, query, run, revision } = useVault()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [issued, setIssued] = useState<IssuedGrant | null>(null)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<RoleName>('Viewer')
  const [inviteGroup, setInviteGroup] = useState('')
  const [validity, setValidity] = useState<GrantValidity>(DEFAULT_GRANT_VALIDITY)
  const [inviting, setInviting] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<RoleName>('Viewer')
  const [groupId, setGroupId] = useState('')
  const allowed = Boolean(user && canUser(user, Permission.MANAGE_USERS))
  const people = useMemo(() => (allowed ? query((vault) => listUsers(vault)) : []), [allowed, query, revision])
  const groups = useMemo(() => (allowed ? query((vault) => listGroups(vault)) : []), [allowed, query, revision])
  const grants = useMemo(() => (allowed ? query((vault) => listGrants(vault)) : []), [allowed, query, revision])
  if (!allowed) return <Forbidden />

  async function guarded(action: () => Promise<void>) {
    setError(null)
    setNotice(null)
    try {
      await action()
    } catch (caught) {
      setError(textForError(caught, t))
    }
  }

  const onInvite = (event: FormEvent) => {
    event.preventDefault()
    setInviting(true)
    void guarded(async () => {
      const group = selectedGroupFor(inviteRole, inviteGroup, groups)
      const grant = await run(
        (vault) => createInvite(vault, { email: inviteEmail, roleName: inviteRole, groupId: group ? Number(group) : null, validity }),
        { dirty: true },
      )
      setIssued(grant)
      setInviteEmail('')
    }).finally(() => setInviting(false))
  }

  const onCreate = (event: FormEvent) => {
    event.preventDefault()
    void guarded(async () => {
      const group = selectedGroupFor(role, groupId, groups)
      await run((vault) => createUser(vault, { email, password, roleName: role, groupId: group ? Number(group) : null }), { dirty: true })
      setEmail('')
      setPassword('')
    })
  }

  const onRevoke = (id: string) =>
    guarded(async () => {
      await run((vault) => revokeGrant(vault, id), { dirty: true })
      setNotice(t('invites.revoked'))
    })

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="font-display text-4xl">{t('users.title')}</h1>
        <p className="mt-1 text-sm text-muted">{t('users.intro')}</p>
      </div>
      {error ? <Notice>{error}</Notice> : null}
      {notice ? (
        <p role="status" className="text-sm text-pine-ink">
          {notice}
        </p>
      ) : null}
      {issued ? <IssuedCode grant={issued} onDone={() => setIssued(null)} /> : null}

      <form data-testid="invite-form" className="grid gap-4 rounded-3xl border border-line bg-card p-5 md:grid-cols-2" onSubmit={onInvite}>
        <div className="md:col-span-2">
          <h2 className="font-display text-2xl">{t('invites.title')}</h2>
          <p className="mt-1 text-sm text-muted">{t('invites.intro')}</p>
        </div>
        <Field label={t('invites.email')}>
          <input
            data-testid="invite-email"
            type="email"
            className={controlClass}
            maxLength={LIMITS.emailChars}
            value={inviteEmail}
            onChange={(event) => setInviteEmail(event.target.value)}
            required
          />
        </Field>
        <ValiditySelect testId="invite-validity" value={validity} onChange={setValidity} />
        <RoleGroupFields prefix="invite" role={inviteRole} groupId={inviteGroup} groups={groups} onRole={setInviteRole} onGroup={setInviteGroup} />
        <div className="md:col-span-2">
          <Button type="submit" data-testid="invite-create" disabled={inviting}>
            {inviting ? t('invites.working') : t('invites.create')}
          </Button>
        </div>
      </form>

      <section className="rounded-3xl border border-line bg-card p-5">
        <h2 className="font-display text-2xl">{t('invites.pending')}</h2>
        {grants.length === 0 ? <p className="mt-3 text-sm text-muted">{t('invites.pendingNone')}</p> : null}
        <ul className="mt-3 grid gap-2">
          {grants.map((grant) => (
            <li key={grant.id} data-testid="grant-row" className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3 text-sm">
              <span className="min-w-0">
                <span className="break-all font-medium">{grant.email}</span>
                <span className="text-muted">
                  {' · '}
                  {grant.kind === 'RESET' ? t('invites.kindReset') : `${t('invites.kindInvite')} · ${roleLabel(grant.roleName, t)}`}
                  {grant.groupName ? ` · ${grant.groupName}` : ''}
                  {' · '}
                  {grant.expired ? (
                    <span className="text-clay-ink">{t('invites.expired')}</span>
                  ) : (
                    `${t('invites.expires')} ${formatWhen(grant.expiresAt, locale)}`
                  )}
                </span>
              </span>
              <Button variant="quiet" data-testid="grant-revoke" onClick={() => void onRevoke(grant.id)}>
                {t('invites.revoke')}
              </Button>
            </li>
          ))}
        </ul>
      </section>

      <details data-testid="advanced-temp" className="rounded-3xl border border-line bg-card p-5">
        <summary className="cursor-pointer font-medium" data-testid="advanced-temp-toggle">
          {t('invites.advanced')}
        </summary>
        <p className="mt-2 text-sm text-muted">{t('invites.advancedHelp')}</p>
        <form className="mt-4 grid gap-4 md:grid-cols-2" onSubmit={onCreate}>
          <Field label={t('common.email')}>
            <input
              data-testid="user-email"
              type="email"
              className={controlClass}
              maxLength={LIMITS.emailChars}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </Field>
          <Field label={t('common.password')}>
            <input
              data-testid="user-password"
              type="password"
              autoComplete="new-password"
              className={controlClass}
              maxLength={LIMITS.passwordMax}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            <PasswordHint />
          </Field>
          <RoleGroupFields prefix="user" role={role} groupId={groupId} groups={groups} onRole={setRole} onGroup={setGroupId} />
          <div className="md:col-span-2">
            <Button type="submit" variant="quiet" data-testid="user-save">
              {t('users.create')}
            </Button>
          </div>
        </form>
      </details>

      <ul className="grid gap-3">
        {people.map((person) => (
          <PersonRow key={person.id} person={person} self={person.id === user?.id} onIssued={setIssued} guarded={guarded} setNotice={setNotice} />
        ))}
      </ul>
    </div>
  )
}

type RowMode = 'idle' | 'reset' | 'temp' | 'clear' | 'delete'

function PersonRow({
  person,
  self,
  onIssued,
  guarded,
  setNotice,
}: {
  person: VaultUser
  self: boolean
  onIssued: (grant: IssuedGrant) => void
  guarded: (action: () => Promise<void>) => Promise<void>
  setNotice: (text: string | null) => void
}) {
  const { t } = useI18n()
  const { run } = useVault()
  const [mode, setMode] = useState<RowMode>('idle')
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

  const onDelete = () =>
    guarded(async () => {
      await run((vault) => deleteUser(vault, person.id), { dirty: true })
      setMode('idle')
    })

  return (
    <li data-testid="person-row" className="rounded-3xl border border-line bg-card px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="break-all font-medium">{person.email}</p>
          <p className="text-sm text-muted">
            {roleLabel(person.roleName, t)}
            {person.groupName ? ` · ${person.groupName}` : ''}
            {person.signInCheck ? ` · ${t('invites.checkOn')}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {self ? (
            <Link to="/app/account" className="text-sm text-pine-ink hover:underline" data-testid="user-use-account">
              {t('users.useAccount')}
            </Link>
          ) : (
            <>
              <Button variant="quiet" onClick={() => setMode('reset')} data-testid="user-issue-reset">
                {t('invites.issueReset')}
              </Button>
              {person.signInCheck ? (
                <Button variant="quiet" onClick={() => setMode('clear')} data-testid="user-clear-check">
                  {t('invites.clearCheck')}
                </Button>
              ) : null}
            </>
          )}
          <Button variant="danger" onClick={() => setMode('delete')}>
            {t('users.remove')}
          </Button>
        </div>
      </div>
      {mode === 'reset' ? (
        <form className="mt-3 grid gap-3" onSubmit={onIssue}>
          <p role="note" data-testid="reset-safes-warn" className="rounded-2xl border border-brass/50 bg-brass-soft px-3 py-2 text-sm">
            {t('users.resetSafesWarn')}
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
      {mode === 'delete' ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p className="w-full text-sm text-clay-ink" data-testid="remove-safes-warn">
            {t('users.removeSafesWarn')}
          </p>
          <p className="text-sm">{t('users.removeConfirm')}</p>
          <Button variant="danger" onClick={() => void onDelete()}>
            {t('users.remove')}
          </Button>
          <Button variant="quiet" onClick={() => setMode('idle')}>
            {t('common.cancel')}
          </Button>
        </div>
      ) : null}
    </li>
  )
}
