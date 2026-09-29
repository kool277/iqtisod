import { ValidationError } from '../domain/errors'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CHECK_SYMBOLS = `${CROCKFORD}*~$=U`
export const ACCESS_CODE_BYTES = 17
export const ACCESS_CODE_BITS = 135
const DATA_CHARS = ACCESS_CODE_BITS / 5

export type AccessCode = { display: string; canonical: string }

function toBigInt(bytes: Uint8Array): bigint {
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  return value
}

function encode(value: bigint): AccessCode {
  let data = ''
  for (let index = DATA_CHARS - 1; index >= 0; index -= 1) data += CROCKFORD[Number((value >> BigInt(index * 5)) & 31n)]
  const canonical = `${data}${CHECK_SYMBOLS[Number(value % 37n)]}`
  return { canonical, display: canonical.match(/.{4}/g)!.join('-') }
}

export function generateAccessCode(): AccessCode {
  const bytes = new Uint8Array(ACCESS_CODE_BYTES)
  crypto.getRandomValues(bytes)
  bytes[0] &= 0x7f
  try {
    return encode(toBigInt(bytes))
  } finally {
    bytes.fill(0)
  }
}

export function normalizeAccessCode(text: string): string {
  if (text.length > 128) throw new ValidationError('INVITE_CODE')
  const compact = text
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  if (compact.length !== DATA_CHARS + 1) throw new ValidationError('INVITE_CODE')
  let value = 0n
  for (const char of compact.slice(0, DATA_CHARS)) {
    const digit = CROCKFORD.indexOf(char)
    if (digit < 0) throw new ValidationError('INVITE_CODE')
    value = (value << 5n) | BigInt(digit)
  }
  if (CHECK_SYMBOLS[Number(value % 37n)] !== compact[DATA_CHARS]) throw new ValidationError('INVITE_CODE')
  return compact
}
