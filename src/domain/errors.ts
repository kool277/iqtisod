export class AppError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'AppError'
  }
}

export class AuthError extends AppError {
  constructor() {
    super('BAD_CREDENTIALS')
    this.name = 'AuthError'
  }
}

export class ForbiddenError extends AppError {
  constructor() {
    super('FORBIDDEN')
    this.name = 'ForbiddenError'
  }
}

export class ValidationError extends AppError {
  constructor(code: string) {
    super(code)
    this.name = 'ValidationError'
  }
}

export class FormatTooNewError extends AppError {
  constructor() {
    super('FORMAT_TOO_NEW')
    this.name = 'FormatTooNewError'
  }
}

export class CorruptRecordError extends AppError {
  constructor() {
    super('RECORD_INVALID')
    this.name = 'CorruptRecordError'
  }
}

export class ConflictError extends AppError {
  constructor() {
    super('VAULT_CONFLICT')
    this.name = 'ConflictError'
  }
}

export class VaultInUseError extends AppError {
  constructor() {
    super('VAULT_IN_USE')
    this.name = 'VaultInUseError'
  }
}

export class MigrationError extends AppError {
  constructor(
    readonly version: number,
    readonly detail: string,
  ) {
    super('MIGRATION_FAILED')
    this.name = 'MigrationError'
  }
}

export type SafeErrorCode =
  | 'SAFES_LOCKED'
  | 'SAFES_NOT_SET_UP'
  | 'SAFES_ALREADY_SET_UP'
  | 'SAFES_STALE'
  | 'MUST_CHANGE_PASSWORD'
  | 'REAUTH_REQUIRED'
  | 'NO_RECOVERY_CODE'
  | 'SAFE_LIMIT'
  | 'ITEM_LIMIT'
  | 'SAFE_NOT_EMPTY'
  | 'LAST_SAFE'
  | 'CONFIRM_NAME'
  | 'CONFIRM_RESET'
  | 'SAFE_ARCHIVED'
  | 'SAFE_CLOSED'
  | 'SAFE_NOT_FOUND'
  | 'ITEM_NOT_FOUND'
  | 'ITEM_CONFLICT'

export class SafeError extends AppError {
  constructor(code: SafeErrorCode) {
    super(code)
    this.name = 'SafeError'
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE/i.test(error.message)
}
