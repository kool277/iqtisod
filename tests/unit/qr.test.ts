import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { encodeQr, qrPath, type QrEcc, type QrMatrix } from '../../src/lib/qr'

const OTPAUTH = 'otpauth://totp/Moliya:admin%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Moliya&algorithm=SHA1&digits=6&period=30'
const ECC_FROM_BITS: QrEcc[] = ['M', 'L', 'H', 'Q']

function at(m: QrMatrix, x: number, y: number): boolean {
  return m.modules[y][x]
}

function bchRemainder(data: number, bits: number, poly: number): number {
  const degree = Math.floor(Math.log2(poly))
  let rem = data << degree
  for (let i = bits + degree - 1; i >= degree; i--) {
    if ((rem >>> i) & 1) rem ^= poly << (i - degree)
  }
  return rem
}

function readFormat(m: QrMatrix): [number, number] {
  const n = m.size
  let a = 0
  let b = 0
  const setA = (i: number, dark: boolean) => { if (dark) a |= 1 << i }
  const setB = (i: number, dark: boolean) => { if (dark) b |= 1 << i }
  for (let i = 0; i <= 5; i++) setA(i, at(m, 8, i))
  setA(6, at(m, 8, 7))
  setA(7, at(m, 8, 8))
  setA(8, at(m, 7, 8))
  for (let i = 9; i < 15; i++) setA(i, at(m, 14 - i, 8))
  for (let i = 0; i < 8; i++) setB(i, at(m, n - 1 - i, 8))
  for (let i = 8; i < 15; i++) setB(i, at(m, 8, n - 15 + i))
  return [a, b]
}

function decodeFormat(raw: number): { ecc: QrEcc; mask: number; valid: boolean } {
  const bits = raw ^ 0x5412
  const data = bits >>> 10
  return {
    ecc: ECC_FROM_BITS[data >>> 3],
    mask: data & 7,
    valid: bchRemainder(data, 5, 0x537) === (bits & 0x3ff),
  }
}

function expectFinder(m: QrMatrix, left: number, top: number): void {
  for (let dy = -1; dy <= 7; dy++) {
    for (let dx = -1; dx <= 7; dx++) {
      const x = left + dx
      const y = top + dy
      if (x < 0 || y < 0 || x >= m.size || y >= m.size) continue
      const dist = Math.max(Math.abs(dx - 3), Math.abs(dy - 3))
      expect(at(m, x, y)).toBe(dist !== 2 && dist !== 4)
    }
  }
}

function sha(m: QrMatrix): string {
  const s = m.modules.map((row) => row.map((c) => (c ? '1' : '0')).join('')).join('\n')
  return createHash('sha256').update(s).digest('hex')
}

describe('encodeQr', () => {
  const cases: [string, QrEcc][] = [
    ['HELLO WORLD', 'Q'],
    ['a', 'L'],
    [OTPAUTH, 'M'],
    ['Oʻzbekcha Ўзбекча', 'H'],
    ['x'.repeat(400), 'L'],
  ]

  it.each(cases)('draws function patterns for %j at %s', (text, ecc) => {
    const m = encodeQr(text, ecc)
    expect(m.size).toBe(17 + 4 * m.version)
    expect(m.modules).toHaveLength(m.size)
    for (const row of m.modules) expect(row).toHaveLength(m.size)
    expectFinder(m, 0, 0)
    expectFinder(m, m.size - 7, 0)
    expectFinder(m, 0, m.size - 7)
    for (let i = 8; i < m.size - 8; i++) {
      expect(at(m, i, 6)).toBe(i % 2 === 0)
      expect(at(m, 6, i)).toBe(i % 2 === 0)
    }
    expect(at(m, 8, m.size - 8)).toBe(true)
  })

  it.each(cases)('writes matching, valid format information for %j at %s', (text, ecc) => {
    const m = encodeQr(text, ecc)
    const [a, b] = readFormat(m)
    expect(a).toBe(b)
    const format = decodeFormat(a)
    expect(format.valid).toBe(true)
    expect(format.ecc).toBe(ecc)
    expect(format.mask).toBe(m.mask)
  })

  it('writes both version information blocks from version 7', () => {
    const m = encodeQr(OTPAUTH, 'M')
    expect(m.version).toBe(7)
    let a = 0
    let b = 0
    for (let i = 0; i < 18; i++) {
      const p = m.size - 11 + (i % 3)
      const q = Math.floor(i / 3)
      if (at(m, p, q)) a |= 1 << i
      if (at(m, q, p)) b |= 1 << i
    }
    expect(a).toBe(b)
    expect(a >>> 12).toBe(7)
    expect(bchRemainder(7, 6, 0x1f25)).toBe(a & 0xfff)
  })

  it('picks the smallest version that fits', () => {
    expect(encodeQr('a', 'L').version).toBe(1)
    expect(encodeQr('x'.repeat(17), 'L').version).toBe(1)
    expect(encodeQr('x'.repeat(18), 'L').version).toBe(2)
    expect(encodeQr('x'.repeat(14)).version).toBe(1)
    expect(encodeQr('x'.repeat(15)).version).toBe(2)
    const uri = 'otpauth://totp/Moliya:user?secret=' + 'A'.repeat(102) + '&issuer=Moliya'
    expect(uri).toHaveLength(150)
    expect(encodeQr(uri, 'M').version).toBe(8)
    expect(encodeQr('x'.repeat(2953), 'L').version).toBe(40)
  })

  it('rejects data that does not fit', () => {
    expect(() => encodeQr('x'.repeat(2954), 'L')).toThrow('QR data too long')
    expect(() => encodeQr('x'.repeat(1274), 'H')).toThrow('QR data too long')
  })

  it('matches pinned matrices', () => {
    expect(sha(encodeQr('HELLO WORLD', 'Q'))).toBe('37f15f65c379cd70a87010f7f75eaebaddaf3c0809c0f5ba46e8ef5fa3d5c047')
    expect(sha(encodeQr(OTPAUTH, 'M'))).toBe('62f056db94bf0f743bb3a14cacdf83661d35f1346ef5ee0d82bd26ff49432bf9')
    expect(sha(encodeQr('Oʻzbekcha Ўзбекча', 'H'))).toBe('310fedff8af9b4d700f60ad1cb0077b535b060d48109bf5c0a9e673f0f503b31')
  })
})

describe('qrPath', () => {
  it('covers exactly the dark modules inside the quiet zone', () => {
    const m = encodeQr(OTPAUTH)
    const { viewBox, d } = qrPath(m)
    const n = m.size + 8
    expect(viewBox).toBe(`0 0 ${n} ${n}`)
    expect(d).toMatch(/^(M\d+ \d+h\d+v1h-\d+z)+$/)
    const dark = m.modules.flat().filter(Boolean).length
    let covered = 0
    for (const [, x, y, len] of d.matchAll(/M(\d+) (\d+)h(\d+)/g)) {
      for (let i = 0; i < Number(len); i++) expect(at(m, Number(x) - 4 + i, Number(y) - 4)).toBe(true)
      covered += Number(len)
    }
    expect(covered).toBe(dark)
  })

  it('honours a custom border', () => {
    const m = encodeQr('a')
    expect(qrPath(m, 0).viewBox).toBe('0 0 21 21')
    expect(qrPath(m, 2).d.startsWith('M2 2h7v1h-7z')).toBe(true)
  })
})
