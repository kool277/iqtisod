import { describe, expect, it } from 'vitest'
import {
  CURRENT_KDF,
  IV_BYTES,
  KDF_ITERATION_BOUNDS,
  LEGACY_KDF,
  SALT_BYTES,
  decryptDatabase,
  deriveKey,
  encryptDatabase,
  generateDek,
  passwordVerifier,
  randomBytes,
  isKdfParams,
  kdfNeedsUpgrade,
  unwrapDek,
  wrapDek,
} from '../../src/crypto/crypto.service'

describe('crypto service', () => {
  it('wraps new keys with PBKDF2-SHA-256 at the OWASP 600,000 iterations and a 32-byte salt', () => {
    expect(CURRENT_KDF).toEqual({ name: 'PBKDF2', hash: 'SHA-256', iterations: 600_000 })
    expect(LEGACY_KDF).toEqual({ name: 'PBKDF2', hash: 'SHA-256', iterations: 200_000 })
    expect(SALT_BYTES).toBe(32)
    expect(IV_BYTES).toBe(12)
  })

  it('accepts every parameter set ever written and rejects out-of-bounds ones', () => {
    expect(isKdfParams(LEGACY_KDF)).toBe(true)
    expect(isKdfParams(CURRENT_KDF)).toBe(true)
    expect(isKdfParams({ name: 'PBKDF2', hash: 'SHA-512', iterations: 1_000_000 })).toBe(true)
    expect(isKdfParams({ name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATION_BOUNDS.min - 1 })).toBe(false)
    expect(isKdfParams({ name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATION_BOUNDS.max + 1 })).toBe(false)
    expect(isKdfParams({ name: 'PBKDF2', hash: 'MD5', iterations: 600_000 })).toBe(false)
    expect(isKdfParams({ name: 'scrypt', hash: 'SHA-256', iterations: 600_000 })).toBe(false)
    expect(isKdfParams({ name: 'PBKDF2', hash: 'SHA-256', iterations: 600_000.5 })).toBe(false)
    expect(kdfNeedsUpgrade(LEGACY_KDF)).toBe(true)
    expect(kdfNeedsUpgrade(CURRENT_KDF)).toBe(false)
  })

  it('derives different verifiers for different KDF parameters', async () => {
    const salt = new Uint8Array(SALT_BYTES).fill(3)
    const legacy = await passwordVerifier('vault-password', salt, LEGACY_KDF)
    const current = await passwordVerifier('vault-password', salt, CURRENT_KDF)
    expect(legacy).not.toBe(current)
  })

  it('derives a non-extractable 256-bit AES-GCM key', async () => {
    const salt = randomBytes(SALT_BYTES)
    const key = await deriveKey('correct horse battery', salt)
    expect(key.type).toBe('secret')
    expect(key.extractable).toBe(false)
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 })
    expect(key.usages).toEqual(expect.arrayContaining(['wrapKey', 'unwrapKey']))
  })

  it('derives the same verifier for the same passphrase and salt', async () => {
    const salt = new Uint8Array(SALT_BYTES)
    salt.fill(9)
    const first = await passwordVerifier('vault-password', salt)
    const second = await passwordVerifier('vault-password', salt)
    const other = await passwordVerifier('other-password', salt)
    expect(first).toBe(second)
    expect(first).toHaveLength(64)
    expect(first).not.toBe(other)
  })

  it('round-trips plaintext through AES-256-GCM', async () => {
    const key = await generateDek()
    const plain = new TextEncoder().encode('moliya ledger')
    const sealed = await encryptDatabase(plain, key)
    expect(sealed.iv).toHaveLength(IV_BYTES)
    const opened = await decryptDatabase(sealed.cipherText, key, sealed.iv)
    expect(opened).toEqual(plain)
  })

  it('rejects a tampered ciphertext', async () => {
    const key = await generateDek()
    const sealed = await encryptDatabase(new TextEncoder().encode('private'), key)
    const tampered = new Uint8Array(sealed.cipherText)
    tampered[0] ^= 0xff
    const buffer = tampered.buffer.slice(tampered.byteOffset, tampered.byteOffset + tampered.byteLength)
    await expect(decryptDatabase(buffer, key, sealed.iv)).rejects.toThrow()
  })

  it('unwraps a DEK with a key derived from the same passphrase', async () => {
    const salt = randomBytes(SALT_BYTES)
    const wrapping = await deriveKey('shared-secret', salt)
    const opening = await deriveKey('shared-secret', salt)
    const dek = await generateDek()
    const wrapped = await wrapDek(dek, wrapping)
    const restored = await unwrapDek(wrapped.cipherText, opening, wrapped.iv)
    const message = new TextEncoder().encode('group vault')
    const sealed = await encryptDatabase(message, dek)
    const opened = await decryptDatabase(sealed.cipherText, restored, sealed.iv)
    expect(opened).toEqual(message)
  })

  it('refuses to unwrap a DEK with a different passphrase', async () => {
    const salt = randomBytes(SALT_BYTES)
    const wrapping = await deriveKey('right-password', salt)
    const wrong = await deriveKey('wrong-password', salt)
    const wrapped = await wrapDek(await generateDek(), wrapping)
    await expect(unwrapDek(wrapped.cipherText, wrong, wrapped.iv)).rejects.toThrow()
  })
})
