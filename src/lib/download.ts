const REVOKE_AFTER_MS = 60_000

export function downloadFile(content: string | Uint8Array | Blob, fileName: string, type: string): void {
  const blob = content instanceof Blob ? content : new Blob([content as BlobPart], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS)
}
