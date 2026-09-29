import { copyToBuffer } from '../crypto/encoding'

export const TOTP_SECRET_BYTES = 20
export const TOTP_DIGITS = 6
export const TOTP_PERIOD_SECONDS = 30
export const TOTP_WINDOW = 1
export const TOTP_ISSUER = 'Jaybi'

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '')
  const out: number[] = []
  let bits = 0
  let value = 0
  for (const char of clean) {
    const digit = BASE32.indexOf(char)
    if (digit < 0) throw new Error('Invalid base32')
    value = ((value << 5) | digit) & 0xffff
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

export function importTotpKey(secret: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', copyToBuffer(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
}

export async function hotp(key: CryptoKey, counter: number, digits = TOTP_DIGITS): Promise<string> {
  const message = new DataView(new ArrayBuffer(8))
  message.setUint32(0, Math.floor(counter / 2 ** 32))
  message.setUint32(4, counter >>> 0)
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message.buffer))
  const offset = mac[mac.length - 1] & 0x0f
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3]
  return String(binary % 10 ** digits).padStart(digits, '0')
}

export function timeStep(nowMs: number, period = TOTP_PERIOD_SECONDS): number {
  return Math.floor(nowMs / 1000 / period)
}

export function totpAt(key: CryptoKey, nowMs: number, digits = TOTP_DIGITS): Promise<string> {
  return hotp(key, timeStep(nowMs), digits)
}

function sameDigits(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let diff = 0
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return diff === 0
}

export function isTotpCode(text: string): boolean {
  return /^\d{6}$/.test(text.replace(/\s/g, ''))
}

export async function verifyTotp(key: CryptoKey, code: string, nowMs: number, lastStep: number): Promise<number | null> {
  const clean = code.replace(/\s/g, '')
  if (!isTotpCode(clean)) return null
  const current = timeStep(nowMs)
  let accepted: number | null = null
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step += 1) {
    if (step <= lastStep) continue
    if (sameDigits(await hotp(key, step), clean) && accepted === null) accepted = step
  }
  return accepted
}

export function otpauthUri(secret: Uint8Array, account: string): string {
  const label = encodeURIComponent(`${TOTP_ISSUER}:${account}`)
  const params = `secret=${base32Encode(secret)}&issuer=${TOTP_ISSUER}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`
  return `otpauth://totp/${label}?${params}`
}
