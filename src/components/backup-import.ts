import { useEffect, useState } from 'react'
import { AppError } from '../domain/errors'
import type { MessageKey } from '../i18n'
import type { Capacity } from '../lib/capacity'
import { formatBytes, restoreLimitBytes } from '../lib/limits'
import { requestPersistenceBriefly } from '../lib/persistence'
import { fillTemplate } from '../lib/template'
import type { ParsedBackup } from '../services/backup.service'

const measureCapacity = () => import('../lib/capacity').then((module) => module.measureCapacity())

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
    const measured = await measureCapacity()
    setCapacity(measured)
    if (file.size > restoreLimitBytes(measured.fileBytes)) throw new BackupTooLargeError(measured, file.size)
    const { readBackup } = await import('../db/backup-reader')
    return readBackup(file)
  }

  return { capacity, readFile }
}
