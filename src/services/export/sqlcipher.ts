import { copyToBuffer } from '../../crypto/encoding'

export const SQLCIPHER_PAGE_SIZE = 4096
export const SQLCIPHER_RESERVE = 80
export const SQLCIPHER_KDF_ITERATIONS = 256_000
export const SQLCIPHER_HMAC_ITERATIONS = 2
export const SQLCIPHER_SALT_BYTES = 16
const IV_BYTES = 16
const HMAC_BYTES = 64
const HMAC_SALT_MASK = 0x3a
const BATCH = 64

export type RandomSource = (length: number) => Uint8Array

function defaultRandom(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

async function pbkdf2Sha512(secret: Uint8Array, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey('raw', copyToBuffer(secret), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-512', salt: copyToBuffer(salt), iterations }, material, 256)
  return new Uint8Array(bits)
}

export function assertSqlcipherReady(plain: Uint8Array): void {
  if (plain.byteLength === 0 || plain.byteLength % SQLCIPHER_PAGE_SIZE !== 0) throw new Error('Database size is not a whole number of 4096-byte pages')
  if (new TextDecoder().decode(plain.subarray(0, 15)) !== 'SQLite format 3') throw new Error('Not a SQLite database')
  if (((plain[16] << 8) | plain[17]) !== SQLCIPHER_PAGE_SIZE) throw new Error('SQLCipher 4 needs 4096-byte pages')
  if (plain[18] !== 1 || plain[19] !== 1) throw new Error('SQLCipher 4 needs the legacy (rollback) journal format')
  if (plain[20] !== SQLCIPHER_RESERVE) throw new Error('SQLCipher 4 needs 80 reserved bytes per page')
}

export async function encryptSqlcipher4(plain: Uint8Array, password: string, random: RandomSource = defaultRandom): Promise<Uint8Array> {
  assertSqlcipherReady(plain)
  const salt = random(SQLCIPHER_SALT_BYTES)
  const passwordBytes = new TextEncoder().encode(password)
  const key = await pbkdf2Sha512(passwordBytes, salt, SQLCIPHER_KDF_ITERATIONS)
  passwordBytes.fill(0)
  const hmacKeyBytes = await pbkdf2Sha512(key, salt.map((byte) => byte ^ HMAC_SALT_MASK), SQLCIPHER_HMAC_ITERATIONS)
  const aes = await crypto.subtle.importKey('raw', copyToBuffer(key), 'AES-CBC', false, ['encrypt'])
  const hmac = await crypto.subtle.importKey('raw', copyToBuffer(hmacKeyBytes), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign'])
  key.fill(0)
  hmacKeyBytes.fill(0)

  const out = new Uint8Array(plain.byteLength)
  out.set(salt, 0)
  const pages = plain.byteLength / SQLCIPHER_PAGE_SIZE
  const end = SQLCIPHER_PAGE_SIZE - SQLCIPHER_RESERVE
  const ivs = Array.from({ length: pages }, () => random(IV_BYTES))

  async function encryptPage(pageNumber: number): Promise<void> {
    const base = (pageNumber - 1) * SQLCIPHER_PAGE_SIZE
    const start = pageNumber === 1 ? SQLCIPHER_SALT_BYTES : 0
    const iv = ivs[pageNumber - 1]
    const padded = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-CBC', iv: copyToBuffer(iv) }, aes, copyToBuffer(plain.subarray(base + start, base + end))),
    )
    const cipher = padded.subarray(0, end - start)
    const macInput = new Uint8Array(cipher.byteLength + IV_BYTES + 4)
    macInput.set(cipher, 0)
    macInput.set(iv, cipher.byteLength)
    new DataView(macInput.buffer).setUint32(cipher.byteLength + IV_BYTES, pageNumber, true)
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hmac, macInput))
    out.set(cipher, base + start)
    out.set(iv, base + end)
    out.set(mac.subarray(0, HMAC_BYTES), base + end + IV_BYTES)
  }

  for (let first = 1; first <= pages; first += BATCH) {
    const batch: Promise<void>[] = []
    for (let page = first; page < first + BATCH && page <= pages; page += 1) batch.push(encryptPage(page))
    await Promise.all(batch)
  }
  return out
}
