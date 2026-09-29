import { describe, expect, it } from 'vitest'
import { ValidationError } from '../../src/domain/errors'
import { assertEmail, isEmail, normalizeEmail } from '../../src/lib/email'
import { LIMITS } from '../../src/lib/limits'

function timed(fn: () => unknown): number {
  const start = performance.now()
  fn()
  return performance.now() - start
}

describe('normalizeEmail', () => {
  it('trims and lower-cases', () => {
    expect(normalizeEmail('  Ali.Valiyev@Example.UZ \n')).toBe('ali.valiyev@example.uz')
    expect(normalizeEmail('a@b.co')).toBe('a@b.co')
    expect(normalizeEmail('ЖАСУР@МИСОЛ.УЗ')).toBe('жасур@мисол.уз')
  })
})

describe('isEmail', () => {
  it('accepts ordinary addresses', () => {
    for (const email of ['a@b.co', 'ali.valiyev@example.uz', 'user+tag@sub.example.co.uk', 'o\'brien@example.ie', 'жасур@мисол.уз', '1@2.3']) {
      expect(isEmail(email), email).toBe(true)
    }
  })

  it('refuses malformed addresses', () => {
    for (const email of [
      '',
      'plain',
      'a@b',
      '@b.co',
      'a@',
      'a@@b.co',
      'a@b@c.co',
      'a@.b.co',
      'a@b..co',
      'a@b.co.',
      'a b@c.co',
      'a@b c.co',
      ' a@b.co',
      'a@b.co ',
      'a@b.co\n',
      'a\t@b.co',
    ]) {
      expect(isEmail(email), JSON.stringify(email)).toBe(false)
    }
  })

  it('caps the length at 254 characters', () => {
    const make = (length: number) => `${'a'.repeat(length - '@example.com'.length)}@example.com`
    expect(LIMITS.emailChars).toBe(254)
    expect(isEmail(make(254))).toBe(true)
    expect(isEmail(make(255))).toBe(false)
    expect(() => assertEmail(make(255))).toThrow('EMAIL')
  })

  it('answers quickly for pathological input', () => {
    const inputs = [
      `a@${'a.'.repeat(50_000)}!`,
      '@'.repeat(100_000),
      `${'a'.repeat(100_000)}@`,
      `a@${'a'.repeat(100_000)}.`,
      `a@${'.a'.repeat(50_000)}`,
      `a@${'a.'.repeat(125)}`,
      `${'a@'.repeat(127)}`,
      `a@${'a'.repeat(250)}`,
      `${'a.'.repeat(60)}@${'b.'.repeat(60)}`,
    ]
    for (const input of inputs) {
      isEmail(input)
      expect(timed(() => isEmail(input)), input.slice(0, 20)).toBeLessThan(50)
      expect(isEmail(input)).toBe(false)
    }
  })
})

describe('assertEmail', () => {
  it('throws a ValidationError with code EMAIL', () => {
    expect(() => assertEmail('nope')).toThrow(ValidationError)
    expect(() => assertEmail('nope')).toThrow('EMAIL')
    expect(() => assertEmail('ok@example.com')).not.toThrow()
  })
})
