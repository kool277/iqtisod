import * as nodeCrypto from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { argon2idBits } from '../../src/crypto/argon2'
import { MAX_SECRET_BYTES, readArgon2Request } from '../../src/crypto/argon2-request'
import { canonicalize, signedBytes } from '../../src/crypto/canonical'
import { generateDek } from '../../src/crypto/crypto.service'
import { unwrapDekWith, wrapDekTo } from '../../src/crypto/ecies'
import { bytesToHex } from '../../src/crypto/encoding'
import { generateIdentitySecret, importIdentity, sealIdentity, unsealIdentity } from '../../src/crypto/identity'
import { deriveInviteKeys, inviteAad, unwrapInviteDek, wrapDekForInvite } from '../../src/crypto/invite-crypto'
import { ARGON2_DEFAULT, isArgon2Params, type Argon2Params } from '../../src/crypto/kdf'
import { LABELS, fingerprintOf, formatFingerprint, signPayload, verifyPayload } from '../../src/crypto/sign'
import { assertSuite, resetSuiteDetectionForTests, suiteSupported } from '../../src/crypto/suite'

const FAST: Argon2Params = { name: 'Argon2id', m: 19_456, t: 2, p: 1, len: 32, v: 19 }

/** Node added `crypto.argon2Sync` in 24.7; CI runs the `.nvmrc` version, which may not have it. */
const argon2Sync = (nodeCrypto as Partial<typeof nodeCrypto>).argon2Sync
/** `argon2Sync` output for 'correct horse', a salt of sixteen 9s, and ARGON2_DEFAULT, recorded with Node 26. */
const DEFAULT_PARAMS_REFERENCE = '1ddfe7e9496633f1d57352e2fc396f7508d321fd1e6d9b38a70e40bac95ff1be'

async function rawDek(key: CryptoKey): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.exportKey('raw', key)))
}

