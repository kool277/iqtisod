import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decryptDatabase, deriveKey, unwrapDek } from '../../src/crypto/crypto.service'
import { parseBackupText } from '../../src/db/envelope'
import { SqlDatabase } from '../../src/db/sqlite'

export const FIXTURE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/backups')

export type ManifestEntry = {
  path: string
  producedBy: string
  backupFormat: number
  recordFormat: number
  schemaVersion: number
}

export type ExpectedUser = { email: string; password: string; role: 'Admin' | 'Manager' | 'Viewer'; group: string | null }

export type ExpectedTransaction = {
  id: string
  type: 'INCOME' | 'EXPENSE'
  amountMinor: number
  currency: string
  category: string
  group: string
  date: string
  notes: string | null
  hasReceipt: boolean
  userEmail: string
}

export type ExpectedTotals = { incomeMinor: number; expenseMinor: number; netMinor: number; savingsRate: number }

export type Expected = {
  producedBy: { appVersion: string; commit: string }
  vaultName: string
  currency: string
  users: ExpectedUser[]
  groups: string[]
  categoryCount: number
  transactions: ExpectedTransaction[]
  totals: { range: { start: string; end: string } } & Partial<Record<'admin' | 'manager', ExpectedTotals>>
  auditActions: string[]
}

export type Fixture = ManifestEntry & { text: string; expected: Expected }

export function readManifest(): ManifestEntry[] {
  return (JSON.parse(readFileSync(resolve(FIXTURE_ROOT, 'MANIFEST.json'), 'utf8')) as { fixtures: ManifestEntry[] }).fixtures
}

export function readFixture(entry: ManifestEntry): Fixture {
  return {
    ...entry,
    text: readFileSync(resolve(FIXTURE_ROOT, `${entry.path}.moliya`), 'utf8'),
    expected: JSON.parse(readFileSync(resolve(FIXTURE_ROOT, `${entry.path}.expected.json`), 'utf8')) as Expected,
  }
}

export function fixtureFolders(): string[] {
  return readdirSync(FIXTURE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

export function readChecksums(folder: string): Map<string, string> {
  const lines = readFileSync(resolve(FIXTURE_ROOT, folder, 'SHA256SUMS'), 'utf8').trim().split('\n')
  return new Map(
    lines.map((line) => {
      const [hash, name] = line.split(/\s+/)
      return [name, hash]
    }),
  )
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function bufferFromBase64(text: string): ArrayBuffer {
  const bytes = Buffer.from(text, 'base64')
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

type V1Backup = {
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number }
  wraps: { userId: string; email: string; salt: string; iv: string; wrappedDek: string }[]
  payload: { iv: string; ciphertext: string }
}

export function v1StoredRecordFromBackup(text: string, updatedAt = '2026-04-01T09:00:00.000Z') {
  const backup = JSON.parse(text) as V1Backup
  return {
    id: 'primary' as const,
    version: 1 as const,
    kdf: { ...backup.kdf },
    wraps: backup.wraps.map((wrap) => ({
      userId: wrap.userId,
      email: wrap.email,
      salt: bufferFromBase64(wrap.salt),
      iv: bufferFromBase64(wrap.iv),
      wrappedDek: bufferFromBase64(wrap.wrappedDek),
    })),
    payload: { iv: bufferFromBase64(backup.payload.iv), ciphertext: bufferFromBase64(backup.payload.ciphertext) },
    updatedAt,
  }
}

export async function decryptFixtureDatabase(fixture: Fixture, user: ExpectedUser = fixture.expected.users[0]): Promise<Uint8Array> {
  const { record } = parseBackupText(fixture.text)
  const wrap = record.wraps.find((item) => item.email === user.email)
  if (!wrap) throw new Error(`no wrap for ${user.email}`)
  const kek = await deriveKey(user.password, new Uint8Array(wrap.salt), wrap.kdf)
  const dek = await unwrapDek(wrap.wrappedDek, kek, new Uint8Array(wrap.iv))
  return decryptDatabase(record.body.ciphertext, dek, new Uint8Array(record.body.iv))
}

export async function openRawFixtureDatabase(fixture: Fixture): Promise<SqlDatabase> {
  return SqlDatabase.openBytes(await decryptFixtureDatabase(fixture))
}

export function fixtureByPath(path: string): Fixture {
  const entry = readManifest().find((item) => item.path === path)
  if (!entry) throw new Error(`fixture ${path} is not in the manifest`)
  return readFixture(entry)
}
