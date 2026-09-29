// Adapted from Project Nayuki's QR Code generator library (MIT License).

export type QrEcc = 'L' | 'M' | 'Q' | 'H'
export type QrMatrix = { size: number; version: number; mask: number; modules: boolean[][] }

const ECC_INDEX: Record<QrEcc, number> = { L: 0, M: 1, Q: 2, H: 3 }
const FORMAT_BITS: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 }

const ECC_CODEWORDS_PER_BLOCK: readonly (readonly number[])[] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
]

const NUM_ERROR_CORRECTION_BLOCKS: readonly (readonly number[])[] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
]

function getBit(x: number, i: number): boolean {
  return ((x >>> i) & 1) !== 0
}

function numRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (ver >= 7) result -= 36
  }
  return result
}

function numDataCodewords(ver: number, ecc: number): number {
  return Math.floor(numRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[ecc][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecc][ver]
}

function gfMultiply(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z
}

function rsDivisor(degree: number): number[] {
  const result: number[] = new Array<number>(degree - 1).fill(0)
  result.push(1)
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root)
      if (j + 1 < result.length) result[j] ^= result[j + 1]
    }
    root = gfMultiply(root, 0x02)
  }
  return result
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = divisor.map(() => 0)
  for (const b of data) {
    const factor = b ^ (result.shift() as number)
    result.push(0)
    divisor.forEach((coef, i) => {
      result[i] ^= gfMultiply(coef, factor)
    })
  }
  return result
}

function addEccAndInterleave(data: readonly number[], ver: number, ecc: number): number[] {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecc][ver]
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecc][ver]
  const rawCodewords = Math.floor(numRawDataModules(ver) / 8)
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks)
  const shortBlockLen = Math.floor(rawCodewords / numBlocks)
  const divisor = rsDivisor(blockEccLen)
  const blocks: number[][] = []
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1))
    k += dat.length
    const block = dat.concat(rsRemainder(dat, divisor))
    if (i < numShortBlocks) block.splice(dat.length, 0, 0)
    blocks.push(block)
  }
  const result: number[] = []
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i])
    })
  }
  return result
}

function alignmentPositions(ver: number): number[] {
  if (ver === 1) return []
  const size = ver * 4 + 17
  const numAlign = Math.floor(ver / 7) + 2
  const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2
  const result = [6]
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos)
  return result
}

function encodeData(bytes: Uint8Array, ecc: number): { version: number; codewords: number[] } {
  let version = 0
  for (let ver = 1; ver <= 40; ver++) {
    const used = 4 + (ver < 10 ? 8 : 16) + bytes.length * 8
    if (bytes.length < 1 << (ver < 10 ? 8 : 16) && used <= numDataCodewords(ver, ecc) * 8) {
      version = ver
      break
    }
  }
  if (!version) throw new Error('QR data too long')
  const bits: number[] = []
  const append = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1)
  }
  append(0x4, 4)
  append(bytes.length, version < 10 ? 8 : 16)
  for (const b of bytes) append(b, 8)
  const capacity = numDataCodewords(version, ecc) * 8
  append(0, Math.min(4, capacity - bits.length))
  append(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) append(pad, 8)
  const codewords: number[] = new Array<number>(bits.length / 8).fill(0)
  bits.forEach((b, i) => {
    codewords[i >>> 3] |= b << (7 - (i & 7))
  })
  return { version, codewords }
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0
    case 1: return y % 2 === 0
    case 2: return x % 3 === 0
    case 3: return (x + y) % 3 === 0
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
  }
}