describe('JCS canonicalization (RFC 8785)', () => {
  it('sorts keys by UTF-16 code units', () => {
    const input = { '\u20ac': 'Euro Sign', '\r': 'Carriage Return', '\ufb33': 'Hebrew Letter Dalet With Dagesh', '1': 'One', '\ud83d\ude00': 'Emoji: Grinning Face', '\u0080': 'Control', '\u00f6': 'Latin Small Letter O With Diaeresis' }
    expect(canonicalize(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis","\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}',
    )
  })

  it('escapes strings the way the RFC does and has no whitespace', () => {
    expect(canonicalize({ string: '\u20ac$\u000F\u000aA\'\u0042\u0022\u005c\\"/', literals: [null, true, false], n: [0, -7, 9007199254740991] })).toBe(
      '{"literals":[null,true,false],"n":[0,-7,9007199254740991],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    )
  })

  it('refuses floats, unsafe integers, lone surrogates and non-JSON values', () => {
    expect(() => canonicalize({ a: 1.5 })).toThrow()
    expect(() => canonicalize(2 ** 60)).toThrow()
    expect(() => canonicalize(Number.NaN)).toThrow()
    expect(() => canonicalize('\ud800')).toThrow()
    expect(() => canonicalize(new Uint8Array(2))).toThrow()
    expect(() => canonicalize(() => 1)).toThrow()
  })

  it('prefixes signed bytes with the label and a zero byte', () => {
    expect([...signedBytes('ab', { x: 1 })]).toEqual([0x61, 0x62, 0, ...new TextEncoder().encode('{"x":1}')])
  })
})

describe('Argon2id', () => {
  it.skipIf(!argon2Sync)('matches the RFC 9106 Argon2id test vector (through Node, the reference the app is checked against)', () => {
    const tag = argon2Sync!('argon2id', {
      message: Buffer.alloc(32, 1),
      nonce: Buffer.alloc(16, 2),
      secret: Buffer.alloc(8, 3),
      associatedData: Buffer.alloc(12, 4),
      parallelism: 4,
      tagLength: 32,
      memory: 32,
      passes: 3,
    })
    expect(tag.toString('hex')).toBe('0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659')
  })

  it('gives the same bits as Node at the default parameters', async () => {
    const salt = new Uint8Array(16).fill(9)
    const ours = await argon2idBits('correct horse', salt, ARGON2_DEFAULT)
    expect(bytesToHex(ours)).toBe(DEFAULT_PARAMS_REFERENCE)
    if (argon2Sync) {
      const node = argon2Sync('argon2id', { message: Buffer.from('correct horse'), nonce: salt, parallelism: 1, tagLength: 32, memory: 65_536, passes: 3 })
      expect(node.toString('hex')).toBe(DEFAULT_PARAMS_REFERENCE)
    }
  })

  it('refuses parameters outside the bounds before allocating', async () => {
    expect(isArgon2Params(ARGON2_DEFAULT)).toBe(true)
    for (const bad of [
      { ...ARGON2_DEFAULT, m: 4 * 1024 * 1024 },
      { ...ARGON2_DEFAULT, m: 1024 },
      { ...ARGON2_DEFAULT, t: 1 },
      { ...ARGON2_DEFAULT, t: 11 },
      { ...ARGON2_DEFAULT, p: 5 },
      { ...ARGON2_DEFAULT, len: 64 },
      { ...ARGON2_DEFAULT, v: 16 },
      { ...ARGON2_DEFAULT, name: 'Argon2i' },
    ]) {
      expect(isArgon2Params(bad)).toBe(false)
      await expect(argon2idBits('x', new Uint8Array(16), bad as Argon2Params)).rejects.toThrow('Unsupported key derivation parameters')
    }
  })
})

describe('Argon2id worker messages', () => {
  const own = 'https://jaybi.uz'
  const valid = () => ({ id: 1, secret: new Uint8Array(12).fill(1), salt: new Uint8Array(16).fill(2), m: ARGON2_DEFAULT.m, t: ARGON2_DEFAULT.t, p: ARGON2_DEFAULT.p })

  it('accepts a well-formed request from the page that started the worker', () => {
    expect(readArgon2Request({ origin: '', data: valid() }, own)).toMatchObject({ id: 1, m: ARGON2_DEFAULT.m })
    expect(readArgon2Request({ origin: own, data: valid() }, own)).not.toBeNull()
  })

  it('drops messages from any other origin', () => {
    expect(readArgon2Request({ origin: 'https://evil.example', data: valid() }, own)).toBeNull()
    expect(readArgon2Request({ origin: 'null', data: valid() }, own)).toBeNull()
  })

  it('drops anything not shaped exactly like a request', () => {
    const bad: unknown[] = [
      null,
      'x',
      [valid()],
      { ...valid(), extra: 1 },
      { ...valid(), id: 0 },
      { ...valid(), id: 1.5 },
      { ...valid(), secret: 'password' },
      { ...valid(), secret: new Uint8Array(0) },
      { ...valid(), secret: new Uint8Array(MAX_SECRET_BYTES + 1) },
      { ...valid(), salt: new Uint8Array(8) },
      { ...valid(), salt: new Uint16Array(16) },
      { ...valid(), m: 4 * 1024 * 1024 },
      { ...valid(), t: 1 },
      { ...valid(), p: 5 },
      { ...valid(), m: '65536' },
    ]
    for (const data of bad) expect(readArgon2Request({ origin: '', data }, own)).toBeNull()
  })
})

describe('identity blobs', () => {
  it('seal and unseal with the password, bound to vault and member', async () => {
    const secret = await generateIdentitySecret()
    const keys = await importIdentity(secret)
    const blob = await sealIdentity(secret, { vaultId: 'v1', memberId: 'm1', email: 'a@example.com', password: 'pw one' }, FAST)
    expect(blob).toMatchObject({ v: 2, suite: 'J2-X25519-ED25519', memberId: 'm1', email: 'a@example.com', encPub: keys.encPub, sigPub: keys.sigPub, kdf: FAST })
    const opened = await unsealIdentity(blob, 'v1', 'pw one')
    expect(opened.sigPub).toBe(keys.sigPub)
    expect(opened.sigPriv.extractable).toBe(false)
    expect(opened.encPriv.extractable).toBe(false)
    await expect(unsealIdentity(blob, 'v1', 'pw two')).rejects.toThrow()
    await expect(unsealIdentity({ ...blob, memberId: 'm2' }, 'v1', 'pw one')).rejects.toThrow()
    await expect(unsealIdentity(blob, 'v2', 'pw one')).rejects.toThrow()
    const other = await importIdentity(await generateIdentitySecret())
    await expect(unsealIdentity({ ...blob, sigPub: other.sigPub }, 'v1', 'pw one')).rejects.toThrow()
    await expect(unsealIdentity({ ...blob, encPub: other.encPub }, 'v1', 'pw one')).rejects.toThrow()
  })

  it('swapping two members blobs fails to open', async () => {
    const a = await sealIdentity(await generateIdentitySecret(), { vaultId: 'v', memberId: 'a', email: 'a@x.io', password: 'same' }, FAST)
    const b = await sealIdentity(await generateIdentitySecret(), { vaultId: 'v', memberId: 'b', email: 'b@x.io', password: 'same' }, FAST)
    await expect(unsealIdentity({ ...a, memberId: 'b' }, 'v', 'same')).rejects.toThrow()
    await expect(unsealIdentity({ ...b, sealed: a.sealed, iv: a.iv, salt: a.salt }, 'v', 'same')).rejects.toThrow()
  })
})

describe('ECIES DEK wrap', () => {
  it('round-trips and binds vault, epoch, member and recipient key', async () => {
    const keys = await importIdentity(await generateIdentitySecret())
    const other = await importIdentity(await generateIdentitySecret())
    const dek = await generateDek()
    const wrap = await wrapDekTo(dek, keys.encPub, { vaultId: 'v', epoch: 1, memberId: 'm' })
    expect(wrap).toMatchObject({ v: 2, suite: 'J2-X25519-ED25519', epoch: 1, memberId: 'm' })
    expect(await rawDek(await unwrapDekWith(wrap, keys, 'v'))).toBe(await rawDek(dek))
    await expect(unwrapDekWith(wrap, keys, 'other-vault')).rejects.toThrow()
    await expect(unwrapDekWith({ ...wrap, epoch: 2 }, keys, 'v')).rejects.toThrow()
    await expect(unwrapDekWith({ ...wrap, memberId: 'x' }, keys, 'v')).rejects.toThrow()
    await expect(unwrapDekWith(wrap, other, 'v')).rejects.toThrow()
    await expect(unwrapDekWith(wrap, { encPriv: keys.encPriv, encPub: other.encPub }, 'v')).rejects.toThrow()
    const again = await wrapDekTo(dek, keys.encPub, { vaultId: 'v', epoch: 1, memberId: 'm' })
    expect(again.epk).not.toBe(wrap.epk)
  })
})

describe('invite keys', () => {
  it('derive the same invite key from the same code and wrap the DEK under the invite KEK', async () => {
    const salt = new Uint8Array(16).fill(5)
    const first = await deriveInviteKeys('ABCD-EFGH', salt, FAST)
    const second = await deriveInviteKeys('ABCD-EFGH', salt, FAST)
    const wrong = await deriveInviteKeys('ABCD-EFGX', salt, FAST)
    expect(first.sigPub).toBe(second.sigPub)
    expect(wrong.sigPub).not.toBe(first.sigPub)
    const dek = await generateDek()
    const aad = inviteAad('v', 'g', 'INVITE', 'a@x.io', '2026-10-07T00:00:00.000Z')
    const wrapped = await wrapDekForInvite(dek, first.kek, aad)
    expect(await rawDek(await unwrapInviteDek(wrapped.cipherText, second.kek, wrapped.iv, aad))).toBe(await rawDek(dek))
    await expect(unwrapInviteDek(wrapped.cipherText, wrong.kek, wrapped.iv, aad)).rejects.toThrow()
    await expect(unwrapInviteDek(wrapped.cipherText, first.kek, wrapped.iv, inviteAad('v', 'g', 'INVITE', 'b@x.io', '2026-10-07T00:00:00.000Z'))).rejects.toThrow()
    const signature = await signPayload(LABELS.binding, { a: 1 }, first.sigPriv)
    expect(await verifyPayload(LABELS.binding, { a: 1 }, signature, second.sigPub)).toBe(true)
  })
})

describe('signatures and fingerprints', () => {
  it('verify only the exact label, payload and key', async () => {
    const keys = await importIdentity(await generateIdentitySecret())
    const other = await importIdentity(await generateIdentitySecret())
    const signature = await signPayload(LABELS.roster, { version: 1 }, keys.sigPriv)
    expect(await verifyPayload(LABELS.roster, { version: 1 }, signature, keys.sigPub)).toBe(true)
    expect(await verifyPayload(LABELS.header, { version: 1 }, signature, keys.sigPub)).toBe(false)
    expect(await verifyPayload(LABELS.roster, { version: 2 }, signature, keys.sigPub)).toBe(false)
    expect(await verifyPayload(LABELS.roster, { version: 1 }, signature, other.sigPub)).toBe(false)
    expect(await verifyPayload(LABELS.roster, { version: 1 }, 'not base64!', keys.sigPub)).toBe(false)
    const fingerprint = await fingerprintOf(keys.sigPub)
    expect(fingerprint).toMatch(/^[0-9a-f]{32}$/)
    expect(formatFingerprint(fingerprint)).toMatch(/^([0-9A-F]{4} ){5}[0-9A-F]{4}$/)
  })
})

describe('suite detection', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    resetSuiteDetectionForTests()
  })

  it('accepts a browser with X25519 and Ed25519', async () => {
    resetSuiteDetectionForTests()
    expect(await suiteSupported()).toBe(true)
    await expect(assertSuite()).resolves.toBeUndefined()
  })

  it('refuses a browser without them, with a clear code and no fallback', async () => {
    resetSuiteDetectionForTests()
    const original = crypto.subtle.generateKey.bind(crypto.subtle)
    vi.spyOn(crypto.subtle, 'generateKey').mockImplementation(((algorithm: AlgorithmIdentifier, extractable: boolean, usages: KeyUsage[]) => {
      const name = typeof algorithm === 'string' ? algorithm : algorithm.name
      if (name === 'X25519') return Promise.reject(new DOMException('Unrecognized name', 'NotSupportedError'))
      return original(algorithm as never, extractable, usages)
    }) as typeof crypto.subtle.generateKey)
    expect(await suiteSupported()).toBe(false)
    await expect(assertSuite()).rejects.toMatchObject({ code: 'V2_UNSUPPORTED_BROWSER' })
  })
})
