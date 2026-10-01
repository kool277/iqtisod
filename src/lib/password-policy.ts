import { ValidationError } from '../domain/errors'
import { LIMITS } from './limits'

export type PasswordContext = { email?: string | null; vaultName?: string | null }

let blocklist: Promise<Set<string>> | null = null

function loadBlocklist(): Promise<Set<string>> {
  blocklist ??= import('./common-passwords').then((module) => new Set(module.COMMON_PASSWORDS.split('\n')))
  blocklist.catch(() => {
    blocklist = null
  })
  return blocklist
}

/** Counts code points, so an emoji is one character, not two. */
export function assertPasswordLength(password: string): void {
  if (password.length > LIMITS.passwordMax * 2) throw new ValidationError('PASSWORD_LONG')
  const length = [...password].length
  if (length < LIMITS.passwordMin) throw new ValidationError('PASSWORD_SHORT')
  if (length > LIMITS.passwordMax) throw new ValidationError('PASSWORD_LONG')
}

function compact(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function isRepetitive(lower: string): boolean {
  if (new Set(lower).size <= 3) return true
  for (let unit = 1; unit <= 6; unit += 1) {
    if (lower.length % unit === 0 && lower.slice(0, unit).repeat(lower.length / unit) === lower) return true
  }
  const codes = [...lower].map((char) => char.codePointAt(0)!)
  const steps = codes.slice(1).map((code, index) => code - codes[index])
  return steps.every((step) => step === steps[0] && Math.abs(step) <= 1)
}

const SEQUENCES = ['0123456789012345678901234567890', 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnop', 'qwertyuiopasdfghjklzxcvbnmqwertyuiop', '1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9ol0p']

function isKeyboardRun(lower: string): boolean {
  const letters = lower.replace(/[^a-z0-9]/g, '')
  if (letters.length < LIMITS.passwordMin - 2) return false
  const reversed = [...letters].reverse().join('')
  return SEQUENCES.some((sequence) => sequence.includes(letters) || sequence.includes(reversed))
}

function baseWords(lower: string): string[] {
  const trimmed = lower.replace(/^[^a-z]+|[^a-z]+$/g, '')
  const withDigits = lower.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
  const words = [lower, trimmed, withDigits]
  for (let unit = 3; unit <= lower.length / 2; unit += 1) {
    if (lower.length % unit === 0 && lower.slice(0, unit).repeat(lower.length / unit) === lower) words.push(lower.slice(0, unit))
  }
  return words.filter((word) => word.length >= 6)
}

const LEET: Record<string, string> = { '0': 'o', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g', '@': 'a', $: 's', '+': 't' }

function deleet(text: string, one: 'i' | 'l'): string {
  return [...text].map((char) => (char === '1' || char === '!' || char === '|' ? one : (LEET[char] ?? char))).join('')
}

/** Drops leading and trailing digits and symbols, keeping look-alike characters inside the word. */
function core(text: string): string {
  return text.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')
}

/** The password plus its forms with separators removed and look-alike characters undone, e.g. P@ssw0rd2024! and letmein!letmein. */
function candidateWords(lower: string): string[] {
  const forms = new Set<string>()
  for (const base of [lower, compact(lower)]) {
    forms.add(base)
    for (const one of ['i', 'l'] as const) {
      forms.add(deleet(base, one))
      forms.add(deleet(core(base), one))
    }
  }
  const parts = lower.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (parts.length >= 2 && parts.every((part) => part === parts[0])) forms.add(parts[0])
  return [...forms].flatMap(baseWords)
}

function contextTokens(context: PasswordContext): string[] {
  const tokens: string[] = []
  const email = context.email?.trim().toLowerCase() ?? ''
  if (email) {
    tokens.push(compact(email))
    tokens.push(compact(email.split('@')[0] ?? ''))
  }
  if (context.vaultName) tokens.push(compact(context.vaultName))
  return tokens.filter((token) => token.length >= 4)
}

export function violatesContext(password: string, context: PasswordContext): boolean {
  const lower = password.toLowerCase()
  const forms = [compact(lower), compact(deleet(lower, 'i')), compact(deleet(lower, 'l'))]
  return contextTokens(context).some((token) => forms.some((form) => form.includes(token) && form.split(token).join('').length < 8))
}

export async function passwordProblem(password: string, context: PasswordContext = {}): Promise<string | null> {
  try {
    assertPasswordLength(password)
  } catch (error) {
    return error instanceof ValidationError ? error.code : 'PASSWORD_SHORT'
  }
  const lower = password.toLowerCase()
  if (isRepetitive(lower) || isKeyboardRun(lower)) return 'PASSWORD_COMMON'
  const common = await loadBlocklist()
  if (candidateWords(lower).some((word) => common.has(word))) return 'PASSWORD_COMMON'
  if (violatesContext(password, context)) return 'PASSWORD_CONTEXT'
  return null
}

export async function assertNewPassword(password: string, context: PasswordContext = {}): Promise<void> {
  const problem = await passwordProblem(password, context)
  if (problem) throw new ValidationError(problem)
}
