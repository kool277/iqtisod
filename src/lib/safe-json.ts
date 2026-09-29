import { LIMITS } from './limits'

export class UnsafeJsonError extends Error {
  constructor(readonly reason: 'SIZE' | 'DEPTH' | 'KEY' | 'SYNTAX') {
    super(`Unsafe JSON: ${reason}`)
    this.name = 'UnsafeJsonError'
  }
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export function jsonDepth(text: string): number {
  let depth = 0
  let max = 0
  let inString = false
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (inString) {
      if (code === 0x5c) index += 1
      else if (code === 0x22) inString = false
    } else if (code === 0x22) {
      inString = true
    } else if (code === 0x7b || code === 0x5b) {
      depth += 1
      if (depth > max) max = depth
    } else if (code === 0x7d || code === 0x5d) {
      depth -= 1
    }
  }
  return max
}

export function parseJsonSafely(text: string, options: { maxChars?: number; maxDepth?: number } = {}): unknown {
  const maxChars = options.maxChars ?? LIMITS.importFileBytes
  const maxDepth = options.maxDepth ?? LIMITS.jsonDepth
  if (text.length > maxChars) throw new UnsafeJsonError('SIZE')
  if (jsonDepth(text) > maxDepth) throw new UnsafeJsonError('DEPTH')
  try {
    return JSON.parse(text, (key, value: unknown) => {
      if (FORBIDDEN_KEYS.has(key)) throw new UnsafeJsonError('KEY')
      return value
    })
  } catch (error) {
    if (error instanceof UnsafeJsonError) throw error
    throw new UnsafeJsonError('SYNTAX')
  }
}
