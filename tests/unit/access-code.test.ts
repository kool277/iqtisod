import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppError, ValidationError } from '../../src/domain/errors'
import { ACCESS_CODE_BITS, ACCESS_CODE_BYTES, generateAccessCode, normalizeAccessCode } from '../../src/lib/access-code'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CHECK_SYMBOLS = `${CROCKFORD}*~$=U`

function codeOf(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (error) {
    return error instanceof AppError ? error.code : 'unexpected'
  }
}

function valueOf(data: string): bigint {
  let value = 0n
  for (const char of data) value = (value << 5n) | BigInt(CROCKFORD.indexOf(char))
  return value
}

function withRandomBytes(fill: (bytes: Uint8Array) => void): Uint8Array[] {
  const seen: Uint8Array[] = []
  vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
    const bytes = array as unknown as Uint8Array
    fill(bytes)
    seen.push(bytes)
    return array
  })
  return seen
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('generateAccessCode', () => {
  it('uses 135 random bits: 27 Crockford characters and one mod-37 check character', () => {
    expect(ACCESS_CODE_BITS).toBe(135)
    expect(ACCESS_CODE_BYTES * 8 - 1).toBe(ACCESS_CODE_BITS)
    for (let round = 0; round < 50; round += 1) {
      const { canonical, display } = generateAccessCode()
      expect(canonical).toHaveLength(28)
      expect(canonical.slice(0, 27)).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{27}$/)
      expect(CHECK_SYMBOLS).toContain(canonical[27])
      expect(canonical[27]).toBe(CHECK_SYMBOLS[Number(valueOf(canonical.slice(0, 27)) % 37n)])
      expect(display).toMatch(/^[0-9A-Z*~$=]{4}(-[0-9A-Z*~$=]{4}){6}$/)
      expect(display.replace(/-/g, '')).toBe(canonical)
    }
  })

  it('produces distinct codes', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateAccessCode().canonical))
    expect(codes.size).toBe(200)
  })

  it('encodes the random bytes exactly, clearing the top bit, and wipes them afterwards', () => {
    const seen = withRandomBytes((bytes) => bytes.fill(0xff))
    const max = generateAccessCode()
    const expectedValue = (1n << 135n) - 1n
    expect(max.canonical).toBe(`${'Z'.repeat(27)}${CHECK_SYMBOLS[Number(expectedValue % 37n)]}`)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toHaveLength(ACCESS_CODE_BYTES)
    expect([...seen[0]].every((byte) => byte === 0)).toBe(true)

    vi.restoreAllMocks()
    withRandomBytes((bytes) => bytes.fill(0))
    expect(generateAccessCode()).toEqual({ canonical: '0'.repeat(28), display: '0000-0000-0000-0000-0000-0000-0000' })
  })

  it('round-trips through normalizeAccessCode', () => {
    for (let round = 0; round < 50; round += 1) {
      const { canonical, display } = generateAccessCode()
      expect(normalizeAccessCode(display)).toBe(canonical)
      expect(normalizeAccessCode(canonical)).toBe(canonical)
    }
  })
})

describe('normalizeAccessCode', () => {
  const { canonical, display } = generateAccessCode()

  it('ignores case, dashes and whitespace', () => {
    expect(normalizeAccessCode(display.toLowerCase())).toBe(canonical)
    expect(normalizeAccessCode(display.replace(/-/g, ' '))).toBe(canonical)
    expect(normalizeAccessCode(`  ${display.replace(/-/g, ' \t ')}\n`)).toBe(canonical)
    expect(normalizeAccessCode(canonical.split('').join('-'))).toBe(canonical)
  })

  it('maps the Crockford look-alikes O to 0 and I/L to 1', () => {
    withRandomBytes((bytes) => bytes.fill(0))
    const zeros = generateAccessCode().canonical
    expect(normalizeAccessCode('O'.repeat(28))).toBe(zeros)
    expect(normalizeAccessCode('o'.repeat(28))).toBe(zeros)

    const ones = '1'.repeat(27)
    const code = `${ones}${CHECK_SYMBOLS[Number(valueOf(ones) % 37n)]}`
    const typed = code.slice(0, 27).replace(/1/g, (_, index: number) => ['I', 'L', 'i', 'l'][index % 4]) + code[27]
    expect(normalizeAccessCode(typed)).toBe(code)
  })

  it('rejects the wrong length', () => {
    expect(codeOf(() => normalizeAccessCode(''))).toBe('INVITE_CODE')
    expect(codeOf(() => normalizeAccessCode(canonical.slice(0, 27)))).toBe('INVITE_CODE')
    expect(codeOf(() => normalizeAccessCode(canonical.slice(1)))).toBe('INVITE_CODE')
    expect(codeOf(() => normalizeAccessCode(`${canonical}0`))).toBe('INVITE_CODE')
    expect(codeOf(() => normalizeAccessCode(`${display}-0000`))).toBe('INVITE_CODE')
  })

  it('rejects oversized input before doing any work', () => {
    expect(display).toHaveLength(34)
    expect(codeOf(() => normalizeAccessCode(`${display}${' '.repeat(94)}`))).toBeNull()
    expect(codeOf(() => normalizeAccessCode(`${display}${' '.repeat(95)}`))).toBe('INVITE_CODE')
    expect(codeOf(() => normalizeAccessCode('-'.repeat(1_000_000)))).toBe('INVITE_CODE')
  })

  it('rejects characters outside the Crockford alphabet in the data part', () => {
    for (const bad of ['U', '*', '~', '$', '=', '!', '_', 'Ж']) {
      expect(codeOf(() => normalizeAccessCode(`${bad}${canonical.slice(1)}`)), bad).toBe('INVITE_CODE')
    }
  })

  it('catches every single-character typo', () => {
    for (let position = 0; position < 28; position += 1) {
      const alphabet = position < 27 ? CROCKFORD : CHECK_SYMBOLS
      for (const char of alphabet) {
        if (char === canonical[position]) continue
        const typo = `${canonical.slice(0, position)}${char}${canonical.slice(position + 1)}`
        expect(codeOf(() => normalizeAccessCode(typo)), `${position}:${char}`).toBe('INVITE_CODE')
      }
    }
  })

  it('catches every adjacent transposition in the data part', () => {
    for (let round = 0; round < 20; round += 1) {
      const code = generateAccessCode().canonical
      for (let position = 0; position < 26; position += 1) {
        if (code[position] === code[position + 1]) continue
        const swapped = `${code.slice(0, position)}${code[position + 1]}${code[position]}${code.slice(position + 2)}`
        expect(codeOf(() => normalizeAccessCode(swapped)), `${code}@${position}`).toBe('INVITE_CODE')
      }
    }
  })

  it('throws a ValidationError', () => {
    expect(() => normalizeAccessCode('nope')).toThrow(ValidationError)
  })
})
