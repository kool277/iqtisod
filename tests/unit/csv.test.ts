import { afterEach, describe, expect, it } from 'vitest'
import type { OpenVault } from '../../src/domain/types'
import { unlockVault } from '../../src/services/auth.service'
import { parseBackup } from '../../src/services/backup.service'
import { csvCell, exportTransactionsCsv } from '../../src/services/export.service'
import { fixtureByPath } from '../support/fixtures'

const TRIGGERS = ['=', '+', '-', '@', '\t', '\r', '\uFF1D', '\uFF0B', '\uFF0D', '\uFF20']
const DANGEROUS_START = /^\s*[=+\-@\t\r\uFF1D\uFF0B\uFF0D\uFF20]/

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"'
        index += 1
      } else if (char === '"') {
        quoted = false
      } else {
        cell += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(cell)
      cell = ''
    } else if (char === '\r' && text[index + 1] === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      index += 1
    } else {
      cell += char
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

describe('csvCell', () => {
  it('prefixes a quote to text that a spreadsheet would run as a formula', () => {
    for (const trigger of TRIGGERS) {
      const text = `${trigger}HYPERLINK("http://evil.example","x")`
      const cell = csvCell(text)
      const [[parsed]] = parseCsv(cell)
      expect(parsed, JSON.stringify(trigger)).toBe(`'${text}`)
    }
  })

  it('also catches triggers hidden behind leading whitespace', () => {
    for (const lead of [' ', '   ', '\t', '\n', '\u00a0', '\u3000', ' \r\n ']) {
      for (const trigger of ['=', '+', '-', '@', '\uFF1D', '\uFF20']) {
        const text = `${lead}${trigger}1+1`
        const [[parsed]] = parseCsv(csvCell(text))
        expect(parsed, JSON.stringify(text)).toBe(`'${text}`)
      }
    }
  })

  it('quotes cells that need it after neutralising', () => {
    expect(csvCell('=1,2')).toBe(`"'=1,2"`)
    expect(csvCell('=A1&"x"')).toBe(`"'=A1&""x"""`)
    expect(csvCell('\r=1')).toBe(`"'\r=1"`)
    expect(csvCell('\t=1')).toBe(`'\t=1`)
    expect(csvCell(' =1')).toBe(`' =1`)
  })

  it('leaves ordinary text and numbers alone', () => {
    const plain = ['Groceries', 'Oʻzbekiston', 'Коммунал', 'a-b', 'x=y', 'user@example.com', '100', '1+1', 'Tea & cake', '(555) 123']
    for (const text of plain) expect(csvCell(text), text).toBe(text)
    expect(csvCell(-5)).toBe('-5')
    expect(csvCell(-0.5)).toBe('-0.5')
    expect(csvCell(42)).toBe('42')
    expect(csvCell(0)).toBe('0')
    expect(csvCell(null)).toBe('')
    expect(csvCell(false)).toBe('false')
  })

  it('quotes commas, quotes, line breaks and surrounding spaces', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('two\nlines')).toBe('"two\nlines"')
    expect(csvCell(' padded ')).toBe('" padded "')
    expect(csvCell('')).toBe('')
  })

  it('round-trips through a CSV parser', () => {
    const samples = ['plain', 'a,b', 'q"uote', 'multi\r\nline', ' lead', 'trail ', '=cmd|" /C calc"!A0', '＠SUM(1)']
    const line = samples.map((sample) => csvCell(sample)).join(',')
    const [parsed] = parseCsv(line)
    expect(parsed).toEqual(samples.map((sample) => (DANGEROUS_START.test(sample) ? `'${sample}` : sample)))
  })
})

describe('exportTransactionsCsv', () => {
  const fixture = fixtureByPath('v2/ledger-v2')
  const open: OpenVault[] = []

  afterEach(() => {
    for (const vault of open.splice(0)) vault.db.close()
  })

  it('neutralises formulas in every user-controlled column', async () => {
    const admin = fixture.expected.users.find((user) => user.role === 'Admin')!
    const vault = await unlockVault(parseBackup(fixture.text).record, admin.email, admin.password)
    open.push(vault)
    const ids = vault.db.query('SELECT id FROM transactions ORDER BY id').map((row) => String(row.id))
    const payloads = ['=HYPERLINK("http://evil","x")', '+1+1', '-2-2', '@SUM(1)', '\t=1', '\r=1', '＝1+1', '＋1', '－1', '＠A1', '  =1']
    payloads.forEach((payload, index) => {
      vault.db.exec('UPDATE transactions SET notes = ? WHERE id = ?', [payload, ids[index % ids.length]])
    })
    vault.db.exec("UPDATE groups SET name = '=GROUP()' WHERE id = (SELECT MIN(id) FROM groups)")
    vault.db.exec("UPDATE categories SET name_en = '@CATEGORY' WHERE id = (SELECT category_id FROM transactions ORDER BY id LIMIT 1)")

    const rows = parseCsv(exportTransactionsCsv(vault).replace(/^\ufeff/, ''))
    const [header, ...body] = rows
    expect(body).toHaveLength(ids.length)
    const notes = header.indexOf('notes')
    const exportedNotes = new Set(body.map((row) => row[notes]))
    for (const payload of payloads.slice(0, ids.length)) expect(exportedNotes, JSON.stringify(payload)).toContain(`'${payload}`)
    expect(body.some((row) => row[header.indexOf('group')] === "'=GROUP()")).toBe(true)
    expect(body.some((row) => row[header.indexOf('category')] === "'@CATEGORY")).toBe(true)
    for (const row of body) {
      expect(row).toHaveLength(header.length)
      for (const cell of row) {
        if (DANGEROUS_START.test(cell)) expect(cell, JSON.stringify(cell)).toMatch(/^-?\d+(\.\d+)?$/)
      }
    }
  })
})
