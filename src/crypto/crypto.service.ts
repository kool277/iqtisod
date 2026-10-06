import { bytesToHex, copyToBuffer } from './encoding'

export type KdfHash = 'SHA-256' | 'SHA-384' | 'SHA-512'

export type KdfParams = {
  name: 'PBKDF2'
  hash: KdfHash
  iterations: number
}

export const LEGACY_KDF: KdfParams = { name: 'PBKDF2', hash: 'SHA-256', iterations: 200_000 }
export const CURRENT_KDF: KdfParams = { name: 'PBKDF2', hash: 'SHA-256', iterations: 600_000 }
export const KDF_ITERATION_BOUNDS = { min: 100_000, max: 2_000_000 } as const
export const KDF_HASHES: readonly KdfHash[] = ['SHA-256', 'SHA-384', 'SHA-512']

export const SALT_BYTES = 32
export const SALT_BOUNDS = { min: 16, max: 64 } as const
export const IV_BYTES = 12
export const DEK_BYTES = 32
export const GCM_TAG_BYTES = 16
export const WRAPPED_DEK_BYTES = DEK_BYTES + GCM_TAG_BYTES

export type CipherPayload = {
  cipherText: ArrayBuffer
  iv: Uint8Array
}

export function isKdfParams(value: unknown): value is KdfParams {
  if (typeof value !== 'object' || value === null) return false
  const kdf = value as Record<string, unknown>
  return (
    kdf.name === 'PBKDF2' &&
    typeof kdf.hash === 'string' &&
    (KDF_HASHES as readonly string[]).includes(kdf.hash) &&
    Number.isSafeInteger(kdf.iterations) &&
    (kdf.iterations as number) >= KDF_ITERATION_BOUNDS.min &&
    (kdf.iterations as number) <= KDF_ITERATION_BOUNDS.max
  )
}

export function kdfNeedsUpgrade(kdf: KdfParams): boolean {
  return kdf.name !== CURRENT_KDF.name || kdf.hash !== CURRENT_KDF.hash || kdf.iterations < CURRENT_KDF.iterations
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

async function importPassphrase(passphrase: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveBits'])
}

export const VERIFIER_INFO = 'moliya/verifier/v1'

export async function derivePbkdf2Bits(passphrase: string, salt: Uint8Array, kdf: KdfParams): Promise<Uint8Array> {
  if (!isKdfParams(kdf)) throw new Error('Unsupported key derivation parameters')
  const material = await importPassphrase(passphrase)
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: copyToBuffer(salt),
      iterations: kdf.iterations,
      hash: kdf.hash,
    },
    material,
    256,
  )
  return new Uint8Array(bits)
}

async function importAesKey(raw: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', copyToBuffer(raw), { name: 'AES-GCM', length: 256 }, false, usages)
}

export async function hkdfBits(ikm: Uint8Array, salt: Uint8Array, info: string): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey('raw', copyToBuffer(ikm), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: copyToBuffer(salt), info: new TextEncoder().encode(info) },
    material,
    256,
  )
  return new Uint8Array(bits)
}

export async function verifierFromBits(raw: Uint8Array): Promise<string> {
  const bits = await hkdfBits(raw, new Uint8Array(0), VERIFIER_INFO)
  try {
    return bytesToHex(bits)
  } finally {
    bits.fill(0)
  }
}

export async function deriveKeyAndVerifier(
  passphrase: string,
  salt: Uint8Array,
  kdf: KdfParams = CURRENT_KDF,
): Promise<{ key: CryptoKey; verifier: string }> {
  const raw = await derivePbkdf2Bits(passphrase, salt, kdf)
  try {
    const verifier = await verifierFromBits(raw)
    const key = await importAesKey(raw, ['wrapKey', 'unwrapKey'])
    return { key, verifier }
  } finally {
    raw.fill(0)
  }
}

export async function deriveKey(passphrase: string, salt: Uint8Array, kdf: KdfParams = CURRENT_KDF): Promise<CryptoKey> {
  const { key } = await deriveKeyAndVerifier(passphrase, salt, kdf)
  return key
}

export async function passwordVerifier(passphrase: string, salt: Uint8Array, kdf: KdfParams = CURRENT_KDF): Promise<string> {
  const { verifier } = await deriveKeyAndVerifier(passphrase, salt, kdf)
  return verifier
}

export async function generateDek(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
}

/** Encrypts `data` where it is; the caller still owns it and wipes it afterwards. */
export async function encryptDatabase(data: Uint8Array, key: CryptoKey): Promise<CipherPayload> {
  const iv = randomBytes(IV_BYTES)
  const plain = data.buffer instanceof ArrayBuffer ? (data as Uint8Array<ArrayBuffer>) : null
  const copy = plain ? null : copyToBuffer(data)
  try {
    const cipherText = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: copyToBuffer(iv) }, key, plain ?? copy!)
    return { cipherText, iv }
  } finally {
    if (copy) new Uint8Array(copy).fill(0)
  }
}

export async function decryptDatabase(
  cipherText: ArrayBuffer,
  key: CryptoKey,
  iv: Uint8Array,
): Promise<Uint8Array> {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: copyToBuffer(iv) },
    key,
    cipherText,
  )
  return new Uint8Array(plain)
}

/** Wraps written from 1.4.2 carry `aad: WRAP_AAD_V1` and bind their `userId`; older wraps have no additional data. */
export const WRAP_AAD_V1 = 'moliya/wrap/v1'

export function wrapAad(userId: string): Uint8Array {
  return new TextEncoder().encode(`${WRAP_AAD_V1}|${userId}`)
}

function gcmParams(iv: Uint8Array, aad?: Uint8Array): AesGcmParams {
  return aad ? { name: 'AES-GCM', iv: copyToBuffer(iv), additionalData: copyToBuffer(aad) } : { name: 'AES-GCM', iv: copyToBuffer(iv) }
}

export async function wrapDek(dek: CryptoKey, kek: CryptoKey, aad?: Uint8Array): Promise<CipherPayload> {
  const iv = randomBytes(IV_BYTES)
  const cipherText = await crypto.subtle.wrapKey('raw', dek, kek, gcmParams(iv, aad))
  return { cipherText, iv }
}

export async function unwrapDek(wrapped: ArrayBuffer, kek: CryptoKey, iv: Uint8Array, aad?: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey('raw', wrapped, kek, gcmParams(iv, aad), { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
}
