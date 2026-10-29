import { execFile } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { parseSnapshot, sealSnapshot, type FxSnapshot } from '../../src/domain/fx'
import { sha256Hex } from '../../src/lib/sha256'
import { FxBuildError, buildSnapshot, collect, commandMessage, fetchError, marketDay, type Fetcher } from '../../tools/fetch-rates'
import { BOI_URL, CBR_URL, ECB_URL, RAW_FILES, type RawKey } from '../../tools/fx-sources'

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
    expect(result).toMatchObject({ changed: true, degraded: false, stale: false, warnings: [] })
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

  it('falls back to the Bank of Russia cross for UZS when the CBU cannot be reached', async () => {
    const result = await build({ 'cbu-latest': new Error('fetch failed (UND_ERR_CONNECT_TIMEOUT)') })
    expect(result.snapshot.quotes[0]).toEqual({
      base: 'USD',
      quote: 'UZS',
      rate: '11825.4058318',
      date: '2026-09-29',
      source: 'CBR',
      method: 'cross',
      legs: [
        { pair: 'USD/RUB', rate: '84.4075' },
        { pair: 'UZS/RUB', rate: '0.00713781' },
      ],
      previous: { rate: '11830.8638183', date: '2026-09-26' },
    })
    expect(result).toMatchObject({ changed: true, degraded: true, stale: false })
    expect(result.warnings).toEqual(['cbu-latest: fetch failed (UND_ERR_CONNECT_TIMEOUT)', 'USD/UZS: primary source unavailable; using CBR cross via RUB'])
    expect(result.snapshot.fetches.map((item) => item.url)).toEqual([ECB_URL, BOI_URL, CBR_URL, `${CBR_URL}?date_req=28/09/2026`])
  })

  it('asks the Bank of Russia only when the CBU table is unusable', async () => {
    expect((await build()).snapshot.fetches.map((item) => item.source)).not.toContain('CBR')
    const garbled = await build({ 'cbu-latest': '<html>blocked</html>' })
    expect(garbled.snapshot.quotes[0]).toMatchObject({ source: 'CBR', rate: '11825.4058318' })
    expect(garbled.warnings[0]).toMatch(/^cbu-latest: CBU: /)
  })

  it('never lets a fallback replace a published rate that is as new', async () => {
    const boiDown = await build({ boi: new Error('HTTP 503') }, parseSnapshot(GOLDEN))
    expect(boiDown).toMatchObject({ changed: false, degraded: true, stale: false })
    expect(boiDown.warnings).toEqual([
      'boi: HTTP 503',
      'USD/ILS: primary source unavailable; keeping the 2026-09-28 rate from BOI, as ECB cross via EUR is not newer (2026-09-28)',
    ])
    expect((await build({ 'cbu-latest': new Error('down') }, parseSnapshot(GOLDEN))).snapshot.quotes[0]).toMatchObject({ source: 'CBU', rate: '11806.97' })
    const older = withQuote('UZS', { rate: '11825.40', date: '2026-09-26', previous: null })
    expect((await build({ 'cbu-latest': new Error('down') }, older)).snapshot.quotes[0]).toMatchObject({ source: 'CBR', date: '2026-09-29' })
  })

  it('treats a garbled response like an outage', async () => {
    const result = await build({ boi: '<html>maintenance</html>' })
    expect(result.snapshot.quotes[2].source).toBe('ECB')
    expect(result.warnings[0]).toMatch(/^boi: BOI: /)
  })

  it('keeps the previous rate when every source is down, and refuses to invent one', async () => {
    const down = { 'cbu-latest': new Error('down'), ecb: new Error('down'), boi: new Error('down'), cbr: new Error('down') }
    const result = await build(down, parseSnapshot(GOLDEN))
    expect(result).toMatchObject({ changed: false, degraded: true, stale: true })
    await expect(build(down)).rejects.toThrow(/no source is available/)
    const uzsDown = await build({ 'cbu-latest': new Error('down'), cbr: new Error('down') }, parseSnapshot(GOLDEN))
    expect(uzsDown).toMatchObject({ changed: false, stale: true })
    expect(uzsDown.warnings).toContain('USD/UZS: no source is available; keeping the 2026-09-29 rate from CBU')
  })

  it('refuses to publish when official sources disagree', async () => {
    const skewed = readFileSync(join(FIXTURES, 'boi.csv'), 'utf8').replace('2026-09-28,3.066', '2026-09-28,3.366')
    await expect(build({ boi: skewed })).rejects.toThrow(FxBuildError)
    await expect(build({ boi: skewed })).rejects.toThrow(/USD\/ILS BOI official deviates 9\.8\d+% from ECB cross/)
  })

  it('holds rates of one market day to the source tolerance, and rates of different days to 5%', async () => {
    const cbu = (ilsRate: string, date: string) =>
      readFileSync(join(FIXTURES, 'cbu-latest.json'), 'utf8').replace('"Rate":"3849.05"', `"Rate":"${ilsRate}"`).replaceAll('29.09.2026', date)
    // The CBU set its 29 September table from the markets of the 28th, the day of the BOI and ECB rates, and its 30 September table on the 29th.
    await expect(build({ 'cbu-latest': cbu('3760.00', '29.09.2026') })).rejects.toThrow(
      /USD\/ILS BOI official deviates 2\.3614% from CBU cross via UZS \(2026-09-29\) \(limit 2%\)/,
    )
    const cbuNextDay = await build({ 'cbu-latest': cbu('3760.00', '30.09.2026') })
    expect(cbuNextDay.snapshot.checks.find((check) => check.subject.startsWith('USD/ILS') && check.reference.startsWith('CBU'))).toMatchObject({
      reference: 'CBU cross via UZS (2026-09-30)',
      tolerancePercent: '5',
      passed: true,
    })

    const boi = readFileSync(join(FIXTURES, 'boi.csv'), 'utf8')
    await expect(build({ boi: boi.replace('2026-09-28,3.066', '2026-09-28,3.128') })).rejects.toThrow(
      /USD\/ILS BOI official deviates 2\.11\d+% from ECB cross via EUR \(2026-09-28\) \(limit 1\.5%\)/,
    )
    const boiNextDay = await build({ boi: `${boi.trimEnd()}\nRER_USD_ILS,D,USD,ILS,ILS,OF00,BOI_MRKT,V,F,Y,0,,2026-09-29,3.128,YP\n` })
    expect(boiNextDay.snapshot.quotes[2]).toMatchObject({ source: 'BOI', rate: '3.128', date: '2026-09-29' })
    expect(boiNextDay.snapshot.checks.find((check) => check.reference === 'ECB cross via EUR (2026-09-28)')).toMatchObject({ tolerancePercent: '5', passed: true })
  })

  it('dates a CBU table to the business day it was set', () => {
    expect(marketDay('CBU', '2026-09-29')).toBe('2026-09-28')
    expect(marketDay('CBU', '2026-09-26')).toBe('2026-09-25')
    expect(marketDay('CBU', '2026-09-28')).toBe('2026-09-25')
    expect(marketDay('ECB', '2026-09-28')).toBe('2026-09-28')
    expect(marketDay('BOI', '2026-09-28')).toBe('2026-09-28')
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

describe('fetchError', () => {
  it('names the network reason that Node keeps in the cause', () => {
    const timeout = new TypeError('fetch failed', { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) })
    expect(fetchError(timeout).message).toBe('fetch failed (UND_ERR_CONNECT_TIMEOUT)')
    expect(fetchError(new Error('HTTP 503')).message).toBe('HTTP 503')
    expect(fetchError(new TypeError('fetch failed', { cause: { code: 'X\n::error::forged' } })).message).toBe('fetch failed')
    expect(fetchError('down').message).toBe('down')
  })
})

describe('fetch-rates CLI', () => {
  const cli = (args: string[], env: Record<string, string> = {}) =>
    run(process.execPath, ['--experimental-strip-types', CLI, ...args, '--now', NOW.toISOString()], { env: { ...process.env, ...env } })

  it('writes latest, history, and the raw archive, then reports unchanged on a rerun', async () => {
    const out = join(work, 'data')
    const first = await cli(['--out', out, '--replay', FIXTURES])
    expect(first.stdout).toContain('Exchange rates updated')
    expect(readFileSync(join(out, 'rates/latest.json'), 'utf8')).toBe(GOLDEN)
    expect(readFileSync(join(out, 'rates/history/2026-09-29.json'), 'utf8')).toBe(GOLDEN)
    for (const key of ['cbu-latest', 'cbu-previous', 'ecb', 'boi'] as RawKey[]) {
      expect(readFileSync(join(out, 'archive/2026-09-29', RAW_FILES[key]))).toEqual(readFileSync(join(FIXTURES, RAW_FILES[key])))
    }
    expect(existsSync(join(out, 'archive/2026-09-29', RAW_FILES.cbr))).toBe(false)
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

  it('escapes workflow commands in warnings and errors', async () => {
    expect(commandMessage('a%0Ab\r\n::error::x')).toBe('a%250Ab%0D%0A::error::x')
    const raw = join(work, 'forged')
    cpSync(FIXTURES, raw, { recursive: true })
    const cbu = readFileSync(join(FIXTURES, 'cbu-latest.json'), 'utf8').replace(/"Date":"[^"]*"/g, '"Date":"29.09.2026\\n::error title=forged::x"')
    writeFileSync(join(raw, 'cbu-latest.json'), cbu)
    const output = await cli(['--out', join(work, 'forged-out'), '--replay', raw]).then(
      (result) => `${result.stdout}\n${result.stderr}`,
      (error: { stdout: string; stderr: string }) => `${error.stdout}\n${error.stderr}`,
    )
    const commands = output.split(/\r?\n/).filter((line) => line.startsWith('::'))
    expect(commands.length).toBeGreaterThan(0)
    for (const line of commands) expect(line, line).toMatch(/^::(warning|error)::/)
    expect(output).not.toMatch(/^::error title=forged::/m)
  })

  it('tells the workflow when a fallback was used, and when a pair kept its previous rate', async () => {
    const raw = join(work, 'cbu-blocked')
    cpSync(FIXTURES, raw, { recursive: true })
    writeFileSync(join(raw, 'cbu-latest.json'), '<html>blocked</html>')
    const outputs = join(work, 'github-output')
    const env = { GITHUB_OUTPUT: outputs, GITHUB_STEP_SUMMARY: join(work, 'github-summary') }
    const out = join(work, 'fallback')
    const fallback = await cli(['--out', out, '--replay', raw], env)
    expect(fallback.stdout).toContain('### Exchange rates updated (degraded)')
    expect(readFileSync(join(out, 'archive/2026-09-29', RAW_FILES.cbr))).toEqual(readFileSync(join(FIXTURES, RAW_FILES.cbr)))
    rmSync(join(raw, RAW_FILES.cbr))
    const stale = await cli(['--out', out, '--replay', raw], env)
    expect(stale.stdout).toContain('### Exchange rates unchanged (stale)')
    expect(readFileSync(outputs, 'utf8')).toMatch(
      /^changed=true\ndegraded=true\nstale=false\ndigest=[0-9a-f]{64}\nchanged=false\ndegraded=true\nstale=true\ndigest=[0-9a-f]{64}\n$/,
    )
  })

  it('prints usage without --out', async () => {
    await expect(run(process.execPath, ['--experimental-strip-types', CLI])).rejects.toMatchObject({ code: 2 })
  })
})
