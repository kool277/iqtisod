import { argon2idBits } from './argon2'
import { IV_BYTES, randomBytes } from './crypto.service'
import { base64ToBytes, bytesToBase64, copyToBuffer } from './encoding'
import { ARGON2_DEFAULT, copyArgon2Params, type Argon2Params } from './kdf'
import { LABELS, b64urlToBytes, hkdfAesKey } from './sign'
import { SUITE, type Suite } from './suite'

export const IDENTITY_SALT_BYTES = 16

/** One per member, in the vault header. The public keys are a hint: verification takes keys from the signed roster. */
export type IdentityBlob = {
  v: 2
  suite: Suite
  memberId: string
  email: string
  kdf: Argon2Params
  salt: string
  iv: string
  sealed: string
  encPub: string
  sigPub: string
}

export type IdentityKeys = {
  encPriv: CryptoKey
  sigPriv: CryptoKey
  encPub: string
  sigPub: string
}

/** Private key bytes, held only long enough to seal or re-seal them. */
export type IdentitySecret = { enc: Uint8Array; sig: Uint8Array }

export function identityAad(vaultId: string, memberId: string, encPub: string, sigPub: string): Uint8Array {
  return new TextEncoder().encode(`${LABELS.identityWrap}|${vaultId}|${memberId}|${SUITE}|${encPub}|${sigPub}`)
}

export async function generateIdentitySecret(): Promise<IdentitySecret> {
  const enc = (await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair
  const sig = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  return {
    enc: new Uint8Array(await crypto.subtle.exportKey('pkcs8', enc.privateKey)),
    sig: new Uint8Array(await crypto.subtle.exportKey('pkcs8', sig.privateKey)),
  }
}

async function publicFromPkcs8(pkcs8: Uint8Array, name: 'X25519' | 'Ed25519'): Promise<string> {
  const usages: KeyUsage[] = name === 'X25519' ? ['deriveBits'] : ['sign']
  const key = await crypto.subtle.importKey('pkcs8', copyToBuffer(pkcs8), { name }, true, usages)
  const jwk = await crypto.subtle.exportKey('jwk', key)
  if (typeof jwk.x !== 'string') throw new Error('Key has no public part')
  return bytesToBase64(b64urlToBytes(jwk.x))
}

/** Imports the private keys non-extractable and reads their public halves. */
export async function importIdentity(secret: IdentitySecret): Promise<IdentityKeys> {
  const [encPub, sigPub] = await Promise.all([publicFromPkcs8(secret.enc, 'X25519'), publicFromPkcs8(secret.sig, 'Ed25519')])
  const encPriv = await crypto.subtle.importKey('pkcs8', copyToBuffer(secret.enc), { name: 'X25519' }, false, ['deriveBits'])
  const sigPriv = await crypto.subtle.importKey('pkcs8', copyToBuffer(secret.sig), { name: 'Ed25519' }, false, ['sign'])
  return { encPriv, sigPriv, encPub, sigPub }
}

function pack(secret: IdentitySecret): Uint8Array {
  const out = new Uint8Array(4 + secret.enc.length + secret.sig.length)
  const view = new DataView(out.buffer)
  view.setUint16(0, secret.enc.length)
  out.set(secret.enc, 2)
  view.setUint16(2 + secret.enc.length, secret.sig.length)
  out.set(secret.sig, 4 + secret.enc.length)
  return out
}

function unpack(bytes: Uint8Array): IdentitySecret {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const encLength = view.getUint16(0)
  const sigAt = 2 + encLength
  if (sigAt + 2 > bytes.length) throw new Error('Sealed identity is damaged')
  const sigLength = view.getUint16(sigAt)
  if (sigAt + 2 + sigLength !== bytes.length) throw new Error('Sealed identity is damaged')
  return { enc: bytes.slice(2, sigAt), sig: bytes.slice(sigAt + 2) }
}

async function passwordKek(password: string, salt: Uint8Array, kdf: Argon2Params): Promise<CryptoKey> {
  const bits = await argon2idBits(password, salt, kdf)
  try {
    return await hkdfAesKey(bits, new Uint8Array(0), `${LABELS.identityWrap}|kek`, ['encrypt', 'decrypt'])
  } finally {
    bits.fill(0)
  }
}

export async function sealIdentity(
  secret: IdentitySecret,
  input: { vaultId: string; memberId: string; email: string; password: string },
  kdf: Argon2Params = ARGON2_DEFAULT,
): Promise<IdentityBlob> {
  const keys = await importIdentity(secret)
  const salt = randomBytes(IDENTITY_SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const kek = await passwordKek(input.password, salt, kdf)
  const plain = pack(secret)
  try {
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: copyToBuffer(iv), additionalData: copyToBuffer(identityAad(input.vaultId, input.memberId, keys.encPub, keys.sigPub)) },
      kek,
      copyToBuffer(plain),
    )
    return {
      v: 2,
      suite: SUITE,
      memberId: input.memberId,
      email: input.email,
      kdf: copyArgon2Params(kdf),
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      sealed: bytesToBase64(new Uint8Array(sealed)),
      encPub: keys.encPub,
      sigPub: keys.sigPub,
    }
  } finally {
    plain.fill(0)
  }
}

/** A failed AES-GCM open is the password check: there is no separate verifier for v2 members. Throws on any failure. */
export async function openIdentitySecret(blob: IdentityBlob, vaultId: string, password: string): Promise<IdentitySecret> {
  const kek = await passwordKek(password, base64ToBytes(blob.salt), blob.kdf)
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: copyToBuffer(base64ToBytes(blob.iv)), additionalData: copyToBuffer(identityAad(vaultId, blob.memberId, blob.encPub, blob.sigPub)) },
      kek,
      copyToBuffer(base64ToBytes(blob.sealed)),
    ),
  )
  try {
    return unpack(plain)
  } finally {
    plain.fill(0)
  }
}

/** Opens the blob and checks its private keys belong to the public keys it names. */
export async function unsealIdentity(blob: IdentityBlob, vaultId: string, password: string): Promise<IdentityKeys> {
  const secret = await openIdentitySecret(blob, vaultId, password)
  try {
    const keys = await importIdentity(secret)
    if (keys.encPub !== blob.encPub || keys.sigPub !== blob.sigPub) throw new Error('Identity keys do not match')
    return keys
  } finally {
    wipeSecret(secret)
  }
}

export function wipeSecret(secret: IdentitySecret): void {
  secret.enc.fill(0)
  secret.sig.fill(0)
}