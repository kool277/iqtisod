import { bytesToBase64 } from '../crypto/encoding'
import { LABELS, signPayload, verifyPayload } from '../crypto/sign'
import { manifestJson } from './chunks'
import type { KeysRecord } from './envelope'
import type { HeaderSig } from './keys-header'

/**
 * What a version 3 record's `sig` covers (docs/design/v2.0-key-redesign.md, 3.6): every field except `sig`, the
 * identities, the DEK wraps and the grants (each self-authenticating), the chunk storage keys and the ciphertext. The
 * body's manifest and seal are covered, which binds the body to the member who saved it. A backup's `format` and
 * `exportedAt` are not, so a file and the record it came from carry the same signature.
 */
export function headerPayload(record: KeysRecord): Record<string, unknown> {
  const { keys, body } = record
  return {
    version: record.version,
    appVersion: record.appVersion,
    schemaVersion: record.schemaVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    cipher: { name: record.cipher.name, length: record.cipher.length },
    ...(record.audit ? { audit: { seq: record.audit.seq, hash: record.audit.hash } } : {}),
    suite: keys.suite,
    vaultId: keys.vaultId,
    epoch: keys.epoch,
    founder: { memberId: keys.founder.memberId, sigPub: keys.founder.sigPub, fingerprint: keys.founder.fingerprint },
    roster: { version: keys.roster.version, hash: keys.roster.hash },
    body: {
      ...manifestJson(body),
      seal: { iv: bytesToBase64(new Uint8Array(body.seal.iv)), tag: bytesToBase64(new Uint8Array(body.seal.tag)) },
    },
  }
}

export async function signHeader(record: KeysRecord, memberId: string, sigPriv: CryptoKey): Promise<HeaderSig> {
  return { by: memberId, alg: 'Ed25519', value: await signPayload(LABELS.header, headerPayload(record), sigPriv) }
}

/** False for any mismatch or malformed input; never throws. */
export function verifyHeader(record: KeysRecord, sigPub: string): Promise<boolean> {
  return verifyPayload(LABELS.header, headerPayload(record), record.keys.sig.value, sigPub)
}
