import { base64Blob } from '../crypto/encoding'
import { decodeStoredRecord, parseBackupText, storedToBackupJson, toBackupJson, type DecodedBackup, type VaultRecord } from '../db/envelope'
import { getSetting, setSetting } from '../db/settings'
import type { ArchiveEntry } from '../db/storage'
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

export function archiveFileText(entry: ArchiveEntry, exportedAt = new Date().toISOString()): string {
  return JSON.stringify(storedToBackupJson(entry.raw, exportedAt))
}

/** Contains a space, so it cannot be base64 and no other field of the JSON can hold it by accident. */
const CIPHERTEXT_STAND_IN = 'ciphertext stand-in'
export const BACKUP_MIME = 'application/json'

/** The same bytes as the `*FileText` functions, with the base64 body streamed into the Blob rather than built as one string. */
function streamedBackup(json: object, ciphertext: ArrayBuffer): Blob {
  const text = JSON.stringify(json)
  const marker = JSON.stringify(CIPHERTEXT_STAND_IN)
  const at = text.indexOf(marker)
  if (at < 0 || text.indexOf(marker, at + 1) >= 0) throw new Error('Backup layout changed')
  return base64Blob(text.slice(0, at + 1), new Uint8Array(ciphertext), text.slice(at + marker.length - 1), BACKUP_MIME)
}

export function backupFileBlob(record: VaultRecord, exportedAt = new Date().toISOString()): Blob {
  return streamedBackup(toBackupJson(record, exportedAt, CIPHERTEXT_STAND_IN), record.body.ciphertext)
}

export function archiveFileBlob(entry: ArchiveEntry, exportedAt = new Date().toISOString()): Blob {
  return streamedBackup(storedToBackupJson(entry.raw, exportedAt, CIPHERTEXT_STAND_IN), decodeStoredRecord(entry.raw).record.body.ciphertext)
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
