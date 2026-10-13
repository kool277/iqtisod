import { describe, expect, it } from 'vitest'
import { SUITE } from '../../src/crypto/suite'
import { readKeysHeader } from '../../src/db/keys-header'

const b64 = (bytes: number) => Buffer.alloc(bytes, 7).toString('base64')

const identity = {
  v: 2,
  suite: SUITE,
  memberId: 'm1',
  email: 'founder@example.com',
  kdf: { name: 'Argon2id', m: 65_536, t: 3, p: 1, len: 32, v: 19 },
  salt: b64(16),
  iv: b64(12),
  sealed: b64(116),
  encPub: b64(32),
  sigPub: b64(32),
}
const wrap = { v: 2, suite: SUITE, epoch: 1, memberId: 'm1', epk: b64(32), salt: b64(32), iv: b64(12), ct: b64(48) }
const header = {
  suite: SUITE,
  vaultId: 'vault-1',
  epoch: 1,
  founder: { memberId: 'm1', sigPub: b64(32), fingerprint: 'a'.repeat(32) },
  roster: { version: 1, hash: 'b'.repeat(64) },
  identities: { m1: identity },
  dekWraps: { m1: wrap },
  sig: { by: 'm1', alg: 'Ed25519', value: b64(64) },
}

/** As a backup or stored record would deliver it: parsed JSON, so every key is an own property. */
function parsed(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

/** Replaces `field` of the object at `path` with `name`, keeping the number of keys the same. */
function substituted(path: string[], field: string, name: string): Record<string, unknown> {
  const copy = parsed(header)
  let target = copy
  for (const step of path) target = target[step] as Record<string, unknown>
  delete target[field]
  target[name] = 1
  return copy
}

// Names every object inherits; `parseJsonSafely` refuses only __proto__, constructor and prototype.
const INHERITED = ['toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString']

describe('readKeysHeader', () => {
  it('reads a well-formed header', () => {
    expect(readKeysHeader(parsed(header))).toEqual(header)
  })

  it.each([
    [['founder'], 'fingerprint'],
    [['roster'], 'hash'],
    [['sig'], 'value'],
    [['identities', 'm1'], 'kdf'],
    [['identities', 'm1'], 'sealed'],
    [['dekWraps', 'm1'], 'ct'],
  ])('refuses %j with %s replaced by an inherited property name', (path, field) => {
    for (const name of INHERITED) expect(readKeysHeader(substituted(path, field, name)), name).toBeNull()
  })

  it('refuses an extra field and two identities with the same email', () => {
    expect(readKeysHeader(parsed({ ...header, founder: { ...header.founder, extra: 'x' } }))).toBeNull()
    const second = { ...identity, memberId: 'm2', email: 'FOUNDER@example.com' }
    expect(readKeysHeader(parsed({ ...header, identities: { m1: identity, m2: second }, dekWraps: { m1: wrap, m2: { ...wrap, memberId: 'm2' } } }))).toBeNull()
  })
})
