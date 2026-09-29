import { PBKDF2_ITERATIONS } from '../crypto/crypto.service'
import { base64ToBytes, bytesToBase64, cloneBuffer, cloneBytes } from '../crypto/encoding'
import { recordFromSession, type VaultRecord } from '../db/storage'
import { ForbiddenError, ValidationError } from '../domain/errors'
import type { OpenVault } from '../domain/types'
import { Permission, canUser } from '../rbac'
import { writeAudit } from './audit.service'

export type BackupFile = {
  format: 'moliya-vault'
  version: 1
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number }
  wraps: {
    userId: string
    email: string
    salt: string
    iv: string
    wrappedDek: string
  }[]
  payload: {
    iv: string
    ciphertext: string
  }
}

export function vaultToBackup(record: VaultRecord): BackupFile {
  return {
    format: 'moliya-vault',
    version: 1,
    kdf: record.kdf,
    wraps: record.wraps.map((wrap) => ({
      userId: wrap.userId,
      email: wrap.email,
      salt: bytesToBase64(cloneBytes(wrap.salt)),
      iv: bytesToBase64(cloneBytes(wrap.iv)),
      wrappedDek: bytesToBase64(cloneBytes(wrap.wrappedDek)),
    })),
    payload: {
      iv: bytesToBase64(cloneBytes(record.payload.iv)),
      ciphertext: bytesToBase64(cloneBytes(record.payload.ciphertext)),
    },
  }
}

export function backupToVault(file: BackupFile): VaultRecord {
  if (file?.format !== 'moliya-vault' || file.version !== 1 || !Array.isArray(file.wraps) || !file.payload) {
    throw new ValidationError('BACKUP')
  }
  if (file.kdf?.iterations !== PBKDF2_ITERATIONS) throw new ValidationError('BACKUP')
  try {
    return recordFromSession({
      wraps: file.wraps.map((wrap) => ({
        userId: wrap.userId,
        email: wrap.email,
        salt: base64ToBytes(wrap.salt),
        iv: base64ToBytes(wrap.iv),
        wrappedDek: cloneBuffer(base64ToBytes(wrap.wrappedDek)),
      })),
      iv: base64ToBytes(file.payload.iv),
      ciphertext: cloneBuffer(base64ToBytes(file.payload.ciphertext)),
      updatedAt: new Date().toISOString(),
    })
  } catch (error) {
    if (error instanceof ValidationError) throw error
    throw new ValidationError('BACKUP')
  }
}

export function parseBackup(text: string): VaultRecord {
  try {
    return backupToVault(JSON.parse(text) as BackupFile)
  } catch (error) {
    if (error instanceof ValidationError) throw error
    throw new ValidationError('BACKUP')
  }
}

export function noteExport(vault: OpenVault): void {
  if (!canUser(vault.user, Permission.EXPORT_VAULT)) throw new ForbiddenError()
  writeAudit(vault.db, vault.user.id, 'BACKUP_EXPORTED', 'vault', 'primary')
}
