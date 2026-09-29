import { Field, controlClass } from '../ui'
import { useI18n } from '../../context/I18nContext'
import type { Group, RoleName } from '../../domain/types'

export function selectedGroupFor(role: RoleName, groupId: string, groups: Group[]): string {
  return groupId || (role === 'Admin' ? '' : String(groups[0]?.id ?? ''))
}

export function RoleGroupFields({
  prefix,
  role,
  groupId,
  groups,
  onRole,
  onGroup,
}: {
  prefix: string
  role: RoleName
  groupId: string
  groups: Group[]
  onRole: (role: RoleName) => void
  onGroup: (groupId: string) => void
}) {
  const { t } = useI18n()
  return (
    <>
      <Field label={t('common.role')}>
        <select data-testid={`${prefix}-role`} className={controlClass} value={role} onChange={(event) => onRole(event.target.value as RoleName)}>
          <option value="Manager">{t('roles.Manager')}</option>
          <option value="Viewer">{t('roles.Viewer')}</option>
          <option value="Admin">{t('roles.Admin')}</option>
        </select>
      </Field>
      <Field label={t('common.group')}>
        <select data-testid={`${prefix}-group`} className={controlClass} value={selectedGroupFor(role, groupId, groups)} onChange={(event) => onGroup(event.target.value)}>
          {role === 'Admin' ? <option value="">—</option> : null}
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
      </Field>
    </>
  )
}
