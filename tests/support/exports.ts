import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OpenVault } from '../../src/domain/types'
import { unlockVault } from '../../src/services/auth.service'
import { parseBackup } from '../../src/services/backup.service'
import { createDataset, resolveExportScope, type ExportDataset, type ScopeRequest } from '../../src/services/export/dataset'
import type { PdfFonts } from '../../src/services/export/pdf-fonts'
import { fixtureByPath } from './fixtures'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export const EXPORT_FIXTURES = resolve(ROOT, 'tests/fixtures/exports/v1')
export const ledger = fixtureByPath('v2/ledger-v2')
export const FIXED_NOW = new Date('2027-02-01T08:30:00.000Z')
export const TEST_APP = { name: 'Jaybi', version: '0.0.0-test', commit: 'test' }

export function testFonts(): PdfFonts {
  const read = (face: string) => readFileSync(resolve(ROOT, `src/assets/fonts/NotoSans-${face}.subset.ttf`)).toString('base64')
  return { regular: read('Regular'), bold: read('Bold') }
}

export type Role = 'Admin' | 'Manager' | 'Viewer'

export async function openLedger(role: Role): Promise<OpenVault> {
  const user = ledger.expected.users.find((item) => item.role === role)!
  return unlockVault(parseBackup(ledger.text).record, user.email, user.password)
}

export function passwordOf(role: Role): string {
  return ledger.expected.users.find((item) => item.role === role)!.password
}

export const ALL_SCOPE: ScopeRequest = { period: null, groupId: null, includeAudit: false, includeReceipts: false }

export function datasetFor(vault: OpenVault, request: Partial<ScopeRequest> = {}): ExportDataset {
  const scope = resolveExportScope(vault.user, { ...ALL_SCOPE, ...request }, vault.db)
  return createDataset(vault.db, scope, { user: vault.user, now: FIXED_NOW, app: TEST_APP })
}

export function groupIdByName(vault: OpenVault, name: string): number {
  return Number(vault.db.queryValue('SELECT id FROM groups WHERE name = ?', [name]))
}

export async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

export async function blobText(blob: Blob): Promise<string> {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await blob.arrayBuffer())
}

export function counterRandom(seed = 1): (length: number) => Uint8Array {
  let state = seed
  return (length) => {
    const bytes = new Uint8Array(length)
    for (let index = 0; index < length; index += 1) {
      state = (state * 1103515245 + 12345) >>> 0
      bytes[index] = state >>> 24
    }
    return bytes
  }
}

export function parseCsv(text: string): string[][] {
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
  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}
