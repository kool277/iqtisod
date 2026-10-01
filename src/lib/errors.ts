import type { MessageKey, Messages } from '../i18n'
import { AppError } from '../domain/errors'
import { en } from '../i18n/en'

type SafeErrorKey = keyof Messages['safeErrors']

const SAFE_ERROR_CODES: readonly SafeErrorKey[] = [
  'SAFES_LOCKED',
  'SAFES_NOT_SET_UP',
  'SAFES_ALREADY_SET_UP',
  'SAFES_STALE',
  'MUST_CHANGE_PASSWORD',
  'REAUTH_REQUIRED',
  'NO_RECOVERY_CODE',
  'RECOVERY_CODE',
  'SAFE_LIMIT',
  'ITEM_LIMIT',
  'SAFE_NOT_EMPTY',
  'LAST_SAFE',
  'CONFIRM_NAME',
  'CONFIRM_RESET',
  'SAFE_ARCHIVED',
  'SAFE_CLOSED',
  'SAFE_NOT_FOUND',
  'ITEM_NOT_FOUND',
  'ITEM_CONFLICT',
  'CARD_NUMBER',
  'CARD_EXPIRY',
  'CVV',
  'TOO_LONG',
  'SAME_PASSWORD',
  'USE_ACCOUNT',
  'CUSTOM_DAYS',
  'DATE',
  'REMIND_DAYS',
  'URL',
]

function isSafeErrorKey(code: string): code is SafeErrorKey {
  return (SAFE_ERROR_CODES as readonly string[]).includes(code)
}

type SecurityErrorKey = keyof Messages['securityErrors']

function isSecurityErrorKey(code: string): code is SecurityErrorKey {
  return Object.hasOwn(en.securityErrors, code)
}

type PeopleErrorKey = keyof Messages['people']['errors']

const PEOPLE_ERROR_CODES: readonly PeopleErrorKey[] = ['USER_SUSPENDED', 'USER_FORMER', 'NOT_SUSPENDED', 'USER_CODE_OPEN', 'REASSIGN_TARGET', 'CONFIRM_EMAIL']

function isPeopleErrorKey(code: string): code is PeopleErrorKey {
  return (PEOPLE_ERROR_CODES as readonly string[]).includes(code)
}

export function errorText(code: string, t: (key: MessageKey) => string): string {
  if (isSafeErrorKey(code)) return t(`safeErrors.${code}`)
  if (isSecurityErrorKey(code)) return t(`securityErrors.${code}`)
  // Only the People pages raise these, and they load the `people` strings first.
  if (isPeopleErrorKey(code)) return t(`people.errors.${code}`)
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
    case 'SCHEMA_UNKNOWN':
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
    case 'EXPORT_PASSWORD_ZIP_WEAK':
      return t('export.errors.passwordZipWeak')
    case 'EXPORT_PASSWORD_COMMON':
      return t('export.errors.passwordCommon')
    case 'EXPORT_PASSWORD_CONTEXT':
      return t('export.errors.passwordContext')
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
