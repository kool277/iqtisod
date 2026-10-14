import { IV_BYTES, randomBytes } from './crypto.service'
import { base64ToBytes, bytesToBase64, copyToBuffer } from './encoding'
import { LABELS, exportPub, hkdfAesKey, importEncPub, sha256HexOf } from './sign'
import { SUITE, type Suite } from './suite'

export const DEK_WRAP_SALT_BYTES = 32

/** The epoch DEK sealed to one member's X25519 key with a fresh ephemeral key. */
export type DekWrap = {
  v: 2
  suite: Suite
  epoch: number
  memberId: string
  epk: string
  salt: string
  iv: string
  ct: string
}

export type DekWrapContext = { vaultId: string; epoch: number; memberId: string }

async function wrapAad(context: DekWrapContext, recipientPub: string): Promise<Uint8Array> {
  const pubHash = await sha256HexOf(base64ToBytes(recipientPub))
  return new TextEncoder().encode(`${LABELS.dekWrapAad}|${context.vaultId}|${context.epoch}|${context.memberId}|${pubHash}|${SUITE}`)
}

async function wrapKek(shared: Uint8Array, salt: Uint8Array, epk: string, recipientPub: string): Promise<CryptoKey> {
  return hkdfAesKey(shared, salt, `${LABELS.dekWrap}|${SUITE}|${epk}|${recipientPub}`, ['wrapKey', 'unwrapKey'])
}

export async function wrapDekTo(dek: CryptoKey, recipientPub: string, context: DekWrapContext): Promise<DekWrap> {
  const recipient = await importEncPub(recipientPub)
  const ephemeral = (await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair
  const epk = await exportPub(ephemeral.publicKey)
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: recipient }, ephemeral.privateKey, 256))
  const salt = randomBytes(DEK_WRAP_SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  try {
    const kek = await wrapKek(shared, salt, epk, recipientPub)
    const ct = await crypto.subtle.wrapKey('raw', dek, kek, { name: 'AES-GCM', iv: copyToBuffer(iv), additionalData: copyToBuffer(await wrapAad(context, recipientPub)) })
    return {
      v: 2,
      suite: SUITE,
      epoch: context.epoch,
      memberId: context.memberId,
      epk,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ct: bytesToBase64(new Uint8Array(ct)),
    }
  } finally {
    shared.fill(0)
  }
}

/** Throws unless the wrap was made for exactly this vault, epoch, member and key. */
export async function unwrapDekWith(wrap: DekWrap, keys: { encPriv: CryptoKey; encPub: string }, vaultId: string): Promise<CryptoKey> {
  const epk = await importEncPub(wrap.epk)
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: epk }, keys.encPriv, 256))
  try {
    const kek = await wrapKek(shared, base64ToBytes(wrap.salt), wrap.epk, keys.encPub)
    const aad = await wrapAad({ vaultId, epoch: wrap.epoch, memberId: wrap.memberId }, keys.encPub)
    return await crypto.subtle.unwrapKey(
      'raw',
      copyToBuffer(base64ToBytes(wrap.ct)),
      kek,
      { name: 'AES-GCM', iv: copyToBuffer(base64ToBytes(wrap.iv)), additionalData: copyToBuffer(aad) },
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    )
  } finally {
    shared.fill(0)
  }
}
