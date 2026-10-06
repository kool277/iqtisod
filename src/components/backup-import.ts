import { useEffect, useState } from 'react'
import type { MessageKey } from '../i18n'
import type { Capacity } from '../lib/capacity'
import { formatBytes } from '../lib/limits'
import { requestPersistence } from '../lib/persistence'
import type { ParsedBackup } from '../services/backup.service'

const measureCapacity = () => import('../lib/capacity').then((module) => module.measureCapacity())

type Translate = (key: MessageKey) => string

export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole)
}

export class BackupTooLargeError extends Error {
  constructor(readonly capacity: Capacity, readonly fileBytes: number) {
    super('IMPORT_TOO_LARGE')
    this.name = 'BackupTooLargeError'
  }
}

/** "Largest backup this device can restore: 428 MB, limited by this device's memory." */
export function budgetText(capacity: Capacity, t: Translate): string {
  return `${t('security.importLimit')}: ${formatBytes(capacity.fileBytes)} · ${t(`security.importBy.${capacity.limitedBy}`)}`
}

export function tooLargeText(error: BackupTooLargeError, t: Translate): string {
  return fillTemplate(t(`security.importTooLarge.${error.capacity.limitedBy}`), {
    file: formatBytes(error.fileBytes),
    limit: formatBytes(error.capacity.fileBytes),
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
    await requestPersistence()
    const measured = await measureCapacity()
    setCapacity(measured)
    if (file.size > measured.fileBytes) throw new BackupTooLargeError(measured, file.size)
    const { readBackupFile } = await import('../db/backup-reader')
    return readBackupFile(file)
  }

  return { capacity, readFile }
}
