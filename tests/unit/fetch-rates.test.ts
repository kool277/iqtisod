import { execFile } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { parseSnapshot, sealSnapshot, type FxSnapshot } from '../../src/domain/fx'
import { sha256Hex } from '../../src/lib/sha256'
import { FxBuildError, buildSnapshot, collect, type Fetcher } from '../../tools/fetch-rates'
import { RAW_FILES, type RawKey } from '../../tools/fx-sources'

const run = promisify(execFile)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const FIXTURES = join(ROOT, 'tests/fixtures/fx')
const CLI = join(ROOT, 'tools/fetch-rates.ts')
const NOW = new Date('2026-09-29T09:17:48.000Z')
const GOLDEN = readFileSync(join(FIXTURES, 'snapshot.json'), 'utf8')
const work = mkdtempSync(join(tmpdir(), 'moliya-fx-'))

afterAll(() => rmSync(work, { recursive: true, force: true }))

function fetcher(overrides: Partial<Record<RawKey, string | Error>> = {}): Fetcher {
  return async (key) => {
    const override = overrides[key]
    if (override instanceof Error) throw override
    return new TextEncoder().encode(override ?? readFileSync(join(FIXTURES, RAW_FILES[key]), 'utf8'))
  }
}

async function build(overrides: Partial<Record<RawKey, string | Error>> = {}, previous: FxSnapshot | null = null, allowLargeMoves = false) {
  return buildSnapshot({ now: NOW, previous, allowLargeMoves, ...(await collect(fetcher(overrides), NOW)) })
}

function withQuote(quote: 'UZS' | 'KRW' | 'ILS', patch: Partial<FxSnapshot['quotes'][number]>): FxSnapshot {
  const { digest: _digest, ...body } = JSON.parse(GOLDEN) as FxSnapshot
  body.quotes = body.quotes.map((item) => (item.quote === quote ? { ...item, ...patch } : item))
  return parseSnapshot(JSON.stringify(sealSnapshot(body)))
}

describe('buildSnapshot', () => {
  it('reproduces the recorded snapshot byte for byte from the recorded responses', async () => {
    const result = await build()
    expect(result).toMatchObject({ changed: true, degraded: false, warnings: [] })
    expect(`${JSON.stringify(result.snapshot, null, 2)}\n`).toBe(GOLDEN)
    expect(result.snapshot.fetches.map((item) => item.sha256)).toEqual(
      (['cbu-latest', 'cbu-previous', 'ecb', 'boi'] as RawKey[]).map((key) => sha256Hex(readFileSync(join(FIXTURES, RAW_FILES[key]), 'utf8'))),
    )
  })

  it('reports no change when the official rates are the same as last time', async () => {
    const result = await build({}, parseSnapshot(GOLDEN))
    expect(result.changed).toBe(false)
    expect(result.snapshot.digest).toBe(parseSnapshot(GOLDEN).digest)
  })

  it('falls back to the ECB cross for ILS when the Bank of Israel is down', async () => {
    const result = await build({ boi: new Error('HTTP 503') })
    const ils = result.snapshot.quotes[2]
    expect(ils).toMatchObject({ source: 'ECB', method: 'cross', rate: '3.06328001406', date: '2026-09-28' })
    expect(result.degraded).toBe(true)
    expect(result.warnings).toEqual(['boi: HTTP 503', 'USD/ILS: primary source unavailable; using ECB cross via EUR'])
  })

  it('falls back to the CBU cross for KRW when the ECB is down', async () => {
    const result = await build({ ecb: new Error('timeout') })
    expect(result.snapshot.quotes[1]).toMatchObject({ source: 'CBU', method: 'cross', date: '2026-09-29' })
    expect(result.snapshot.quotes[1].legs).toEqual([
      { pair: 'USD/UZS', rate: '11806.97' },
      { pair: 'KRW/UZS', rate: '8.68' },
    ])
    expect(result.snapshot.checks.map((check) => check.reference)).toEqual(['CBU cross via UZS (2026-09-29)'])
  })

  it('treats a garbled response like an outage', async () => {
    const result = await build({ boi: '<html>maintenance</html>' })
    expect(result.snapshot.quotes[2].source).toBe('ECB')
    expect(result.warnings[0]).toMatch(/^boi: BOI: /)
  })

  it('keeps the previous rate when every source is down, and refuses to invent one', async () => {
    const down = { 'cbu-latest': new Error('down'), ecb: new Error('down'), boi: new Error('down') }
    const result = await build(down, parseSnapshot(GOLDEN))
    expect(result).toMatchObject({ changed: false, degraded: true })
    await expect(build(down)).rejects.toThrow(/no source is available/)
  })

  it('refuses to publish when official sources disagree', async () => {
    const skewed = readFileSync(join(FIXTURES, 'boi.csv'), 'utf8').replace('2026-09-28,3.066', '2026-09-28,3.366')
    await expect(build({ boi: skewed })).rejects.toThrow(FxBuildError)
    await expect(build({ boi: skewed })).rejects.toThrow(/USD\/ILS BOI official deviates 9\.8\d+% from ECB cross/)
  })

  it('holds back a large day-over-day move until a person confirms it', async () => {
    const previous = withQuote('UZS', { rate: '10000.00', date: '2026-09-25', previous: null })
    await expect(build({}, previous)).rejects.toThrow(/moved 18\.0697% .*--allow-large-moves/)
    expect((await build({}, previous, true)).snapshot.quotes[0].rate).toBe('11806.97')
  })

  it('rejects values outside the sanity range even if the source says so', async () => {
    const broken = readFileSync(join(FIXTURES, 'cbu-latest.json'), 'utf8').replace('"Rate":"11806.97"', '"Rate":"118.0697"')
    await expect(build({ 'cbu-latest': broken, ecb: new Error('down'), boi: new Error('down') })).rejects.toThrow(/sanity range/)
  })
})

describe('fetch-rates CLI', () => {
  const cli = (args: string[]) => run(process.execPath, ['--experimental-strip-types', CLI, ...args, '--now', NOW.toISOString()])

  it('writes latest, history, and the raw archive, then reports unchanged on a rerun', async () => {
    const out = join(work, 'data')
    const first = await cli(['--out', out, '--replay', FIXTURES])
    expect(first.stdout).toContain('Exchange rates updated')
    expect(readFileSync(join(out, 'rates/latest.json'), 'utf8')).toBe(GOLDEN)
    expect(readFileSync(join(out, 'rates/history/2026-09-29.json'), 'utf8')).toBe(GOLDEN)
    for (const file of Object.values(RAW_FILES)) {
      expect(readFileSync(join(out, 'archive/2026-09-29', file))).toEqual(readFileSync(join(FIXTURES, file)))
    }
    const second = await cli(['--out', out, '--replay', FIXTURES])
    expect(second.stdout).toContain('Exchange rates unchanged')
    expect(second.stdout).not.toContain('wrote ')
  })

  it('exits non-zero and writes nothing when validation fails', async () => {
    const raw = join(work, 'skewed')
    cpSync(FIXTURES, raw, { recursive: true })
    writeFileSync(join(raw, 'boi.csv'), readFileSync(join(FIXTURES, 'boi.csv'), 'utf8').replace('3.066', '3.366'))
    const out = join(work, 'rejected')
    await expect(cli(['--out', out, '--replay', raw])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('::error::') })
    expect(existsSync(join(out, 'rates/latest.json'))).toBe(false)
  })

  it('prints usage without --out', async () => {
    await expect(run(process.execPath, ['--experimental-strip-types', CLI])).rejects.toMatchObject({ code: 2 })
  })
})
