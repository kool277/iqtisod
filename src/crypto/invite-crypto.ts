import { argon2idBits } from './argon2'
import { IV_BYTES, randomBytes } from './crypto.service'
import { bytesToBase64, copyToBuffer } from './encoding'
import type { Argon2Params } from './kdf'
import { LABELS, b64urlToBytes, hkdfAesKey, hkdfRaw } from './sign'
import { SUITE } from './suite'

const ED25519_PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20])

export type InviteKeys = { kek: CryptoKey; sigPriv: CryptoKey; sigPub: string }

/** `bits = Argon2id(code)`, then the invite KEK and a deterministic invite Ed25519 key, both from HKDF of those bits. */
export async function deriveInviteKeys(code: string, salt: Uint8Array, kdf: Argon2Params): Promise<InviteKeys> {
  const bits = await argon2idBits(code, salt, kdf)
  const seed = await hkdfRaw(bits, `${LABELS.invite}|sig`)
  const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + seed.length)
  pkcs8.set(ED25519_PKCS8_PREFIX)
  pkcs8.set(seed, ED25519_PKCS8_PREFIX.length)
  try {
    const kek = await hkdfAesKey(bits, new Uint8Array(0), `${LABELS.invite}|kek`, ['wrapKey', 'unwrapKey'])
    const extractable = await crypto.subtle.importKey('pkcs8', copyToBuffer(pkcs8), { name: 'Ed25519' }, true, ['sign'])
    const jwk = await crypto.subtle.exportKey('jwk', extractable)
    if (typeof jwk.x !== 'string') throw new Error('Key has no public part')
    const sigPriv = await crypto.subtle.importKey('pkcs8', copyToBuffer(pkcs8), { name: 'Ed25519' }, false, ['sign'])
    return { kek, sigPriv, sigPub: bytesToBase64(b64urlToBytes(jwk.x)) }
  } finally {
    bits.fill(0)
    seed.fill(0)
    pkcs8.fill(0)
  }
}

export function inviteAad(vaultId: string, id: string, kind: string, email: string, expiresAt: string): Uint8Array {
  return new TextEncoder().encode(`${LABELS.invite}|${vaultId}|${id}|${kind}|${email}|${expiresAt}|${SUITE}`)
}

export async function wrapDekForInvite(dek: CryptoKey, kek: CryptoKey, aad: Uint8Array): Promise<{ iv: Uint8Array; cipherText: ArrayBuffer }> {
  const iv = randomBytes(IV_BYTES)
  const cipherText = await crypto.subtle.wrapKey('raw', dek, kek, { name: 'AES-GCM', iv: copyToBuffer(iv), additionalData: copyToBuffer(aad) })
  return { iv, cipherText }
}

export async function unwrapInviteDek(wrapped: ArrayBuffer, kek: CryptoKey, iv: Uint8Array, aad: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey('raw', wrapped, kek, { name: 'AES-GCM', iv: copyToBuffer(iv), additionalData: copyToBuffer(aad) }, { name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ])
}
