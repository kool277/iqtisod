export function downloadFile(content: string | Uint8Array, fileName: string, type: string): void {
  const blob = new Blob([content as BlobPart], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}
