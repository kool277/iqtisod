import { base64BlobOfParts } from '../crypto/encoding'
import { ciphertextParts, decodeStoredRecord, parseBackupText, storedToBackupJson, toBackupJson, type DecodedBackup, type VaultRecord } from '../db/envelope'
import { getSetting, setSetting } from '../db/settings'
import type { ArchiveEntry, LoadedArchive, StoredCopy } from '../db/storage'
import { ForbiddenError } from '../domain/errors'
import type { OpenVault } from '../domain/types'
import { toIsoDate } from '../lib/dates'
import { Permission, canUser } from '../rbac'
import { writeAudit } from './audit.service'

export const BACKUP_STALE_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

export type ParsedBackup = DecodedBackup

export function parseBackup(text: string): ParsedBackup {
  return parseBackupText(text)
}

export function backupFileText(record: VaultRecord, exportedAt = new Date().toISOString()): string {
  return JSON.stringify(toBackupJson(record, exportedAt))
}

export function archiveFileText(entry: ArchiveEntry | LoadedArchive, exportedAt = new Date().toISOString()): string {
  return JSON.stringify(storedToBackupJson(entry.raw, exportedAt, undefined, 'chunks' in entry ? entry.chunks : undefined))
}

/** A record as IndexedDB holds it (an archive, or the vault itself), as a backup file. */
export function storedFileBlob(copy: StoredCopy, exportedAt = new Date().toISOString()): Blob {
  return streamedBackup(storedToBackupJson(copy.raw, exportedAt, '', copy.chunks), ciphertextParts(decodeStoredRecord(copy.raw, copy.chunks).record))
}

export const BACKUP_MIME = 'application/json'
/** The body is the file's last field and the ciphertext the body's last key, so the base64 goes right before this. */
const CIPHERTEXT_TAIL = '"}}'

/**
 * The same bytes as the `*FileText` functions, with the base64 body streamed into the Blob rather than built as one
 * string. The JSON is written with an empty ciphertext and split by position, not by searching for a marker that
 * text elsewhere in the envelope could also contain. A version 3 body's chunks are encoded one after another as if
 * they were one buffer.
 */
function streamedBackup(json: object, parts: readonly Uint8Array[]): Blob {
  const text = JSON.stringify(json)
  if (!text.endsWith(`"ciphertext":"${CIPHERTEXT_TAIL}`)) throw new Error('Backup layout changed')
  return base64BlobOfParts(text.slice(0, -CIPHERTEXT_TAIL.length), parts, CIPHERTEXT_TAIL, BACKUP_MIME)
}

export function backupFileBlob(record: VaultRecord, exportedAt = new Date().toISOString()): Blob {
  return streamedBackup(toBackupJson(record, exportedAt, ''), ciphertextParts(record))
}

export function archiveFileBlob(entry: ArchiveEntry | LoadedArchive, exportedAt = new Date().toISOString()): Blob {
  return storedFileBlob({ raw: entry.raw, chunks: 'chunks' in entry ? entry.chunks : undefined }, exportedAt)
}

export function backupFileName(kind: 'backup' | 'archive' = 'backup', date = new Date()): string {
  return `moliya-${kind}-${toIsoDate(date)}.moliya`
}

export function noteExport(vault: OpenVault): void {
  if (!canUser(vault.user, Permission.EXPORT_VAULT)) throw new ForbiddenError()
  const now = new Date().toISOString()
  vault.db.withTransaction(() => {
    setSetting(vault.db, 'last_backup_at', now)
    writeAudit(vault.db, vault.user.id, 'BACKUP_EXPORTED', 'vault', 'primary')
  })
  vault.lastBackupAt = now
}

export type BackupReminder = 'never' | 'stale' | null

export function backupReminder(vault: OpenVault, now = new Date()): BackupReminder {
  if (!canUser(vault.user, Permission.EXPORT_VAULT)) return null
  const last = getSetting(vault.db, 'last_backup_at')
  if (!last) {
    const records = Number(vault.db.queryValue('SELECT COUNT(*) FROM transactions') ?? 0)
    return records > 0 ? 'never' : null
  }
  const age = now.getTime() - new Date(last).getTime()
  return Number.isFinite(age) && age > BACKUP_STALE_DAYS * DAY_MS ? 'stale' : null
}
