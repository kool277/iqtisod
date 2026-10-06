function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

/**
 * RFC 8785 JSON Canonicalization Scheme for the subset Jaybi signs: objects, arrays, strings, safe integers,
 * booleans and null. Floats, lone surrogates and non-JSON values are refused rather than silently normalised.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('Only safe integers can be canonicalized')
    return Object.is(value, -0) ? '0' : String(value)
  }
  if (typeof value === 'string') {
    if (hasLoneSurrogate(value)) throw new TypeError('Lone surrogate in string')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
    entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries.map(([key, item]) => `${canonicalize(key)}:${canonicalize(item)}`).join(',')}}`
  }
  throw new TypeError('Value cannot be canonicalized')
}

/** Signed bytes are `utf8(label) ‖ 0x00 ‖ utf8(JCS(payload))`. */
export function signedBytes(label: string, payload: unknown): Uint8Array {
  const head = new TextEncoder().encode(label)
  const body = new TextEncoder().encode(canonicalize(payload))
  const out = new Uint8Array(head.length + 1 + body.length)
  out.set(head, 0)
  out.set(body, head.length + 1)
  return out
}
