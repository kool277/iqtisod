import { describe, expect, it } from 'vitest'
import { AppError, ValidationError } from '../../src/domain/errors'
import { COMMON_PASSWORDS } from '../../src/lib/common-passwords'
import { LIMITS } from '../../src/lib/limits'
import { assertNewPassword, assertPasswordLength, passwordProblem, violatesContext } from '../../src/lib/password-policy'

async function rejection(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise
    return null
  } catch (error) {
    return error instanceof AppError ? error.code : 'unexpected'
  }
}

const GOOD = 'violet tractor sings quietly'

describe('assertPasswordLength', () => {
  it('requires 12 to 256 characters', () => {
    expect(LIMITS.passwordMin).toBe(12)
    expect(LIMITS.passwordMax).toBe(256)
    expect(() => assertPasswordLength('x'.repeat(11))).toThrow(ValidationError)
    expect(() => assertPasswordLength('')).toThrow('PASSWORD_SHORT')
    expect(() => assertPasswordLength('x'.repeat(11))).toThrow('PASSWORD_SHORT')
    expect(() => assertPasswordLength('x'.repeat(12))).not.toThrow()
    expect(() => assertPasswordLength('x'.repeat(256))).not.toThrow()
    expect(() => assertPasswordLength('x'.repeat(257))).toThrow('PASSWORD_LONG')
  })
})

describe('passwordProblem', () => {
  it('reports length problems first', async () => {
    expect(await passwordProblem('')).toBe('PASSWORD_SHORT')
    expect(await passwordProblem('Kx7!mQ2@pL9')).toBe('PASSWORD_SHORT')
    expect(await passwordProblem('Kx7!mQ2@pL9#')).toBeNull()
    expect(await passwordProblem(`${GOOD} `.repeat(10).slice(0, 257))).toBe('PASSWORD_LONG')
    expect(await passwordProblem('password'.repeat(40))).toBe('PASSWORD_LONG')
  })

  it('accepts passphrases and long random passwords', async () => {
    for (const password of [GOOD, 'Qalam, choynak va yashil olma', 'Kx7!mQ2@pL9#vR4$', 'orange-bicycle-thunder-lamp', `${GOOD} `.repeat(9).slice(0, 256)]) {
      expect(await passwordProblem(password), password).toBeNull()
    }
  })

  it('counts BMP letters such as Cyrillic and Uzbek one character each', async () => {
    expect(await passwordProblem('Қалампир чой')).toBeNull()
    expect(await passwordProblem('Қалампир чо')).toBe('PASSWORD_SHORT')
    expect(await passwordProblem('Oʻrmon gʻildi')).toBeNull()
    expect(await passwordProblem('Жёлтый трамвай поёт тихо')).toBeNull()
  })

  it('counts astral characters (emoji) as one character each', async () => {
    expect(await passwordProblem('😀😁😂🤣😃😄')).toBe('PASSWORD_SHORT')
    expect(await passwordProblem('😀😁😂🤣😃😄😅😆🤩😉😊😋')).toBeNull()
  })

  it('refuses passwords from the common-password list, ignoring case and padding', async () => {
    const cases = [
      'password1234',
      'PASSWORD1234',
      'Password1234',
      '  password  ',
      'Password123!',
      '!!sunshine!!',
      'Football2026',
      '123456789012',
      'monkeymonkey',
      'DragonDragon',
    ]
    for (const password of cases) expect(await passwordProblem(password), password).toBe('PASSWORD_COMMON')
  })

  it('refuses common passwords hidden by look-alike characters, separators or repeats', async () => {
    const cases = ['P@ssw0rd2024!', 'p4$$w0rd!2025', 'P-a-s-s-w-o-r-d-1', 'letmein!letmein', 'LetMeIn LetMeIn', 'l3tm31n-l3tm31n', 'iL0v3y0u!!!!', 'sunshine.sunshine.sunshine', 'Summer2026Summer', 'dragon1dragon2dragon']
    for (const password of cases) expect(await passwordProblem(password), password).toBe('PASSWORD_COMMON')
  })

  it('refuses context words hidden by look-alike characters', async () => {
    expect(await passwordProblem('J@surK@rim0v!24', { email: 'jasur.karimov@example.com' })).toBe('PASSWORD_CONTEXT')
  })

  it('refuses repetitive and sequential passwords', async () => {
    const cases = [
      'aaaaaaaaaaaa',
      'abababababab',
      'abcabcabcabc',
      'xyzxyzxyzxyz',
      'abcdefghijkl',
      'lkjihgfedcba',
      'qwertyuiopas',
      'QWERTYUIOPASDF',
      '1qaz2wsx3edc4rfv',
      '98765432109876',
      'ЖЖЖЖЖЖЖЖЖЖЖЖ',
      'абвгдежзийкл',
      'a1a1a1a1a1a1',
    ]
    for (const password of cases) expect(await passwordProblem(password), password).toBe('PASSWORD_COMMON')
  })

  it('refuses passwords built from the email or vault name', async () => {
    const context = { email: 'Jasur.Karimov@Example.com', vaultName: 'Oila Budget' }
    expect(await passwordProblem('JasurKarimov!2024', context)).toBe('PASSWORD_CONTEXT')
    expect(await passwordProblem('jasur.karimov@example.com', context)).toBe('PASSWORD_CONTEXT')
    expect(await passwordProblem('OilaBudget2026!', context)).toBe('PASSWORD_CONTEXT')
    expect(await passwordProblem('  oila-budget-99  ', context)).toBe('PASSWORD_CONTEXT')
    expect(await passwordProblem('JasurKarimov!2024')).toBeNull()
    expect(await passwordProblem('JasurKarimov!2024', { email: null, vaultName: null })).toBeNull()
  })

  it('allows the email or vault name inside an otherwise strong passphrase', async () => {
    const context = { email: 'jasur@example.com', vaultName: 'Oila' }
    expect(await passwordProblem('jasur loves green tea mornings', context)).toBeNull()
    expect(await passwordProblem('oila tractor sings quietly', context)).toBeNull()
  })

  it('ignores context tokens shorter than four characters', async () => {
    expect(violatesContext('abc!!!!!!!!!', { email: 'abc@x.io' })).toBe(false)
    expect(violatesContext('uzbekvault42', { vaultName: 'Uzbek Vault' })).toBe(true)
    expect(violatesContext('uzbekvault42', { vaultName: 'Uz' })).toBe(false)
  })
})

