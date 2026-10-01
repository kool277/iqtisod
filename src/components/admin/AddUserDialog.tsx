import { useState, type FormEvent } from 'react'
import { RoleGroupFields, selectedGroupFor } from './RoleGroupFields'
import { ValiditySelect } from './shared'
import { PasswordHint } from '../auth/AuthBits'
import { Dialog } from '../Dialog'
import { Button, Field, Notice, controlClass } from '../ui'
import { useI18n } from '../../context/I18nContext'
import { useVault } from '../../context/VaultContext'
import type { Group, RoleName } from '../../domain/types'
import { textForError } from '../../lib/errors'
import { LIMITS } from '../../lib/limits'
import { DEFAULT_GRANT_VALIDITY, createInvite, type GrantValidity, type IssuedGrant } from '../../services/grant.service'
import { createUser } from '../../services/user.service'

type Mode = 'invite' | 'temp'

/** One place to add someone: an invite code they redeem themselves, or a temporary password they must change. */
export function AddUserDialog({
  groups,
  onClose,
  onIssued,
  onCreated,
}: {
  groups: Group[]
  onClose: () => void
  onIssued: (grant: IssuedGrant) => void
  onCreated: () => void
}) {
  const { t } = useI18n()
  const { run } = useVault()
  const [mode, setMode] = useState<Mode>('invite')
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<RoleName>('Viewer')
  const [groupId, setGroupId] = useState('')
  const [validity, setValidity] = useState<GrantValidity>(DEFAULT_GRANT_VALIDITY)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    setWorking(true)
    const group = selectedGroupFor(role, groupId, groups)
    const target = { roleName: role, groupId: group ? Number(group) : null }
    const action =
      mode === 'invite'
        ? run((vault) => createInvite(vault, { email, validity, ...target }), { dirty: true }).then(onIssued)
        : run((vault) => createUser(vault, { email, password, displayName, ...target }), { dirty: true }).then(onCreated)
    action.catch((caught: unknown) => setError(textForError(caught, t))).finally(() => setWorking(false))
  }

  const tab = (value: Mode, label: string, testId: string) => (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={mode === value}
      className={`rounded-xl px-3 py-2 text-sm ${mode === value ? 'bg-pine text-on-pine' : 'border border-line text-muted hover:text-ink'}`}
      onClick={() => {
        setMode(value)
        setError(null)
      }}
    >
      {label}
    </button>
  )

  return (
    <Dialog title={t('people.add.title')} onClose={onClose} testId="add-user-dialog" wide>
      <form data-testid={mode === 'invite' ? 'invite-form' : 'temp-form'} className="grid gap-4 md:grid-cols-2" onSubmit={submit}>
        <div className="flex flex-wrap gap-2 md:col-span-2" role="group" aria-label={t('people.add.title')}>
          {tab('invite', t('people.add.invite'), 'add-mode-invite')}
          {tab('temp', t('people.add.temp'), 'advanced-temp-toggle')}
        </div>
        <p className="text-sm text-muted md:col-span-2">{mode === 'invite' ? t('invites.intro') : t('invites.advancedHelp')}</p>
        {error ? (
          <div className="md:col-span-2">
            <Notice>{error}</Notice>
          </div>
        ) : null}
        <Field label={mode === 'invite' ? t('invites.email') : t('common.email')}>
          <input
            data-testid={mode === 'invite' ? 'invite-email' : 'user-email'}
            type="email"
            className={controlClass}
            maxLength={LIMITS.emailChars}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </Field>
        {mode === 'invite' ? (
          <ValiditySelect testId="invite-validity" value={validity} onChange={setValidity} />
        ) : (
          <Field label={t('people.add.displayName')}>
            <input data-testid="user-name" className={controlClass} maxLength={LIMITS.nameChars} value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </Field>
        )}
        {mode === 'temp' ? (
          <div className="md:col-span-2">
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
          </div>
        ) : null}
        <RoleGroupFields prefix={mode === 'invite' ? 'invite' : 'user'} role={role} groupId={groupId} groups={groups} onRole={setRole} onGroup={setGroupId} />
        <div className="flex flex-wrap gap-2 md:col-span-2">
          <Button type="submit" data-testid={mode === 'invite' ? 'invite-create' : 'user-save'} disabled={working}>
            {working ? t('invites.working') : mode === 'invite' ? t('invites.create') : t('users.create')}
          </Button>
          <Button variant="quiet" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
