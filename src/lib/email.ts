import { ValidationError } from '../domain/errors'
import { LIMITS } from './limits'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function isEmail(email: string): boolean {
  return email.length <= LIMITS.emailChars && EMAIL_PATTERN.test(email)
}

export function assertEmail(email: string): void {
  if (!isEmail(email)) throw new ValidationError('EMAIL')
}
