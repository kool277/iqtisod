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

/**
 * Standard padded base64. Uses the browser's own `Uint8Array.prototype.toBase64` where there is one (Chrome 140,
 * Firefox 133, Safari 18.2): the same text about seventy times faster, without building a binary string first.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64
  if (typeof native === 'function') return native.call(bytes)
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
  return base64BlobOfParts(before, [bytes], after, type)
}

/**
 * {@link base64Blob} for bytes that come in several parts, encoded as if the parts were one array. A part whose length
 * is not a multiple of three leaves up to two bytes over, which are joined with the start of the next part, so the
 * parts are never copied into one buffer.
 */
export function base64BlobOfParts(before: string, parts: readonly Uint8Array[], after: string, type: string): Blob {
  let blob = new Blob([before], { type })
  const carry = new Uint8Array(3)
  let carried = 0
  for (const part of parts) {
    let offset = 0
    if (carried > 0) {
      const take = Math.min(3 - carried, part.length)
      carry.set(part.subarray(0, take), carried)
      carried += take
      offset = take
      if (carried < 3) continue
      blob = new Blob([blob, bytesToBase64(carry)], { type })
      carried = 0
    }
    const whole = offset + Math.floor((part.length - offset) / 3) * 3
    for (let start = offset; start < whole; start += BLOB_CHUNK_BYTES) {
      blob = new Blob([blob, bytesToBase64(part.subarray(start, Math.min(whole, start + BLOB_CHUNK_BYTES)))], { type })
    }
    carried = part.length - whole
    carry.set(part.subarray(whole), 0)
  }
  if (carried > 0) blob = new Blob([blob, bytesToBase64(carry.subarray(0, carried))], { type })
  carry.fill(0)
  return new Blob([blob, after], { type })
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
