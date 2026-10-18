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

/**
 * A per-person-keys vault that fails a check that blocks it (docs/design/v2.0-key-redesign.md, 3.8): nothing from it
 * is used and no session opens.
 */
export type KeysBlock =
  | 'KEYS_FOUNDER_MISMATCH'
  | 'KEYS_HEADER_INVALID'
  | 'KEYS_ROSTER_BROKEN'
  | 'KEYS_ROSTER_ROLLBACK'
  | 'KEYS_REMOVED'
  | 'KEYS_EPOCH_MISMATCH'

export class KeysBlockedError extends AppError {
  constructor(
    code: KeysBlock,
    /** For a rollback: the version this device saw and the version the vault has. */
    readonly versions?: { seen: number; current: number },
  ) {
    super(code)
    this.name = 'KeysBlockedError'
  }
}

/**
 * A backup with per-person keys whose signed roster is older than the newest this browser has seen (design 4.10). It
 * replaces the vault only once an admin chooses so; the people removed since can be taken out again.
 */
export class OlderBackupError extends AppError {
  constructor(
    readonly older: {
      /** The newest roster version this browser has seen, and the backup's. */
      seen: number
      version: number
      /** People removed since, who would be taken out again; null when this browser cannot tell. */
      removals: { id: string; email: string }[] | null
    },
  ) {
    super('BACKUP_OLDER')
    this.name = 'OlderBackupError'
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
