import { ValidationError } from '../domain/errors'

/** Written into the header, every wrap, the roster and every signed payload, so a later `J2-P256` vault is unambiguous. */
export const SUITE = 'J2-X25519-ED25519' as const
export type Suite = typeof SUITE

let detection: Promise<boolean> | null = null

async function probe(): Promise<boolean> {
  try {
    const subtle = globalThis.crypto?.subtle
    if (!subtle) return false
    const sig = (await subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair
    const message = new Uint8Array([1, 2, 3])
    const signature = await subtle.sign({ name: 'Ed25519' }, sig.privateKey, message)
    if (!(await subtle.verify({ name: 'Ed25519' }, sig.publicKey, signature, message))) return false
    const a = (await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])) as CryptoKeyPair
    const b = (await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])) as CryptoKeyPair
    const ab = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: b.publicKey }, a.privateKey, 256))
    const ba = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: a.publicKey }, b.privateKey, 256))
    return ab.length === 32 && ab.every((byte, index) => byte === ba[index])
  } catch {
    return false
  }
}

/** X25519 and Ed25519 in Web Crypto, with a sign/verify and agreement round trip. There is no fallback in 2.0. */
export function suiteSupported(): Promise<boolean> {
  detection ??= probe()
  return detection
}

export async function assertSuite(): Promise<void> {
  if (!(await suiteSupported())) throw new ValidationError('V2_UNSUPPORTED_BROWSER')
}

export function resetSuiteDetectionForTests(): void {
  detection = null
}
