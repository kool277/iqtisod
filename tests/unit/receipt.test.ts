import { describe, expect, it } from 'vitest'
import { AppError } from '../../src/domain/errors'
import { LIMITS } from '../../src/lib/limits'
import { RECEIPT_ACCEPT, RECEIPT_TYPES, assertReceipt, receiptBytes } from '../../src/lib/receipt'

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0))

const MAGIC = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, ...ascii('IHDR')],
  jpeg: [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...ascii('JFIF')],
  gif89: ascii('GIF89a'),
  gif87: ascii('GIF87a'),
  webp: [...ascii('RIFF'), 0x24, 0, 0, 0, ...ascii('WEBPVP8 ')],
}

function dataUrl(type: string, bytes: number[] | Uint8Array, size = 0): string {
  const body = new Uint8Array(Math.max(size, bytes.length))
  body.set(bytes)
  return `data:${type};base64,${Buffer.from(body).toString('base64')}`
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (error) {
    return error instanceof AppError ? error.code : 'unexpected'
  }
}

describe('assertReceipt', () => {
  it('advertises only raster image types', () => {
    expect(RECEIPT_TYPES).toEqual(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
    expect(RECEIPT_ACCEPT).toBe('image/png,image/jpeg,image/webp,image/gif')
  })

  it('accepts PNG, JPEG, WebP and GIF with matching magic bytes', () => {
    const cases: [string, number[]][] = [
      ['image/png', MAGIC.png],
      ['image/jpeg', MAGIC.jpeg],
      ['image/webp', MAGIC.webp],
      ['image/gif', MAGIC.gif89],
      ['image/gif', MAGIC.gif87],
    ]
    for (const [type, magic] of cases) {
      for (const size of [0, 1, 2, 3, 64, 1000]) {
        expect(codeOf(() => assertReceipt(dataUrl(type, magic, size))), `${type}/${size}`).toBeNull()
      }
    }
  })

  it('refuses SVG, HTML and other non-raster types', () => {
    const svg = ascii('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')
    for (const url of [
      dataUrl('image/svg+xml', svg),
      dataUrl('text/html', ascii('<script>alert(1)</script>')),
      dataUrl('image/bmp', ascii('BM')),
      dataUrl('image/x-icon', [0, 0, 1, 0]),
      dataUrl('application/octet-stream', MAGIC.png),
      dataUrl('IMAGE/PNG', MAGIC.png),
      `data:image/png;charset=utf-8;base64,${Buffer.from(MAGIC.png).toString('base64')}`,
      `data:image/png,${Buffer.from(MAGIC.png).toString('base64')}`,
      `data:image/svg+xml;utf8,<svg/>`,
      `https://example.com/receipt.png`,
      `javascript:alert(1)`,
      '',
    ]) {
      expect(codeOf(() => assertReceipt(url)), url.slice(0, 40)).toBe('RECEIPT_TYPE')
    }
  })

  it('refuses bytes that do not match the declared type', () => {
    expect(codeOf(() => assertReceipt(dataUrl('image/png', MAGIC.jpeg)))).toBe('RECEIPT_TYPE')
    expect(codeOf(() => assertReceipt(dataUrl('image/jpeg', MAGIC.png)))).toBe('RECEIPT_TYPE')
    expect(codeOf(() => assertReceipt(dataUrl('image/gif', ascii('GIF88a'))))).toBe('RECEIPT_TYPE')
    expect(codeOf(() => assertReceipt(dataUrl('image/webp', [...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')])))).toBe('RECEIPT_TYPE')
    expect(codeOf(() => assertReceipt(dataUrl('image/png', ascii('<svg onload="alert(1)">'))))).toBe('RECEIPT_TYPE')
    expect(codeOf(() => assertReceipt(dataUrl('image/png', MAGIC.png.slice(0, 7))))).toBe('RECEIPT_TYPE')
  })

  it('refuses malformed base64', () => {
    const good = Buffer.from(MAGIC.png).toString('base64')
    for (const body of [`${good}!`, `${good} `, `${good}\n`, `${good.slice(0, -1)}`, '@@@@', `AA=A${good}`, `${good}===`, '']) {
      expect(codeOf(() => assertReceipt(`data:image/png;base64,${body}`)), JSON.stringify(body)).toBe('RECEIPT_TYPE')
    }
  })

  it('refuses receipts over 1.5 MB', () => {
    expect(codeOf(() => assertReceipt(dataUrl('image/jpeg', MAGIC.jpeg, LIMITS.receiptBytes)))).toBeNull()
    expect(codeOf(() => assertReceipt(dataUrl('image/jpeg', MAGIC.jpeg, LIMITS.receiptBytes + 1)))).toBe('RECEIPT_SIZE')
    expect(codeOf(() => assertReceipt(dataUrl('image/jpeg', MAGIC.jpeg, LIMITS.receiptBytes + 10)))).toBe('RECEIPT_SIZE')
    expect(codeOf(() => assertReceipt(dataUrl('image/jpeg', MAGIC.jpeg, 4 * LIMITS.receiptBytes)))).toBe('RECEIPT_SIZE')
    expect(codeOf(() => assertReceipt(`data:image/svg+xml;base64,${'A'.repeat(3 * LIMITS.receiptBytes)}`))).toBe('RECEIPT_SIZE')
  })
})

describe('receiptBytes', () => {
  it('computes the decoded size from the base64 length and padding', () => {
    expect(receiptBytes('data:image/png;base64,AAAA')).toBe(3)
    expect(receiptBytes('data:image/png;base64,AAA=')).toBe(2)
    expect(receiptBytes('data:image/png;base64,AA==')).toBe(1)
    expect(receiptBytes('data:image/png;base64,')).toBe(0)
    for (const size of [1, 2, 3, 4, 5, 100, 1001, LIMITS.receiptBytes]) {
      expect(receiptBytes(dataUrl('image/png', MAGIC.png, size)), String(size)).toBe(Math.max(size, MAGIC.png.length))
    }
  })
})
