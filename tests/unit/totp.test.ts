import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  TOTP_DIGITS,
  TOTP_ISSUER,
  TOTP_PERIOD_SECONDS,
  TOTP_SECRET_BYTES,
  TOTP_WINDOW,
  base32Decode,
  base32Encode,
  hotp,
  importTotpKey,
  isTotpCode,
  otpauthUri,
  timeStep,
  totpAt,
  verifyTotp,
} from '../../src/lib/totp'

const RFC_SECRET = new TextEncoder().encode('12345678901234567890')
const PERIOD_MS = TOTP_PERIOD_SECONDS * 1000

const RFC6238_SHA1: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
]

const RFC4226: string[] = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489']

function referenceHotp(secret: Uint8Array, counter: number, digits: number): string {
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const mac = createHmac('sha1', secret).update(message).digest()
  const offset = mac[mac.length - 1] & 0x0f
  const binary = mac.readUInt32BE(offset) & 0x7fffffff
  return String(binary % 10 ** digits).padStart(digits, '0')
}

describe('constants', () => {
  it('uses 160-bit secrets and 6-digit, 30-second codes with a one-step window', () => {
    expect(TOTP_SECRET_BYTES).toBe(20)
    expect(TOTP_DIGITS).toBe(6)
    expect(TOTP_PERIOD_SECONDS).toBe(30)
    expect(TOTP_WINDOW).toBe(1)
    expect(TOTP_ISSUER).toBe('Jaybi')
  })
})

describe('hotp / totpAt', () => {
  it('matches the RFC 4226 HOTP test values', async () => {
    const key = await importTotpKey(RFC_SECRET)
    for (let counter = 0; counter < RFC4226.length; counter += 1) {
      expect(await hotp(key, counter), String(counter)).toBe(RFC4226[counter])
    }
  })

  it('matches the RFC 6238 SHA-1 test vectors at 8 digits', async () => {
    const key = await importTotpKey(RFC_SECRET)
    for (const [seconds, code] of RFC6238_SHA1) {
      expect(await totpAt(key, seconds * 1000, 8), String(seconds)).toBe(code)
      expect(await totpAt(key, seconds * 1000), String(seconds)).toBe(code.slice(-6))
    }
  })

  it('handles counters above 2^32 like the reference implementation', async () => {
    const key = await importTotpKey(RFC_SECRET)
    for (const counter of [2 ** 32 - 1, 2 ** 32, 2 ** 32 + 1, 2 ** 40 + 12345, Number.MAX_SAFE_INTEGER]) {
      expect(await hotp(key, counter), String(counter)).toBe(referenceHotp(RFC_SECRET, counter, 6))
      expect(await hotp(key, counter, 8), String(counter)).toBe(referenceHotp(RFC_SECRET, counter, 8))
    }
  })
})

describe('timeStep', () => {
  it('counts whole 30-second periods since the epoch', () => {
    expect(timeStep(0)).toBe(0)
    expect(timeStep(29_999)).toBe(0)
    expect(timeStep(30_000)).toBe(1)
    expect(timeStep(59_000)).toBe(1)
    expect(timeStep(1_111_111_109_000)).toBe(37_037_036)
    expect(timeStep(60_000, 60)).toBe(1)
  })
})

