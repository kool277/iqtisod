import { ValidationError } from '../domain/errors'
import { IV_BYTES, derivePbkdf2Bits, randomBytes, type KdfParams } from './crypto.service'
import { base64ToBytes, bytesToBase64, copyToBuffer } from './encoding'

export const ENC_VERSION = 1
export const PAD_BLOCK = 256
export const MAX_PLAINTEXT_BYTES = 32 * 1024
export const PK_SALT_BYTES = 32
export const RECOVERY_SALT_BYTES = 16
export const RECOVERY_CODE_BYTES = 15
export const PERSONAL_KEK_INFO = 'moliya/personal-kek/v1'
export const RECOVERY_KEK_INFO = 'moliya/recovery-kek/v1'

export const PERSONAL_KEY_USAGES: KeyUsage[] = ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
export const SAFE_KEY_USAGES: KeyUsage[] = ['encrypt', 'decrypt']

export type Sealed = { iv: string; ct: string }
export type AadPart = string | number
export type AadLabel =
  | 'moliya.pk'
  | 'moliya.pk-recovery'
  | 'moliya.user-meta'
  | 'moliya.event'
  | 'moliya.safe-key'
  | 'moliya.safe-meta'
  | 'moliya.item'
  | 'moliya.totp'

export class DecryptError extends Error {
  constructor() {
    super('DECRYPT')
    this.name = 'DecryptError'
  }
}

export function aad(label: AadLabel, ...parts: AadPart[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([label, ENC_VERSION, ...parts]))
}

async function kekFromBits(bits: Uint8Array, salt: Uint8Array, info: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', copyToBuffer(bits), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: copyToBuffer(salt), info: new TextEncoder().encode(info) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  )
}

export async function derivePersonalKek(password: string, salt: Uint8Array, kdf: KdfParams): Promise<CryptoKey> {
  const bits = await derivePbkdf2Bits(password, salt, kdf)
  try {
    return await kekFromBits(bits, new Uint8Array(0), PERSONAL_KEK_INFO)
  } finally {
    bits.fill(0)
  }
}

export async function deriveRecoveryKek(code: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  return kekFromBits(code, salt, RECOVERY_KEK_INFO)
}

export async function generateAesKey(usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, usages)
}

export async function wrapWithAad(key: CryptoKey, wrappingKey: CryptoKey, data: Uint8Array): Promise<Sealed> {
  const iv = randomBytes(IV_BYTES)
  const wrapped = await crypto.subtle.wrapKey('raw', key, wrappingKey, {
    name: 'AES-GCM',
    iv: copyToBuffer(iv),
    additionalData: copyToBuffer(data),
  })
  return { iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(wrapped)) }
}

export async function unwrapWithAad(
  sealed: Sealed,
  wrappingKey: CryptoKey,
  data: Uint8Array,
  options: { extractable: boolean; usages: KeyUsage[] },
): Promise<CryptoKey> {
  try {
    return await crypto.subtle.unwrapKey(
      'raw',
      copyToBuffer(base64ToBytes(sealed.ct)),
      wrappingKey,
      { name: 'AES-GCM', iv: copyToBuffer(base64ToBytes(sealed.iv)), additionalData: copyToBuffer(data) },
      { name: 'AES-GCM', length: 256 },
      options.extractable,
      options.usages,
    )
  } catch {
    throw new DecryptError()
  }
}

export function pad(content: Uint8Array): Uint8Array {
  const total = 4 + content.byteLength
  if (total > MAX_PLAINTEXT_BYTES) throw new ValidationError('TOO_LONG')
  const out = new Uint8Array(Math.ceil(total / PAD_BLOCK) * PAD_BLOCK)
  new DataView(out.buffer).setUint32(0, content.byteLength)
  out.set(content, 4)
  return out
}

export function unpad(padded: Uint8Array): Uint8Array {
  if (padded.byteLength < 4 || padded.byteLength % PAD_BLOCK !== 0) throw new DecryptError()
  const length = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0)
  if (length > padded.byteLength - 4) throw new DecryptError()
  for (let index = 4 + length; index < padded.byteLength; index += 1) {
    if (padded[index] !== 0) throw new DecryptError()
  }
  return padded.slice(4, 4 + length)
}

export async function sealJson(value: unknown, key: CryptoKey, data: Uint8Array): Promise<Sealed> {
  const plain = pad(new TextEncoder().encode(JSON.stringify(value)))
  try {
    const iv = randomBytes(IV_BYTES)
    const cipher = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: copyToBuffer(iv), additionalData: copyToBuffer(data) },
      key,
      copyToBuffer(plain),
    )
    return { iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(cipher)) }
  } finally {
    plain.fill(0)
  }
}

export async function openJson<T>(sealed: Sealed, key: CryptoKey, data: Uint8Array): Promise<T> {
  let plain: Uint8Array
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: copyToBuffer(base64ToBytes(sealed.iv)), additionalData: copyToBuffer(data) },
        key,
        copyToBuffer(base64ToBytes(sealed.ct)),
      ),
    )
  } catch {
    throw new DecryptError()
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(unpad(plain))) as T
  } catch {
    throw new DecryptError()
  } finally {
    plain.fill(0)
  }
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CHECK_SYMBOLS = `${CROCKFORD}*~$=U`
const CODE_CHARS = 24

function checkSymbol(value: bigint): string {
  return CHECK_SYMBOLS[Number(value % 37n)]
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  return value
}

export function formatRecoveryCode(bytes: Uint8Array): string {
  if (bytes.byteLength !== RECOVERY_CODE_BYTES) throw new Error('recovery code must be 15 bytes')
  const value = bytesToBigInt(bytes)
  let chars = ''
  for (let index = CODE_CHARS - 1; index >= 0; index -= 1) chars += CROCKFORD[Number((value >> BigInt(index * 5)) & 31n)]
  chars += checkSymbol(value)
  return chars.match(/.{5}/g)!.join('-')
}

export function generateRecoveryCode(): { display: string; bytes: Uint8Array } {
  const bytes = randomBytes(RECOVERY_CODE_BYTES)
  return { display: formatRecoveryCode(bytes), bytes }
}

export function parseRecoveryCode(text: string): Uint8Array {
  const compact = text
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  if (compact.length !== CODE_CHARS + 1) throw new ValidationError('RECOVERY_CODE')
  let value = 0n
  for (const char of compact.slice(0, CODE_CHARS)) {
    const digit = CROCKFORD.indexOf(char)
    if (digit < 0) throw new ValidationError('RECOVERY_CODE')
    value = (value << 5n) | BigInt(digit)
  }
  if (checkSymbol(value) !== compact[CODE_CHARS]) throw new ValidationError('RECOVERY_CODE')
  const bytes = new Uint8Array(RECOVERY_CODE_BYTES)
  for (let index = RECOVERY_CODE_BYTES - 1; index >= 0; index -= 1) {
    bytes[index] = Number(value & 0xffn)
    value >>= 8n
  }
  return bytes
}
