import { describe, expect, it } from 'vitest'
import { ValidationError } from '../../src/domain/errors'
import { csvCell } from '../../src/services/export/csv'
import { exportFileName, validateRequest, vaultSlug, type ExportRequest } from '../../src/services/export/options'
import {
  GENERATOR_ALPHABET,
  assertExportPassword,
  estimateBits,
  estimateStrength,
  generateExportPassword,
  passwordProblem,
} from '../../src/services/export/password'
import { excelDate, sheetName } from '../../src/services/export/xlsx'
import { counterRandom } from '../support/exports'

const base: ExportRequest = {
  formats: ['csv'],
  period: null,
  groupId: null,
  includeAudit: false,
  includeReceipts: false,
  protection: 'zip',
  password: 'KXQ7-M4TP-9WZR-H2CD',
  passwordConfirm: 'KXQ7-M4TP-9WZR-H2CD',
  locale: 'en',
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (error) {
    return error instanceof ValidationError ? error.code : String(error)
  }
}

describe('export passwords', () => {
  it('requires 14 printable ASCII characters that are not easy to guess', () => {
    expect(passwordProblem('Short-1a')).toBe('EXPORT_PASSWORD_SHORT')
    expect(passwordProblem('Oʻzbekcha-parol-2026')).toBe('EXPORT_PASSWORD_ASCII')
    expect(passwordProblem('пароль-для-экспорта')).toBe('EXPORT_PASSWORD_ASCII')
    expect(passwordProblem('tab\tinside-password')).toBe('EXPORT_PASSWORD_ASCII')
    expect(passwordProblem('aaaaaaaaaaaaaaaa')).toBe('EXPORT_PASSWORD_WEAK')
    expect(passwordProblem('abcdefghijklmnop')).toBe('EXPORT_PASSWORD_WEAK')
    expect(passwordProblem('password123456')).toBe('EXPORT_PASSWORD_WEAK')
    expect(passwordProblem('correct horse battery staple')).toBeNull()
    expect(passwordProblem('correct horse battery staple', 'correct horse battery stapel')).toBe('EXPORT_PASSWORD_MISMATCH')
    expect(codeOf(() => assertExportPassword('x'))).toBe('EXPORT_PASSWORD_SHORT')
  })

  it('grades strength by length, character set, repeats, and sequences', () => {
    expect(estimateStrength('')).toBe('weak')
    expect(estimateStrength('1234567890123456')).toBe('weak')
    expect(estimateStrength('qzmfkrwpxlbvnt')).toBe('fair')
    expect(estimateStrength('Tr0ub4dor&3-Xq9!')).toBe('strong')
    expect(estimateBits('aaaa')).toBeLessThan(estimateBits('azqm'))
    expect(estimateBits('abcd')).toBeLessThan(estimateBits('azqm'))
  })

  it('generates 120-bit passwords from an alphabet without look-alike characters', () => {
    expect(GENERATOR_ALPHABET).toHaveLength(32)
    expect(new Set(GENERATOR_ALPHABET).size).toBe(32)
    for (const confusing of 'IO01') expect(GENERATOR_ALPHABET).not.toContain(confusing)
    expect(Math.log2(GENERATOR_ALPHABET.length) * 24).toBe(120)
    const password = generateExportPassword()
    expect(password).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){5}$/)
    expect(passwordProblem(password)).toBeNull()
    expect(estimateStrength(password)).toBe('strong')
    expect(generateExportPassword(counterRandom(7))).toBe(generateExportPassword(counterRandom(7)))
    const seen = new Set(Array.from({ length: 50 }, () => generateExportPassword()))
    expect(seen.size).toBe(50)
  })
})

describe('export requests', () => {
  it('validates formats, confirmation, and passwords in the service', () => {
    expect(validateRequest(base).formats).toEqual(['csv'])
    expect(codeOf(() => validateRequest({ ...base, formats: [] }))).toBe('EXPORT_NO_FORMAT')
    expect(codeOf(() => validateRequest({ ...base, protection: 'none' }))).toBe('EXPORT_PLAIN_UNCONFIRMED')
    expect(codeOf(() => validateRequest({ ...base, protection: 'none', plainConfirmed: true }))).toBeNull()
    expect(codeOf(() => validateRequest({ ...base, password: 'weak', passwordConfirm: 'weak' }))).toBe('EXPORT_PASSWORD_SHORT')
    expect(codeOf(() => validateRequest({ ...base, passwordConfirm: 'different-but-long' }))).toBe('EXPORT_PASSWORD_MISMATCH')
    expect(validateRequest({ ...base, protection: 'sqlcipher', formats: ['csv', 'pdf'] }).formats).toEqual(['sqlite'])
    expect(validateRequest({ ...base, formats: ['pdf', 'csv', 'pdf'] }).formats).toEqual(['csv', 'pdf'])
    expect(validateRequest({ ...base, period: { from: '2026-12-31', to: '2026-10-01' } }).period).toEqual({ from: '2026-10-01', to: '2026-12-31' })
    expect(codeOf(() => validateRequest({ ...base, period: { from: '2026-02-30', to: '2026-03-01' } }))).toBe('DATE')
  })
})

describe('export file names', () => {
  it('normalises the vault name, keeps Cyrillic, and limits the length', () => {
    expect(vaultSlug('Home')).toBe('Home')
    expect(vaultSlug('Family budget 2026')).toBe('Family-budget-2026')
    expect(vaultSlug('Oila / Семья: "Бюджет"?')).toBe('Oila-Семья-Бюджет')
    expect(vaultSlug('a\u0000b\tc\nd')).toBe('a-b-c-d')
    expect(vaultSlug('  ...  ')).toBe('vault')
    expect(vaultSlug('')).toBe('vault')
    expect(vaultSlug('e\u0301cole')).toBe('\u00e9cole')
    expect(Array.from(vaultSlug('Ж'.repeat(80)))).toHaveLength(48)
    expect(exportFileName('Ledger Two', '2027-02-01', '-encrypted.zip')).toBe('jaybi-Ledger-Two-2027-02-01-encrypted.zip')
  })
})

describe('CSV cells', () => {
  it('neutralises every OWASP formula trigger, including LF and full-width characters', () => {
    const triggers = ['=SUM(A1)', '+1', '-2+3', '@cmd', '\tTAB', '\rCR', '\nLF', '＝1+1', '＋1', '－1', '＠SUM(1)']
    for (const value of triggers) expect(csvCell(value).replace(/^"|"$/g, '').startsWith("'"), JSON.stringify(value)).toBe(true)
    expect(csvCell('  =cmd')).toBe("'  =cmd")
    expect(csvCell(' leading space')).toBe('" leading space"')
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"')
    expect(csvCell('Oʻzbekcha — Ўзбекча')).toBe('Oʻzbekcha — Ўзбекча')
    expect(csvCell(-5)).toBe('-5')
    expect(csvCell(null)).toBe('')
    expect(csvCell(true)).toBe('true')
  })
})

describe('spreadsheet helpers', () => {
  it('builds UTC date-only values and valid, unique sheet names', () => {
    expect(excelDate('2026-09-01').toISOString()).toBe('2026-09-01T00:00:00.000Z')
    const used = new Set<string>()
    expect(sheetName('Records', used)).toBe('Records')
    expect(sheetName('records', used)).toBe('records (2)')
    expect(sheetName('a/b\\c?d*e[f]g:h', used)).toBe('a b c d e f g h')
    expect(sheetName('x'.repeat(40), used)).toHaveLength(31)
    expect(sheetName("'quoted'", used)).toBe('quoted')
  })
})
