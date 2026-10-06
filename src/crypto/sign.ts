import { signedBytes } from './canonical'
import { base64ToBytes, bytesToBase64, bytesToHex, copyToBuffer } from './encoding'

export const LABELS = {
  identityWrap: 'moliya/v2/identity-wrap',
  dekWrap: 'moliya/v2/dek-wrap',
  dekWrapAad: 'moliya/v2/dek-wrap-aad',
  roster: 'moliya/v2/roster',
  header: 'moliya/v2/header',
  invite: 'moliya/v2/invite',
  binding: 'moliya/v2/binding',
} as const

const B64 = /^[A-Za-z0-9+/]*={0,2}$/

export function isBase64(value: unknown, bytes?: number): value is string {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !B64.test(value)) return false
  if (bytes === undefined) return true
  try {
    return base64ToBytes(value).length === bytes
  } catch {
    return false
  }
}

export function b64urlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  return base64ToBytes(padded + '='.repeat((4 - (padded.length % 4)) % 4))
}

export async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', copyToBuffer(data)))
}

export async function sha256HexOf(data: Uint8Array): Promise<string> {
  return bytesToHex(await sha256Bytes(data))
}

export async function hkdfAesKey(ikm: Uint8Array, salt: Uint8Array, info: string, usages: KeyUsage[]): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', copyToBuffer(ikm), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: copyToBuffer(salt), info: new TextEncoder().encode(info) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    usages,
  )
}

export async function hkdfRaw(ikm: Uint8Array, info: string): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey('raw', copyToBuffer(ikm), 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(info) }, material, 256))
}

export async function importSigPub(sigPub: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', copyToBuffer(base64ToBytes(sigPub)), { name: 'Ed25519' }, true, ['verify'])
}

export async function importEncPub(encPub: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', copyToBuffer(base64ToBytes(encPub)), { name: 'X25519' }, true, [])
}

export async function exportPub(key: CryptoKey): Promise<string> {
  return bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('raw', key)))
}

export async function signPayload(label: string, payload: unknown, sigPriv: CryptoKey): Promise<string> {
  return bytesToBase64(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, sigPriv, copyToBuffer(signedBytes(label, payload)))))
}

/** False for any malformed key, signature or payload; never throws. */
export async function verifyPayload(label: string, payload: unknown, signature: unknown, sigPub: unknown): Promise<boolean> {
  if (!isBase64(signature, 64) || !isBase64(sigPub, 32)) return false
  try {
    const key = await importSigPub(sigPub)
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, copyToBuffer(base64ToBytes(signature)), copyToBuffer(signedBytes(label, payload)))
  } catch {
    return false
  }
}

/** `hex(sha256(raw sigPub))[0:32]`, the value pinned in the header. */
export async function fingerprintOf(sigPub: string): Promise<string> {
  return (await sha256HexOf(base64ToBytes(sigPub))).slice(0, 32)
}

/** The first 24 hex characters in groups of four, for reading out loud. */
export function formatFingerprint(fingerprint: string): string {
  return (fingerprint.slice(0, 24).toUpperCase().match(/.{1,4}/g) ?? []).join(' ')
}