describe('assertNewPassword', () => {
  it('throws a ValidationError carrying the problem code', async () => {
    await expect(assertNewPassword('short')).rejects.toBeInstanceOf(ValidationError)
    expect(await rejection(assertNewPassword('short'))).toBe('PASSWORD_SHORT')
    expect(await rejection(assertNewPassword('x'.repeat(300)))).toBe('PASSWORD_LONG')
    expect(await rejection(assertNewPassword('password1234'))).toBe('PASSWORD_COMMON')
    expect(await rejection(assertNewPassword('ali.valiyev99', { email: 'ali.valiyev@x.uz' }))).toBe('PASSWORD_CONTEXT')
    expect(await rejection(assertNewPassword(GOOD, { email: 'ali@x.uz', vaultName: 'Home' }))).toBeNull()
  })
})

describe('COMMON_PASSWORDS', () => {
  it('holds lower-case, trimmed entries of at least six characters', () => {
    const entries = COMMON_PASSWORDS.split('\n')
    expect(entries.length).toBeGreaterThan(5000)
    expect(new Set(entries).size).toBe(entries.length)
    for (const entry of entries) {
      expect(entry.length, entry).toBeGreaterThanOrEqual(6)
      expect(entry, entry).toBe(entry.toLowerCase())
      expect(entry, entry).toBe(entry.trim())
    }
    expect(entries).toContain('password')
    expect(entries).toContain('qwertyuiop')
  })
})
