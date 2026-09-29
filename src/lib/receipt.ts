import { ValidationError } from '../domain/errors'
import { LIMITS } from './limits'

export const RECEIPT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export const RECEIPT_ACCEPT = RECEIPT_TYPES.join(',')

const DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/

function startsWith(bytes: Uint8Array, prefix: number[], offset = 0): boolean {
  return prefix.every((value, index) => bytes[offset + index] === value)
}

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0))

function matchesMagic(type: string, head: Uint8Array): boolean {
  switch (type) {
    case 'png':
      return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case 'jpeg':
      return startsWith(head, [0xff, 0xd8, 0xff])
    case 'gif':
      return startsWith(head, ascii('GIF87a')) || startsWith(head, ascii('GIF89a'))
    case 'webp':
      return startsWith(head, ascii('RIFF')) && startsWith(head, ascii('WEBP'), 8)
    default:
      return false
  }
}

/** Decoded size of a receipt that passed {@link assertReceipt}. */
export function receiptBytes(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return (base64.length / 4) * 3 - padding
}

/** Accepts only PNG, JPEG, WebP or GIF data URLs whose bytes match the declared type. SVG and other markup are refused. */
export function assertReceipt(dataUrl: string): void {
  if (dataUrl.length > Math.ceil(LIMITS.receiptBytes / 3) * 4 + 32) throw new ValidationError('RECEIPT_SIZE')
  const match = DATA_URL.exec(dataUrl)
  if (!match || match[2].length % 4 !== 0) throw new ValidationError('RECEIPT_TYPE')
  if (receiptBytes(dataUrl) > LIMITS.receiptBytes) throw new ValidationError('RECEIPT_SIZE')
  const head = Uint8Array.from(atob(match[2].slice(0, 16)), (char) => char.charCodeAt(0))
  if (!matchesMagic(match[1], head)) throw new ValidationError('RECEIPT_TYPE')
}
