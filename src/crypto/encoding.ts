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

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_PAD = 0x3d
const SEXTETS = (() => {
  const table = new Int8Array(256).fill(-1)
  for (let index = 0; index < BASE64_ALPHABET.length; index += 1) table[BASE64_ALPHABET.charCodeAt(index)] = index
  return table
})()

export class Base64Error extends Error {
  constructor() {
    super('Invalid base64')
    this.name = 'Base64Error'
  }
}

/** Bytes that padded base64 of this many characters, `padding` of them `=`, decodes to. */
export function base64DecodedLength(chars: number, padding: number): number {
  return (chars / 4) * 3 - padding
}

/**
 * Decodes padded base64 straight into a buffer of the exact size, fed in pieces, without the binary string `atob`
 * builds. Accepts only `A–Z a–z 0–9 + /`, with one or two `=` at the very end and a length divisible by four.
 */
export class Base64Decoder {
  private quad = 0
  private sextets = 0
  private padding = 0
  private written = 0

  constructor(private readonly target: Uint8Array) {}

  push(chunk: Uint8Array): void {
    const { target } = this
    let { quad, sextets, padding, written } = this
    for (let index = 0; index < chunk.length; index += 1) {
      const code = chunk[index]
      if (code === BASE64_PAD) {
        padding += 1
        if (padding > 2) throw new Base64Error()
        continue
      }
      const value = SEXTETS[code]
      if (value < 0 || padding > 0) throw new Base64Error()
      quad = (quad << 6) | value
      sextets += 1
      if ((sextets & 3) === 0) {
        if (written + 3 > target.length) throw new Base64Error()
        target[written] = (quad >> 16) & 0xff
        target[written + 1] = (quad >> 8) & 0xff
        target[written + 2] = quad & 0xff
        written += 3
        quad = 0
      }
    }
    this.quad = quad
    this.sextets = sextets
    this.padding = padding
    this.written = written
  }

  pushString(text: string, start = 0, end = text.length): void {
    const scratch = new Uint8Array(Math.min(64 * 1024, Math.max(0, end - start)))
    for (let offset = start; offset < end; offset += scratch.length) {
      const length = Math.min(scratch.length, end - offset)
      for (let index = 0; index < length; index += 1) {
        const code = text.charCodeAt(offset + index)
        // A wider character must not wrap into the alphabet when stored as a byte.
        scratch[index] = code > 0x7f ? 0xff : code
      }
      this.push(length === scratch.length ? scratch : scratch.subarray(0, length))
    }
  }

  /** Checks the padding, writes the last bytes, and returns how many were written. */
  finish(): number {
    const { quad, sextets, padding, target } = this
    if ((sextets + padding) % 4 !== 0) throw new Base64Error()
    const rest = sextets % 4
    if ((rest === 0 && padding !== 0) || (rest === 3 && padding !== 1) || (rest === 2 && padding !== 2) || rest === 1) throw new Base64Error()
    const tail = rest === 3 ? [(quad >> 10) & 0xff, (quad >> 2) & 0xff] : rest === 2 ? [(quad >> 4) & 0xff] : []
    if (this.written + tail.length > target.length) throw new Base64Error()
    for (const byte of tail) target[this.written++] = byte
    return this.written
  }
}

/** `atob` without the intermediate binary string: one exact-size buffer, and strict about the alphabet and padding. */
export function base64ToExactBytes(text: string): Uint8Array {
  if (text.length % 4 !== 0) throw new Base64Error()
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  const bytes = new Uint8Array(base64DecodedLength(text.length, padding))
  const decoder = new Base64Decoder(bytes)
  decoder.pushString(text)
  if (decoder.finish() !== bytes.length) throw new Base64Error()
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
