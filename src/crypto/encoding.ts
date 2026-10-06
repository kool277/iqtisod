export function copyToBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

export function cloneBytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  const view = value instanceof Uint8Array ? value : new Uint8Array(value)
  const copy = new Uint8Array(view.byteLength)
  copy.set(view)
  return copy
}

export function cloneBuffer(value: ArrayBuffer | Uint8Array): ArrayBuffer {
  return copyToBuffer(cloneBytes(value))
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/** Three bytes per four characters, so pieces encoded separately join into one valid base64 string. */
const BLOB_CHUNK_BYTES = 3 * 1024 * 1024

/**
 * `before + base64(bytes) + after` as a Blob, encoded a piece at a time. Each piece is appended to the Blob built so
 * far, which browsers keep by reference, so only one piece of base64 is ever held as a string.
 */
export function base64Blob(before: string, bytes: Uint8Array, after: string, type: string): Blob {
  let blob = new Blob([before], { type })
  for (let offset = 0; offset < bytes.length; offset += BLOB_CHUNK_BYTES) {
    blob = new Blob([blob, bytesToBase64(bytes.subarray(offset, offset + BLOB_CHUNK_BYTES))], { type })
  }
  return new Blob([blob, after], { type })
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
