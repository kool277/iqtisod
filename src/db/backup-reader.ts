import { GCM_TAG_BYTES } from '../crypto/crypto.service'
import { Base64Decoder, Base64Error, base64DecodedLength } from '../crypto/base64-stream'
import { ValidationError } from '../domain/errors'
import { LIMITS } from '../lib/limits'
import { parseJsonSafely } from '../lib/safe-json'
import { MAX_CHUNKS, chunkCiphertextSizes, chunkCount, isChunkSize } from './chunks'
import { parseBackupJson, parseBackupText, type DecodedBackup } from './envelope'
import { KEYS_BACKUP_VERSION } from './versions'

/**
 * Reads a backup file in pieces, so the file is never held whole: not as text, not as parsed JSON, and its base64
 * body never as a string.
 *
 * Pass 1 scans the JSON and copies everything except the one long string (the ciphertext) into a small skeleton,
 * leaving a placeholder in its place and checking that the long string is padded base64. Pass 2 decodes only that
 * stretch of the file into a buffer of the exact size. The skeleton then goes through the same checks as any backup,
 * and the placeholder is accepted only where the ciphertext belongs.
 */

export const READ_BYTES = 4 * 1024 * 1024
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
  // The two bytes before the current piece of a diverted string, which may hold its `=` padding.
  let before1 = 0
  let before2 = 0
  let long: LongString | null = null

  const divert = () => {
    if (long) throw badBackup()
    for (const code of skeleton.slice(skeletonStart, skeleton.length)) if (!isBase64Char(code)) throw badBackup()
    skeleton.truncate(skeletonStart - 1)
    for (let index = 0; index < PLACEHOLDER_JSON.length; index += 1) skeleton.push(PLACEHOLDER_JSON.charCodeAt(index))
    diverted = true
    before1 = 0
    before2 = 0
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
        }
        continue
      }
      if (diverted) {
        // The rest of the ciphertext is only looked through for its closing quote, natively. Pass 2 decodes it and
        // refuses anything that is not padded standard base64 (an escape included), so nothing is checked twice.
        const end = piece.indexOf(QUOTE, index)
        if (end < 0) {
          before2 = piece.length > 1 ? piece[piece.length - 2] : before1
          before1 = piece[piece.length - 1]
          break
        }
        const last = end > 0 ? piece[end - 1] : before1
        const secondLast = end > 1 ? piece[end - 2] : end === 1 ? before1 : before2
        const padding = (last === PAD ? 1 : 0) + (last === PAD && secondLast === PAD ? 1 : 0)
        if ((offset + end - fileStart) % 4 !== 0) throw badBackup()
        long = { start: fileStart, end: offset + end, padding }
        inString = false
        index = end
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

/** Pass 2: the long string decoded into buffers of exactly the given sizes, filled in order. */
async function decodeLongString(file: Blob, long: LongString, sizes: readonly number[]): Promise<Uint8Array[]> {
  const size = base64DecodedLength(long.end - long.start, long.padding)
  if (size !== sizes.reduce((sum, item) => sum + item, 0)) throw badBackup()
  const targets = sizes.map((item) => new Uint8Array(item))
  const decoder = new Base64Decoder(targets)
  try {
    await readPieces(file, long.start, long.end, (piece) => decoder.push(piece))
    if (decoder.finish() !== size) throw badBackup()
  } catch (error) {
    if (error instanceof Base64Error) throw badBackup()
    throw error
  }
  return targets
}

/**
 * The ciphertext sizes a version 3 skeleton declares (its chunks', from `length` and `chunkSize`), or null for any
 * other file. Checked only as far as allocating needs; the envelope checks the rest once the body is read.
 */
function declaredChunkSizes(parsed: unknown): number[] | null {
  if (typeof parsed !== 'object' || parsed === null || (parsed as Record<string, unknown>).version !== KEYS_BACKUP_VERSION) return null
  const body = (parsed as Record<string, unknown>).body
  if (typeof body !== 'object' || body === null) throw badBackup()
  const { chunkSize, length } = body as Record<string, unknown>
  if (!isChunkSize(chunkSize) || !Number.isSafeInteger(length) || (length as number) < 1) throw badBackup()
  if ((length as number) + GCM_TAG_BYTES > LIMITS.ciphertextBytes || chunkCount(length as number, chunkSize) > MAX_CHUNKS) throw badBackup()
  return chunkCiphertextSizes(length as number, chunkSize)
}

/**
 * {@link readBackupFile}, falling back for a file no larger than 1.6.0 accepted to the whole-text reader 1.6.0 used,
 * which the streaming reader's stricter layout rules can refuse: a backup re-saved by a JSON tool with escapes in its
 * body still opens, and a newer format still says it is newer (FORMAT_TOO_NEW) instead of "not a backup".
 */
export async function readBackup(file: Blob): Promise<DecodedBackup> {
  try {
    return await readBackupFile(file)
  } catch (error) {
    if (!(error instanceof ValidationError) || file.size > LIMITS.importFileBytes) throw error
    return parseBackupText(await file.text())
  }
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
  const chunkSizes = declaredChunkSizes(parsed)
  if (chunkSizes) {
    // A version 3 body goes straight into one buffer per chunk, which is how the vault stores it.
    const chunks = await decodeLongString(file, long, chunkSizes)
    return parseBackupJson(parsed, { placeholder: PLACEHOLDER, chunks: chunks.map((chunk) => chunk.buffer as ArrayBuffer) })
  }
  const size = base64DecodedLength(long.end - long.start, long.padding)
  if (size > LIMITS.ciphertextBytes) throw badBackup()
  const [bytes] = await decodeLongString(file, long, [size])
  return parseBackupJson(parsed, { placeholder: PLACEHOLDER, bytes })
}