describe('base32', () => {
  it('matches the RFC 4648 vectors without padding', () => {
    const vectors: [string, string][] = [
      ['', ''],
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ]
    for (const [plain, encoded] of vectors) {
      expect(base32Encode(new TextEncoder().encode(plain))).toBe(encoded)
      expect(new TextDecoder().decode(base32Decode(encoded))).toBe(plain)
    }
    expect(base32Encode(RFC_SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
  })

  it('decodes padding, lower case, spaces and dashes', () => {
    expect(new TextDecoder().decode(base32Decode('mzxw6ytboi======'))).toBe('foobar')
    expect(new TextDecoder().decode(base32Decode('MZXW 6YTB-OI'))).toBe('foobar')
  })

  it('refuses characters outside the alphabet', () => {
    for (const bad of ['MZXW1', 'MZXW0', 'MZXW8', 'MZ!W6']) expect(() => base32Decode(bad), bad).toThrow('Invalid base32')
  })

  it('round-trips random secrets', () => {
    for (let round = 0; round < 50; round += 1) {
      const bytes = crypto.getRandomValues(new Uint8Array(1 + (round % 40)))
      const encoded = base32Encode(bytes)
      expect(encoded).toMatch(/^[A-Z2-7]+$/)
      expect(base32Decode(encoded)).toEqual(bytes)
    }
  })
})

describe('otpauthUri', () => {
  it('follows the Key URI format', () => {
    const secret = crypto.getRandomValues(new Uint8Array(TOTP_SECRET_BYTES))
    const uri = otpauthUri(secret, 'admin@example.com')
    expect(uri).toBe(
      `otpauth://totp/Jaybi%3Aadmin%40example.com?secret=${base32Encode(secret)}&issuer=Jaybi&algorithm=SHA1&digits=6&period=30`,
    )
    const url = new URL(uri)
    expect(url.protocol).toBe('otpauth:')
    expect(url.host).toBe('totp')
    expect(decodeURIComponent(url.pathname)).toBe('/Jaybi:admin@example.com')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      secret: base32Encode(secret),
      issuer: 'Jaybi',
      algorithm: 'SHA1',
      digits: '6',
      period: '30',
    })
    expect(base32Decode(url.searchParams.get('secret')!)).toEqual(secret)
  })

  it('encodes accounts that contain URI syntax', () => {
    const account = 'o’g‘il & qiz?#/ user+1@misol.uz'
    const uri = otpauthUri(new Uint8Array(20), account)
    const url = new URL(uri)
    expect(decodeURIComponent(url.pathname)).toBe(`/Jaybi:${account}`)
    expect(url.hash).toBe('')
    expect([...url.searchParams.keys()]).toEqual(['secret', 'issuer', 'algorithm', 'digits', 'period'])
    expect(uri.split('?')[0]).not.toMatch(/[ &?#+]/)
  })
})

describe('isTotpCode', () => {
  it('accepts exactly six digits, ignoring whitespace', () => {
    expect(isTotpCode('123456')).toBe(true)
    expect(isTotpCode('123 456')).toBe(true)
    expect(isTotpCode(' 123456 ')).toBe(true)
    for (const bad of ['12345', '1234567', '12345a', '', '１２３４５６', '12-456']) expect(isTotpCode(bad), bad).toBe(false)
  })
})

describe('verifyTotp', () => {
  const now = 1_700_000_000_000
  const step = timeStep(now)

  it('accepts the current code and one step either side, returning the matched step', async () => {
    const key = await importTotpKey(RFC_SECRET)
    for (const offset of [-1, 0, 1]) {
      const code = await hotp(key, step + offset)
      expect(await verifyTotp(key, code, now, 0), String(offset)).toBe(step + offset)
    }
  })

  it('refuses codes two or more steps away', async () => {
    const key = await importTotpKey(RFC_SECRET)
    for (const offset of [-3, -2, 2, 3]) {
      const code = await hotp(key, step + offset)
      const nearby = await Promise.all([-1, 0, 1].map((near) => hotp(key, step + near)))
      if (nearby.includes(code)) continue
      expect(await verifyTotp(key, code, now, 0), String(offset)).toBeNull()
    }
  })

  it('refuses a replayed code and any code at or before the last used step', async () => {
    const key = await importTotpKey(RFC_SECRET)
    const code = await hotp(key, step)
    const used = await verifyTotp(key, code, now, 0)
    expect(used).toBe(step)
    expect(await verifyTotp(key, code, now, used!)).toBeNull()
    expect(await verifyTotp(key, code, now + PERIOD_MS, used!)).toBeNull()
    expect(await verifyTotp(key, await hotp(key, step - 1), now, step - 1)).toBeNull()
    expect(await verifyTotp(key, await hotp(key, step + 1), now, used!)).toBe(step + 1)
  })

  it('accepts spaced input and refuses malformed or wrong codes', async () => {
    const key = await importTotpKey(RFC_SECRET)
    const code = await hotp(key, step)
    expect(await verifyTotp(key, `${code.slice(0, 3)} ${code.slice(3)}`, now, 0)).toBe(step)
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0')
    const window = await Promise.all([-1, 0, 1].map((offset) => hotp(key, step + offset)))
    if (!window.includes(wrong)) expect(await verifyTotp(key, wrong, now, 0)).toBeNull()
    expect(await verifyTotp(key, code.slice(0, 5), now, 0)).toBeNull()
    expect(await verifyTotp(key, `${code}0`, now, 0)).toBeNull()
    expect(await verifyTotp(key, 'abcdef', now, 0)).toBeNull()
    expect(await verifyTotp(key, await totpAt(key, now, 8), now, 0)).toBeNull()
  })

  it('does not accept codes made with a different secret', async () => {
    const key = await importTotpKey(RFC_SECRET)
    const other = await importTotpKey(new TextEncoder().encode('09876543210987654321'))
    const code = await hotp(other, step)
    const window = await Promise.all([-1, 0, 1].map((offset) => hotp(key, step + offset)))
    if (!window.includes(code)) expect(await verifyTotp(key, code, now, 0)).toBeNull()
  })
})