export function encodeQr(text: string, ecc: QrEcc = 'M'): QrMatrix {
  const eccIdx = ECC_INDEX[ecc]
  const { version, codewords } = encodeData(new TextEncoder().encode(text), eccIdx)
  const size = version * 4 + 17
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const isFunction: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))

  const setFunction = (x: number, y: number, dark: boolean) => {
    modules[y][x] = dark
    isFunction[y][x] = true
  }

  const drawFormatBits = (mask: number) => {
    const data = (FORMAT_BITS[ecc] << 3) | mask
    let rem = data
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const bits = ((data << 10) | rem) ^ 0x5412
    for (let i = 0; i <= 5; i++) setFunction(8, i, getBit(bits, i))
    setFunction(8, 7, getBit(bits, 6))
    setFunction(8, 8, getBit(bits, 7))
    setFunction(7, 8, getBit(bits, 8))
    for (let i = 9; i < 15; i++) setFunction(14 - i, 8, getBit(bits, i))
    for (let i = 0; i < 8; i++) setFunction(size - 1 - i, 8, getBit(bits, i))
    for (let i = 8; i < 15; i++) setFunction(8, size - 15 + i, getBit(bits, i))
    setFunction(8, size - 8, true)
  }

  const drawFinder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        const x = cx + dx
        const y = cy + dy
        if (x >= 0 && x < size && y >= 0 && y < size) setFunction(x, y, dist !== 2 && dist !== 4)
      }
    }
  }

  for (let i = 0; i < size; i++) {
    setFunction(6, i, i % 2 === 0)
    setFunction(i, 6, i % 2 === 0)
  }
  drawFinder(3, 3)
  drawFinder(size - 4, 3)
  drawFinder(3, size - 4)
  const align = alignmentPositions(version)
  const last = align.length - 1
  align.forEach((ay, i) => {
    align.forEach((ax, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) setFunction(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
      }
    })
  })
  drawFormatBits(0)
  if (version >= 7) {
    let rem = version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (version << 12) | rem
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      setFunction(a, b, getBit(bits, i))
      setFunction(b, a, getBit(bits, i))
    }
  }

  const data = addEccAndInterleave(codewords, version, eccIdx)
  let bitIndex = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert
        if (!isFunction[y][x] && bitIndex < data.length * 8) {
          modules[y][x] = getBit(data[bitIndex >>> 3], 7 - (bitIndex & 7))
          bitIndex++
        }
      }
    }
  }

  const applyMask = (mask: number) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!isFunction[y][x] && maskBit(mask, x, y)) modules[y][x] = !modules[y][x]
      }
    }
  }

  let mask = 0
  let minPenalty = Infinity
  for (let m = 0; m < 8; m++) {
    applyMask(m)
    drawFormatBits(m)
    const penalty = penaltyScore(modules, size)
    if (penalty < minPenalty) {
      mask = m
      minPenalty = penalty
    }
    applyMask(m)
  }
  applyMask(mask)
  drawFormatBits(mask)
  return { size, version, mask, modules }
}

function penaltyScore(modules: boolean[][], size: number): number {
  let result = 0
  const addHistory = (run: number, history: number[]) => {
    if (history[0] === 0) run += size
    history.pop()
    history.unshift(run)
  }
  const countPatterns = (h: number[]) => {
    const n = h[1]
    const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n
    return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0)
  }
  const scanLine = (get: (i: number) => boolean) => {
    let runColor = false
    let run = 0
    const history = [0, 0, 0, 0, 0, 0, 0]
    for (let i = 0; i < size; i++) {
      if (get(i) === runColor) {
        run++
        if (run === 5) result += 3
        else if (run > 5) result++
      } else {
        addHistory(run, history)
        if (!runColor) result += countPatterns(history) * 40
        runColor = get(i)
        run = 1
      }
    }
    if (runColor) {
      addHistory(run, history)
      run = 0
    }
    addHistory(run + size, history)
    result += countPatterns(history) * 40
  }
  for (let y = 0; y < size; y++) scanLine((x) => modules[y][x])
  for (let x = 0; x < size; x++) scanLine((y) => modules[y][x])
  let dark = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = modules[y][x]
      if (c) dark++
      if (x < size - 1 && y < size - 1 && c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) result += 3
    }
  }
  const total = size * size
  result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10
  return result
}

export function qrPath(matrix: QrMatrix, border = 4): { viewBox: string; d: string } {
  const n = matrix.size + border * 2
  let d = ''
  matrix.modules.forEach((row, y) => {
    for (let x = 0; x < matrix.size; x++) {
      if (!row[x]) continue
      let len = 1
      while (x + len < matrix.size && row[x + len]) len++
      d += `M${x + border} ${y + border}h${len}v1h-${len}z`
      x += len - 1
    }
  })
  return { viewBox: `0 0 ${n} ${n}`, d }
}
