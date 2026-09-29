import { IV_BYTES, derivePbkdf2Bits, randomBytes, type KdfParams } from './crypto.service'
import { bytesToHex, copyToBuffer } from './encoding'

export const GRANT_KEK_INFO = 'moliya/grant-kek/v1'
export const GRANT_VERIFIER_INFO = 'moliya/grant-verifier/v1'
export const TOTP_KEK_INFO = 'moliya/totp-kek/v1'
export const TOTP_RECOVERY_INFO = 'moliya/totp-recovery/v1'

async function hkdfKey(bits: Uint8Array, info: string, usages: KeyUsage[]): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', copyToBuffer(bits), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(info) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    usages,
  )
}

async function hkdfHex(bits: Uint8Array, info: string): Promise<string> {
  const material = await crypto.subtle.importKey('raw', copyToBuffer(bits), 'HKDF', false, ['deriveBits'])
  const out = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(info) }, material, 256),
  )
  try {
    return bytesToHex(out)
  } finally {
    out.fill(0)
  }
}

export function grantAad(id: string, kind: string, email: string): Uint8Array {
  return new TextEncoder().encode(`moliya/grant/v1|${id}|${kind}|${email}`)
}

export async function deriveGrantKeys(code: string, salt: Uint8Array, kdf: KdfParams): Promise<{ kek: CryptoKey; verifier: string }> {
  const bits = await derivePbkdf2Bits(code, salt, kdf)
  try {
    return { kek: await hkdfKey(bits, GRANT_KEK_INFO, ['wrapKey', 'unwrapKey']), verifier: await hkdfHex(bits, GRANT_VERIFIER_INFO) }
  } finally {
    bits.fill(0)
  }
}

export async function wrapDekForGrant(dek: CryptoKey, kek: CryptoKey, aad: Uint8Array): Promise<{ iv: Uint8Array; cipherText: ArrayBuffer }> {
  const iv = randomBytes(IV_BYTES)
  const cipherText = await crypto.subtle.wrapKey('raw', dek, kek, { name: 'AES-GCM', iv: copyToBuffer(iv), additionalData: copyToBuffer(aad) })
  return { iv, cipherText }
}

export async function unwrapGrantDek(wrapped: ArrayBuffer, kek: CryptoKey, iv: Uint8Array, aad: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey(
    'raw',
    wrapped,
    kek,
    { name: 'AES-GCM', iv: copyToBuffer(iv), additionalData: copyToBuffer(aad) },
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  )
}

export async function deriveTotpKek(password: string, salt: Uint8Array, kdf: KdfParams): Promise<CryptoKey> {
  const bits = await derivePbkdf2Bits(password, salt, kdf)
  try {
    return await hkdfKey(bits, TOTP_KEK_INFO, ['encrypt', 'decrypt'])
  } finally {
    bits.fill(0)
  }
}

export async function recoveryCodeHash(code: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', copyToBuffer(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${TOTP_RECOVERY_INFO}|${code}`))
  return bytesToHex(new Uint8Array(mac))
}
