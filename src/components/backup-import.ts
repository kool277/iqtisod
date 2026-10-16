import { useEffect, useState } from 'react'
import { AppError } from '../domain/errors'
import type { MessageKey } from '../i18n'
import type { Capacity } from '../lib/capacity'
import { formatBytes, restoreLimitBytes } from '../lib/limits'
import { requestPersistenceBriefly } from '../lib/persistence'
import { fillTemplate } from '../lib/template'
import type { ParsedBackup } from '../services/backup.service'

const measureCapacity = () => import('../lib/capacity').then((module) => module.measureCapacity())
/** A restored backup is stored the way its file says, whatever the open vault uses. */
const capacityForFile = (chunked: boolean) => import('../lib/capacity').then((module) => module.capacityFor({ chunked }))

/** `{"format":"moliya-vault","version":3,` as the app writes it: a backup whose vault is stored in chunks. */
const CHUNKED_HEAD = /^\s*\{\s*"format"\s*:\s*"moliya-vault"\s*,\s*"version"\s*:\s*3\s*[,}]/

/**
 * Whether a file declares backup version 3, read from its first bytes only. A file laid out any other way is held to
 * the stricter single-value budget, which every version accepts.
 */
export async function declaresChunkedBackup(file: Blob): Promise<boolean> {
  try {
    return CHUNKED_HEAD.test(await file.slice(0, 256).text())
  } catch {
    return false
  }
}

type Translate = (key: MessageKey) => string

/** An AppError like any other, so a caller that does not word it itself still gets the IMPORT_TOO_LARGE text. */
export class BackupTooLargeError extends AppError {
  constructor(readonly capacity: Capacity, readonly fileBytes: number) {
    super('IMPORT_TOO_LARGE')
    this.name = 'BackupTooLargeError'
  }
}

/** "Largest backup this device can restore: 428 MB, limited by this device's memory." */
export function budgetText(capacity: Capacity, t: Translate): string {
  return `${t('security.importLimit')}: ${formatBytes(restoreLimitBytes(capacity.fileBytes))} · ${t(`security.importBy.${capacity.limitedBy}`)}`
}

export function tooLargeText(error: BackupTooLargeError, t: Translate): string {
  return fillTemplate(t(`security.importTooLarge.${error.capacity.limitedBy}`), {
    file: formatBytes(error.fileBytes),
    limit: formatBytes(restoreLimitBytes(error.capacity.fileBytes)),
  })
}

/** The device budget for restoring a backup, measured when the picker appears and again for each file chosen. */
export function useBackupImport() {
  const [capacity, setCapacity] = useState<Capacity | null>(null)

  useEffect(() => {
    let live = true
    void measureCapacity().then((value) => live && setCapacity(value), () => undefined)
    return () => {
      live = false
    }
  }, [])

  async function readFile(file: File): Promise<ParsedBackup> {
    // Persistent storage raises the quota in some browsers and keeps a large vault from being evicted.
    await requestPersistenceBriefly()
    const measured = await capacityForFile(await declaresChunkedBackup(file))
    setCapacity(measured)
    if (file.size > restoreLimitBytes(measured.fileBytes)) throw new BackupTooLargeError(measured, file.size)
    const { readBackup } = await import('../db/backup-reader')
    return readBackup(file)
  }

  return { capacity, readFile }
}
