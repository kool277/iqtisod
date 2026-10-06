import { Base64Decoder, Base64Error, base64DecodedLength } from '../crypto/base64-stream'
import { ValidationError } from '../domain/errors'
import { LIMITS } from '../lib/limits'
import { parseJsonSafely } from '../lib/safe-json'
import { parseBackupJson, type DecodedBackup } from './envelope'

/**
 * Reads a backup file in pieces, so the file is never held whole: not as text, not as parsed JSON, and its base64
 * body never as a string.
 *
 * Pass 1 scans the JSON and copies everything except the one long string (the ciphertext) into a small skeleton,
 * leaving a placeholder in its place and checking that the long string is padded base64. Pass 2 decodes only that
 * stretch of the file into a buffer of the exact size. The skeleton then goes through the same checks as any backup,
 * and the placeholder is accepted only where the ciphertext belongs.
 */

const READ_BYTES = 4 * 1024 * 1024
/** Everything but the ciphertext: 256 wraps, 64 codes and the JSON around them fit many times over. */
export const SKELETON_MAX_BYTES = 1024 * 1024
/** Strings longer than this leave the skeleton. Every legitimate one except the ciphertext is far shorter. */
export const LONG_STRING_BYTES = 64 * 1024
/** JSON-escaped, so it cannot be base64 and JSON.parse turns it into a string no backup field can legitimately hold. */
const PLACEHOLDER_JSON = '"\\u0000ciphertext"'
const PLACEHOLDER = '\u0000ciphertext'

const QUOTE = 0x22
const BACKSLASH = 0x5c
const PAD = 0x3d

const badBackup = () => new ValidationError('BACKUP')

function isBase64Char(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2f
}

class Skeleton {
  private bytes = new Uint8Array(64 * 1024)
  length = 0

  push(byte: number): void {
    if (this.length === this.bytes.length) {
      if (this.length >= SKELETON_MAX_BYTES + LONG_STRING_BYTES) throw badBackup()
      const grown = new Uint8Array(this.bytes.length * 2)
      grown.set(this.bytes)
      this.bytes = grown
    }
    this.bytes[this.length++] = byte
  }

  slice(start: number, end: number): Uint8Array {
    return this.bytes.subarray(start, end)
  }

  truncate(length: number): void {
    this.length = length
  }

  text(): string {
    if (this.length > SKELETON_MAX_BYTES) throw badBackup()
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(this.bytes.subarray(0, this.length))
    } catch {
      throw badBackup()
    }
  }
}

type LongString = { start: number; end: number; padding: number }

async function readPieces(file: Blob, start: number, end: number, each: (piece: Uint8Array, offset: number) => void): Promise<void> {
  for (let offset = start; offset < end; offset += READ_BYTES) {
    const piece = new Uint8Array(await file.slice(offset, Math.min(end, offset + READ_BYTES)).arrayBuffer())
    each(piece, offset)
  }
}

/** Pass 1: the skeleton, and where the long string is, if there is one. */
async function scan(file: Blob, longStringBytes: number): Promise<{ skeleton: string; long: LongString | null }> {
  const skeleton = new Skeleton()
  let inString = false
  let escaped = false
  // Within the current string: where its content starts in the file and in the skeleton, and how long it is so far.
  let fileStart = 0
  let skeletonStart = 0
  let length = 0
  let diverted = false
  let padding = 0
  let long: LongString | null = null

  const divert = () => {
    if (long) throw badBackup()
    for (const code of skeleton.slice(skeletonStart, skeleton.length)) if (!isBase64Char(code)) throw badBackup()
    skeleton.truncate(skeletonStart - 1)
    for (let index = 0; index < PLACEHOLDER_JSON.length; index += 1) skeleton.push(PLACEHOLDER_JSON.charCodeAt(index))
    diverted = true
  }

  await readPieces(file, 0, file.size, (piece, offset) => {
    for (let index = 0; index < piece.length; index += 1) {
      const code = piece[index]
      if (!inString) {
        skeleton.push(code)
        if (code === QUOTE) {
          inString = true
          fileStart = offset + index + 1
          skeletonStart = skeleton.length
          length = 0
          diverted = false
          padding = 0
        }
        continue
      }
      if (diverted) {
        if (code === QUOTE) {
          if ((length + padding) % 4 !== 0) throw badBackup()
          long = { start: fileStart, end: offset + index, padding }
          inString = false
          continue
        }
        if (code === PAD) {
          if (++padding > 2) throw badBackup()
        } else if (padding > 0 || !isBase64Char(code)) {
          throw badBackup()
        } else {
          length += 1
        }
        continue
      }
      skeleton.push(code)
      if (escaped) {
        escaped = false
      } else if (code === BACKSLASH) {
        escaped = true
      } else if (code === QUOTE) {
        inString = false
        continue
      }
      length += 1
      if (length > longStringBytes) {
        if (escaped) throw badBackup()
        divert()
      }
    }
  })
  if (inString) throw badBackup()
  return { skeleton: skeleton.text(), long }
}

/** Pass 2: the long string decoded into a buffer of exactly its size. */
async function decodeLongString(file: Blob, long: LongString): Promise<Uint8Array> {
  const chars = long.end - long.start
  const size = base64DecodedLength(chars, long.padding)
  if (size > LIMITS.ciphertextBytes) throw badBackup()
  const bytes = new Uint8Array(size)
  const decoder = new Base64Decoder(bytes)
  try {
    await readPieces(file, long.start, long.end, (piece) => decoder.push(piece))
    if (decoder.finish() !== size) throw badBackup()
  } catch (error) {
    if (error instanceof Base64Error) throw badBackup()
    throw error
  }
  return bytes
}

export async function readBackupFile(file: Blob, options: { longStringBytes?: number } = {}): Promise<DecodedBackup> {
  const { skeleton, long } = await scan(file, options.longStringBytes ?? LONG_STRING_BYTES)
  let parsed: unknown
  try {
    parsed = parseJsonSafely(skeleton, { maxChars: SKELETON_MAX_BYTES })
  } catch {
    throw badBackup()
  }
  if (!long) return parseBackupJson(parsed)
  return parseBackupJson(parsed, { placeholder: PLACEHOLDER, bytes: await decodeLongString(file, long) })
}
