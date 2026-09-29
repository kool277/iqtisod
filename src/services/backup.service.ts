import { parseBackupText, storedToBackupJson, toBackupJson, type DecodedBackup, type VaultRecord } from '../db/envelope'
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
