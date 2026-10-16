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
 *
 * Given several buffers, it fills them in order as if they were one: a backup's single ciphertext string becomes one
 * buffer per chunk without ever being whole.
 */
export class Base64Decoder {
  private quad = 0
  private sextets = 0
  private padding = 0
  private written = 0
  private readonly targets: readonly Uint8Array[]
  private current = 0
  private target: Uint8Array
  private position = 0

  constructor(target: Uint8Array | readonly Uint8Array[]) {
    this.targets = target instanceof Uint8Array ? [target] : target
    this.target = this.targets[0] ?? new Uint8Array(0)
  }

  /** Writes one byte where the previous target ended, moving to the next target when one is full. */
  private put(byte: number): void {
    while (this.position === this.target.length) {
      this.current += 1
      if (this.current >= this.targets.length) throw new Base64Error()
      this.target = this.targets[this.current]
      this.position = 0
    }
    this.target[this.position++] = byte
    this.written += 1
  }

  push(chunk: Uint8Array): void {
    let { quad, sextets, padding, target, position, written } = this
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
        if (position + 3 <= target.length) {
          target[position] = (quad >> 16) & 0xff
          target[position + 1] = (quad >> 8) & 0xff
          target[position + 2] = quad & 0xff
          position += 3
          written += 3
        } else {
          // The three bytes straddle the end of a target: write them one at a time.
          this.position = position
          this.written = written
          this.put((quad >> 16) & 0xff)
          this.put((quad >> 8) & 0xff)
          this.put(quad & 0xff)
          ;({ target, position, written } = this)
        }
        quad = 0
      }
    }
    this.quad = quad
    this.sextets = sextets
    this.padding = padding
    this.position = position
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

  /** Checks the padding, writes the last bytes, and returns how many were written in all. */
  finish(): number {
    const { quad, sextets, padding } = this
    if ((sextets + padding) % 4 !== 0) throw new Base64Error()
    const rest = sextets % 4
    if ((rest === 0 && padding !== 0) || (rest === 3 && padding !== 1) || (rest === 2 && padding !== 2) || rest === 1) throw new Base64Error()
    const tail = rest === 3 ? [(quad >> 10) & 0xff, (quad >> 2) & 0xff] : rest === 2 ? [(quad >> 4) & 0xff] : []
    for (const byte of tail) this.put(byte)
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
