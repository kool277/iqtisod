import { describe, expect, it } from 'vitest'
import { CURRENT_KDF, deriveKey, derivePbkdf2Bits, randomBytes, verifierFromBits } from '../../src/crypto/crypto.service'
import {
  DecryptError,
  MAX_PLAINTEXT_BYTES,
  PAD_BLOCK,
  PERSONAL_KEY_USAGES,
  SAFE_KEY_USAGES,
  aad,
  derivePersonalKek,
  deriveRecoveryKek,
  formatRecoveryCode,
  generateAesKey,
  generateRecoveryCode,
  openJson,
  pad,
  parseRecoveryCode,
  sealJson,
  unpad,
  unwrapWithAad,
  wrapWithAad,
  type Sealed,
} from '../../src/crypto/safe-crypto'
import { base64ToBytes, bytesToBase64, copyToBuffer } from '../../src/crypto/encoding'
import { ValidationError } from '../../src/domain/errors'

function flip(base64: string, index: number): string {
  const bytes = base64ToBytes(base64)
  bytes[index] ^= 1
  return bytesToBase64(bytes)
}

describe('safe crypto', () => {
  it('pads every plaintext to a 256-byte bucket and refuses oversized ones', () => {
    for (const size of [0, 1, 251, 252, 253, 1000]) {
      const padded = pad(new Uint8Array(size).fill(7))
      expect(padded.byteLength % PAD_BLOCK).toBe(0)
      expect(padded.byteLength).toBeGreaterThanOrEqual(size + 4)
      expect(unpad(padded)).toEqual(new Uint8Array(size).fill(7))
    }
    expect(pad(new Uint8Array(252)).byteLength).toBe(256)
    expect(pad(new Uint8Array(253)).byteLength).toBe(512)
    expect(() => pad(new Uint8Array(MAX_PLAINTEXT_BYTES))).toThrow(ValidationError)
    const tampered = pad(new Uint8Array(3))
    tampered[200] = 1
    expect(() => unpad(tampered)).toThrow(DecryptError)
  })

  it('pads safe items to power-of-two size classes from 1 KiB, still readable by the 256-byte unpad', () => {
    const cases: [number, number][] = [[0, 1024], [1, 1024], [1020, 1024], [1021, 2048], [2044, 2048], [2045, 4096], [9000, 16384], [MAX_PLAINTEXT_BYTES - 4, MAX_PLAINTEXT_BYTES]]
    for (const [size, expected] of cases) {
      const padded = pad(new Uint8Array(size).fill(9), { sizeClasses: true })
      expect(padded.byteLength, String(size)).toBe(expected)
      expect(unpad(padded)).toEqual(new Uint8Array(size).fill(9))
    }
    expect(() => pad(new Uint8Array(MAX_PLAINTEXT_BYTES - 3), { sizeClasses: true })).toThrow(ValidationError)
  })

  it('gives a card and a short note the same ciphertext size', async () => {
    const key = await generateAesKey(SAFE_KEY_USAGES)
    const card = await sealJson({ kind: 'CARD', number: '4111111111111111', cvv: '737', title: 'Visa' }, key, aad('moliya.item', 'u', 's', 'i', 1))
    const note = await sealJson({ kind: 'NOTE', body: 'hi' }, key, aad('moliya.item', 'u', 's', 'j', 1))
    expect(base64ToBytes(card.ct).byteLength).toBe(base64ToBytes(note.ct).byteLength)
  })

  it('fails to open with a wrong key, any changed AAD part, or a flipped bit', async () => {
    const key = await generateAesKey(SAFE_KEY_USAGES)
    const parts = ['user-1', 'safe-1', 'item-1', 3] as const
    const sealed = await sealJson({ secret: 'value' }, key, aad('moliya.item', ...parts))
    await expect(openJson(sealed, key, aad('moliya.item', ...parts))).resolves.toEqual({ secret: 'value' })

    const variants: Uint8Array[] = [
      aad('moliya.safe-meta', ...parts),
      new TextEncoder().encode(JSON.stringify(['moliya.item', 2, ...parts])),
      aad('moliya.item', 'user-2', 'safe-1', 'item-1', 3),
      aad('moliya.item', 'user-1', 'safe-2', 'item-1', 3),
      aad('moliya.item', 'user-1', 'safe-1', 'item-2', 3),
      aad('moliya.item', 'user-1', 'safe-1', 'item-1', 4),
    ]
    for (const data of variants) await expect(openJson(sealed, key, data)).rejects.toBeInstanceOf(DecryptError)
    await expect(openJson(sealed, await generateAesKey(SAFE_KEY_USAGES), aad('moliya.item', ...parts))).rejects.toBeInstanceOf(DecryptError)
    const badIv: Sealed = { ...sealed, iv: flip(sealed.iv, 0) }
    const badCt: Sealed = { ...sealed, ct: flip(sealed.ct, 5) }
    await expect(openJson(badIv, key, aad('moliya.item', ...parts))).rejects.toBeInstanceOf(DecryptError)
    await expect(openJson(badCt, key, aad('moliya.item', ...parts))).rejects.toBeInstanceOf(DecryptError)
  })

  it('wraps keys with AAD and never lets a non-extractable key be exported', async () => {
    const wrapping = await generateAesKey(PERSONAL_KEY_USAGES)
    const key = await generateAesKey(SAFE_KEY_USAGES)
    const data = aad('moliya.safe-key', 'user-1', 'safe-1', 1)
    const wrapped = await wrapWithAad(key, wrapping, data)
    const session = await unwrapWithAad(wrapped, wrapping, data, { extractable: false, usages: SAFE_KEY_USAGES })
    await expect(crypto.subtle.exportKey('raw', session)).rejects.toBeTruthy()
    const sealed = await sealJson('x', key, data)
    await expect(openJson(sealed, session, data)).resolves.toBe('x')
    await expect(unwrapWithAad(wrapped, wrapping, aad('moliya.safe-key', 'user-1', 'safe-1', 2), { extractable: false, usages: SAFE_KEY_USAGES })).rejects.toBeInstanceOf(DecryptError)
  })

  it('separates the personal KEK from the vault KEK and the stored verifier', async () => {
    const salt = randomBytes(32)
    const kdf = { ...CURRENT_KDF }
    const personal = await derivePersonalKek('hunter2hunter2', salt, kdf)
    const vaultKek = await deriveKey('hunter2hunter2', salt, kdf)
    const item = await generateAesKey(SAFE_KEY_USAGES)
    const data = aad('moliya.pk', 'user-1')
    const wrapped = await wrapWithAad(item, personal, data)
    await expect(unwrapWithAad(wrapped, vaultKek, data, { extractable: false, usages: SAFE_KEY_USAGES })).rejects.toBeInstanceOf(DecryptError)

    const raw = await derivePbkdf2Bits('hunter2hunter2', salt, kdf)
    const verifier = await verifierFromBits(raw)
    expect(verifier).toMatch(/^[0-9a-f]{64}$/)
    expect(verifier).not.toBe(Buffer.from(raw).toString('hex'))
    for (const material of [raw, new Uint8Array(Buffer.from(verifier, 'hex'))]) {
      const direct = await crypto.subtle.importKey('raw', copyToBuffer(material), 'AES-GCM', false, ['unwrapKey'])
      await expect(unwrapWithAad(wrapped, direct, data, { extractable: false, usages: SAFE_KEY_USAGES })).rejects.toBeInstanceOf(DecryptError)
    }
  })

  it('formats, parses, and checks recovery codes', async () => {
    const { display, bytes } = generateRecoveryCode()
    expect(display).toMatch(/^[0-9A-Z*~$=]{5}(-[0-9A-Z*~$=]{5}){4}$/)
    expect(parseRecoveryCode(display)).toEqual(bytes)
    expect(parseRecoveryCode(display.toLowerCase().replace(/-/g, ' '))).toEqual(bytes)
    expect(formatRecoveryCode(parseRecoveryCode(display))).toBe(display)

    const zeros = new Uint8Array(15)
    const zeroCode = formatRecoveryCode(zeros)
    expect(zeroCode).toBe('00000-00000-00000-00000-00000')
    expect(parseRecoveryCode(zeroCode.replace(/0/g, 'O'))).toEqual(zeros)

    const chars = display.replace(/-/g, '').split('')
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
    chars[3] = alphabet[(alphabet.indexOf(chars[3]) + 1) % alphabet.length]
    expect(() => parseRecoveryCode(chars.join(''))).toThrow(ValidationError)
    expect(() => parseRecoveryCode('short')).toThrow(ValidationError)

    const salt = randomBytes(16)
    const kek = await deriveRecoveryKek(bytes, salt)
    const other = await deriveRecoveryKek(parseRecoveryCode(formatRecoveryCode(randomBytes(15))), salt)
    const key = await generateAesKey(PERSONAL_KEY_USAGES)
    const data = aad('moliya.pk-recovery', 'user-1')
    const wrapped = await wrapWithAad(key, kek, data)
    await expect(unwrapWithAad(wrapped, other, data, { extractable: false, usages: PERSONAL_KEY_USAGES })).rejects.toBeInstanceOf(DecryptError)
    await expect(unwrapWithAad(wrapped, kek, data, { extractable: false, usages: PERSONAL_KEY_USAGES })).resolves.toBeTruthy()
  })
})
