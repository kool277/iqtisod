import type { MessageKey } from '../i18n'

export const auditLabel = (action: string, t: (key: MessageKey) => string) => {
  const key = `audit.actions.${action}` as MessageKey
  const securityKey = `securityAudit.${action}` as MessageKey
  const label = t(key) === key ? t(securityKey) : t(key)
  return label === securityKey ? action : label
}
