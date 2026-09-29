import type { MessageKey } from '../i18n'
import { AppError } from '../domain/errors'

export function errorText(code: string, t: (key: MessageKey) => string): string {
  switch (code) {
    case 'BAD_CREDENTIALS':
      return t('login.badCredentials')
    case 'PASSWORD_MISMATCH':
      return t('setup.passwordMismatch')
    case 'PASSWORD_SHORT':
      return t('setup.passwordShort')
    case 'EMAIL':
      return t('setup.invalidEmail')
    case 'FORBIDDEN':
      return t('errors.forbidden')
    case 'DUPLICATE_EMAIL':
      return t('users.duplicate')
    case 'LAST_ADMIN':
      return t('users.lastAdmin')
    case 'RECEIPT_SIZE':
      return t('tx.receiptTooLarge')
    case 'AMOUNT':
      return t('errors.positiveAmount')
    case 'REQUIRED':
      return t('errors.required')
    case 'HAS_RECORDS':
      return t('users.hasRecords')
    case 'BACKUP':
      return t('backup.invalid')
    case 'SELF':
      return t('users.cannotRemoveSelf')
    case 'GROUP_IN_USE':
      return t('groups.removeBlocked')
    case 'CATEGORY_IN_USE':
      return t('settings.inUse')
    case 'LAST_CATEGORY':
      return t('settings.lastCategory')
    case 'AMOUNT_PRECISION':
      return t('errors.amountPrecision')
    case 'AMOUNT_LIMIT':
      return t('errors.amountLimit')
    case 'CURRENCY':
      return t('errors.currency')
    case 'FORMAT_TOO_NEW':
      return t('errors.formatTooNew')
    case 'RECORD_INVALID':
      return t('errors.recordInvalid')
    case 'VAULT_CONFLICT':
      return t('errors.conflict')
    case 'VAULT_IN_USE':
      return t('errors.inUse')
    case 'MIGRATION_FAILED':
      return t('errors.migration')
    case 'EXPORT_NO_FORMAT':
      return t('export.errors.noFormat')
    case 'EXPORT_PASSWORD_SHORT':
      return t('export.errors.passwordShort')
    case 'EXPORT_PASSWORD_ASCII':
      return t('export.errors.passwordAscii')
    case 'EXPORT_PASSWORD_WEAK':
      return t('export.errors.passwordWeak')
    case 'EXPORT_PASSWORD_MISMATCH':
      return t('export.errors.passwordMismatch')
    case 'EXPORT_PASSWORD_REUSED':
      return t('export.errors.passwordReused')
    case 'EXPORT_PLAIN_UNCONFIRMED':
      return t('export.errors.plainUnconfirmed')
    case 'EXPORT_AUDIT_SCOPE':
      return t('export.includeAuditHelp')
    case 'EXPORT_CANCELLED':
      return t('export.errors.cancelled')
    default:
      return t('errors.generic')
  }
}

export function textForError(error: unknown, t: (key: MessageKey) => string): string {
  if (error instanceof AppError) return errorText(error.code, t)
  return t('errors.generic')
}
