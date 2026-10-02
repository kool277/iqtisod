import { afterEach, describe, expect, it } from 'vitest'
import type { OpenVault } from '../../src/domain/types'
import { unlockVault } from '../../src/services/auth.service'
import { parseBackup } from '../../src/services/backup.service'
import { buildTransactionsCsv, csvCell } from '../../src/services/export/csv'
import { blobText, datasetFor } from '../support/exports'
import { fixtureByPath } from '../support/fixtures'

const TRIGGERS = ['=', '+', '-', '@', '\t', '\r', '\uFF1D', '\uFF0B', '\uFF0D', '\uFF20']
const DANGEROUS_START = /^\s*[=+\-@\t\r\uFF1D\uFF0B\uFF0D\uFF20]/
/** Anywhere a spreadsheet that splits on `;`, tab or line breaks would start a cell with a formula. */
const EXPOSED = /(?:^|[;\t\r\n])[^\S\t\r\n]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/
const SEPARATOR_PAYLOADS = ['x;=1+1', 'ok;@SUM(A1:A9)', "Lunch;=cmd|' /C calc'!A0", 'a\t=1+1', 'a; \u00a0+1', 'rent;\uFF1D1', 'two\r\n-1+1']

function unguarded(cell: string): string {
  return cell.replace(/(^\s*|[;\t\r\n][^\S\t\r\n]*)'/g, '$1')
}

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
        expect(parsed.startsWith("'"), JSON.stringify(text)).toBe(true)
        expect(EXPOSED.test(parsed), JSON.stringify(parsed)).toBe(false)
      }
    }
  })

  it('quotes every neutralised cell', () => {
    expect(csvCell('=1,2')).toBe(`"'=1,2"`)
    expect(csvCell('=A1&"x"')).toBe(`"'=A1&""x"""`)
    expect(csvCell('\r=1')).toBe(`"'\r'=1"`)
    expect(csvCell('\t=1')).toBe(`"'\t'=1"`)
    expect(csvCell(' =1')).toBe(`"' =1"`)
  })

  it('guards formulas that start after a semicolon, tab or line break', () => {
    expect(csvCell('x;=1+1')).toBe(`"x;'=1+1"`)
    expect(csvCell("Lunch;=cmd|' /C calc'!A0")).toBe(`"Lunch;'=cmd|' /C calc'!A0"`)
    expect(csvCell('a\t=1+1')).toBe(`"a\t'=1+1"`)
    expect(csvCell('a; =1')).toBe(`"a; '=1"`)
    for (const payload of SEPARATOR_PAYLOADS) {
      const [[parsed]] = parseCsv(csvCell(payload))
      expect(EXPOSED.test(parsed), JSON.stringify(parsed)).toBe(false)
      for (const piece of parsed.split(/[;\t\r\n]/)) expect(DANGEROUS_START.test(piece), JSON.stringify(piece)).toBe(false)
      expect(unguarded(parsed)).toBe(payload)
    }
    expect(csvCell('a;b, -c')).toBe('"a;b, -c"')
    expect(csvCell('x=y;z')).toBe('"x=y;z"')
  })

  it('quotes ordinary text without changing it, and leaves numbers bare', () => {
    const plain = ['Groceries', 'Oʻzbekiston', 'Коммунал', 'a-b', 'x=y', 'user@example.com', '100', '1+1', 'Tea & cake', '(555) 123', 'a;b']
    for (const text of plain) expect(csvCell(text), text).toBe(`"${text}"`)
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
    expect(csvCell('')).toBe('""')
  })

  it('round-trips through a CSV parser', () => {
    const samples = ['plain', 'a,b', 'q"uote', 'multi\r\nline', ' lead', 'trail ', '=cmd|" /C calc"!A0', '＠SUM(1)']
    const line = samples.map((sample) => csvCell(sample)).join(',')
    const [parsed] = parseCsv(line)
    expect(parsed.map(unguarded)).toEqual(samples)
    for (const cell of parsed) expect(EXPOSED.test(cell), JSON.stringify(cell)).toBe(false)
  })
})

describe('buildTransactionsCsv', () => {
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

    const rows = parseCsv((await blobText(await buildTransactionsCsv(datasetFor(vault)))).replace(/^\ufeff/, ''))
    const [header, ...body] = rows
    expect(body).toHaveLength(ids.length)
    const notes = header.indexOf('notes')
    const exportedNotes = new Set(body.map((row) => row[notes]))
    const unguardedNotes = new Set([...exportedNotes].map(unguarded))
    for (const payload of payloads.slice(0, ids.length)) expect(unguardedNotes, JSON.stringify(payload)).toContain(payload)
    expect(body.some((row) => row[header.indexOf('group')] === "'=GROUP()")).toBe(true)
    expect(body.some((row) => row[header.indexOf('category')] === "'@CATEGORY")).toBe(true)
    for (const row of body) {
      expect(row).toHaveLength(header.length)
      for (const cell of row) {
        if (DANGEROUS_START.test(cell)) expect(cell, JSON.stringify(cell)).toMatch(/^-?\d+(\.\d+)?$/)
        else expect(EXPOSED.test(cell), JSON.stringify(cell)).toBe(false)
      }
    }
  })

  it('keeps semicolon, tab and DDE payloads in one guarded cell for spreadsheets that split on them', async () => {
    const admin = fixture.expected.users.find((user) => user.role === 'Admin')!
    const vault = await unlockVault(parseBackup(fixture.text).record, admin.email, admin.password)
    open.push(vault)
    const ids = vault.db.query('SELECT id FROM transactions ORDER BY id').map((row) => String(row.id))
    SEPARATOR_PAYLOADS.forEach((payload, index) => {
      vault.db.exec('UPDATE transactions SET notes = ? WHERE id = ?', [payload, ids[index]])
    })
    vault.db.exec("UPDATE groups SET name = 'Home;=1+1'")
    vault.db.exec("UPDATE categories SET name_en = 'Food\t@SUM(1)'")

    const text = (await blobText(await buildTransactionsCsv(datasetFor(vault)))).replace(/^\ufeff/, '')
    const [header, ...body] = parseCsv(text)
    expect(body).toHaveLength(ids.length)
    const notes = new Set(body.map((row) => unguarded(row[header.indexOf('notes')])))
    for (const payload of SEPARATOR_PAYLOADS) expect(notes, JSON.stringify(payload)).toContain(payload)
    for (const row of body) {
      expect(row).toHaveLength(header.length)
      for (const cell of row) if (!/^-?\d+(\.\d+)?$/.test(cell)) expect(EXPOSED.test(cell), JSON.stringify(cell)).toBe(false)
    }
    // A reader that ignores quotes and splits on ';' or tab, as Excel does with a ';' list separator.
    for (const piece of text.split(/[;\t\r\n]/)) expect(DANGEROUS_START.test(piece.replace(/^"/, '')), JSON.stringify(piece)).toBe(false)
  })
})
