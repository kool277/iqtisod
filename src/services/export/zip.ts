import { BlobReader, BlobWriter, ZipWriter, configure } from '@zip.js/zip.js/index-native.js'
import { throwIfAborted } from './dataset'

export type ZipEntry = { name: string; blob: Blob; stored?: boolean }

configure({ useWebWorkers: false })

export async function buildZip(entries: ZipEntry[], options: { password?: string; signal?: AbortSignal; now?: Date }): Promise<Blob> {
  const encrypted = Boolean(options.password)
  const writer = new ZipWriter(new BlobWriter('application/zip'), {
    ...(encrypted ? { password: options.password, encryptionStrength: 3 as const, zipCrypto: false } : {}),
    lastModDate: options.now ?? new Date(),
  })
  try {
    for (const entry of entries) {
      throwIfAborted(options.signal)
      await writer.add(entry.name, new BlobReader(entry.blob), { level: entry.stored ? 0 : 6, signal: options.signal })
    }
    return await writer.close()
  } catch (error) {
    throwIfAborted(options.signal)
    throw error
  }
}
