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
    default:
      return t('errors.generic')
  }
}

export function textForError(error: unknown, t: (key: MessageKey) => string): string {
  if (error instanceof AppError) return errorText(error.code, t)
  return t('errors.generic')
}
