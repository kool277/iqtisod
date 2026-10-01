import type { ReactNode } from 'react'
import { Field, controlClass } from '../ui'
import { useI18n } from '../../context/I18nContext'
import { useLazyCatalog } from '../../context/useLazyCatalog'
import type { RoleName, UserStatus } from '../../domain/types'
import { hasPeopleMessages, loadPeopleMessages, type MessageKey } from '../../i18n'
import type { PeopleMessages } from '../../i18n/people/en'
import { AppError } from '../../domain/errors'
import { textForError } from '../../lib/errors'
import { GRANT_VALIDITY, isGrantValidity, type GrantValidity } from '../../services/grant.service'

const VALIDITY_LABELS: Record<GrantValidity, MessageKey> = {
  '15m': 'invites.v15m',
  '1h': 'invites.v1h',
  '24h': 'invites.v24h',
  '72h': 'invites.v72h',
  '7d': 'invites.v7d',
}

export const ROLES: RoleName[] = ['Admin', 'Manager', 'Viewer']

export function roleLabel(role: string | null, t: (key: MessageKey) => string): string {
  if (role === 'Admin' || role === 'Manager' || role === 'Viewer') return t(`roles.${role}`)
  return role ?? ''
}

export function ValiditySelect({ testId, value, onChange }: { testId: string; value: GrantValidity; onChange: (value: GrantValidity) => void }) {
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

export function Forbidden() {
  const { t } = useI18n()
  return (
    <p data-testid="forbidden" className="text-clay-ink">
      {t('errors.forbidden')}
    </p>
  )
}

const STATUS_STYLES: Record<UserStatus, string> = {
  ACTIVE: 'bg-pine/10 text-pine-ink',
  SUSPENDED: 'bg-brass-soft text-ink',
  FORMER: 'bg-paper text-muted border border-line',
}

export function StatusBadge({ status }: { status: UserStatus }) {
  const { t } = useI18n()
  return (
    <span data-testid="user-status" data-status={status} className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${STATUS_STYLES[status]}`}>
      {t(`people.status.${status}`)}
    </span>
  )
}

/** Renders the children once the People strings for the current language are loaded. */
export function PeopleStrings({ children }: { children: ReactNode }) {
  const catalog = useLazyCatalog(loadPeopleMessages, hasPeopleMessages)
  const { t } = useI18n()
  if (catalog !== 'ready') {
    return (
      <div role="status" aria-busy={catalog === 'loading'} className="min-h-40 text-sm text-muted">
        {catalog === 'failed' ? t('errors.sqlite') : null}
      </div>
    )
  }
  return children
}

type PeopleErrorKey = keyof PeopleMessages['errors']

const PEOPLE_ERRORS: readonly string[] = ['USER_SUSPENDED', 'USER_FORMER', 'NOT_SUSPENDED', 'USER_CODE_OPEN', 'REASSIGN_TARGET', 'CONFIRM_EMAIL'] satisfies PeopleErrorKey[]

/** Like `textForError`, plus the codes only the People pages raise; their strings live in the lazy `people` catalog. */
export function peopleErrorText(error: unknown, t: (key: MessageKey) => string): string {
  if (error instanceof AppError && PEOPLE_ERRORS.includes(error.code)) return t(`people.errors.${error.code as PeopleErrorKey}`)
  return textForError(error, t)
}
