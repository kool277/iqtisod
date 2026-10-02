import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { Decimal } from '../src/lib/decimal.ts'
import { sha256 } from '../src/lib/sha256.ts'
import {
  FX_QUOTES,
  FX_SCHEMA,
  addDays,
  crossRate,
  crossVia,
  parseSnapshot,
  sealSnapshot,
  type FxCheck,
  type FxFetch,
  type FxObservation,
  type FxQuote,
  type FxQuoteCurrency,
  type FxSnapshot,
  type FxSourceId,
} from '../src/domain/fx.ts'
import {
  BOI_URL,
  CBU_LATEST_URL,
  ECB_URL,
  RAW_FILES,
  RAW_SOURCES,
  cbuDateUrl,
  parseBoi,
  parseCbu,
  parseEcb,
  type CbuTable,
  type RawKey,
  type RawResponse,
} from './fx-sources.ts'

export const MAX_DAILY_MOVE_PERCENT = '10'
export const MAX_CHECK_GAP_DAYS = 7

const TOLERANCE: Readonly<Record<FxSourceId, string>> = { CBU: '2', ECB: '1.5', BOI: '1.5' }

export class FxBuildError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FxBuildError'
  }
}

type Candidate = Omit<FxQuote, 'base' | 'quote'>

export type BuildInput = {
  now: Date
  responses: RawResponse[]
  failures: { key: RawKey; error: string }[]
  previous: FxSnapshot | null
  allowLargeMoves?: boolean
}

export type BuildResult = { snapshot: FxSnapshot; changed: boolean; degraded: boolean; warnings: string[] }

type Parsed = {
  cbu: CbuTable | null
  cbuPrevious: CbuTable | null
  ecb: Map<string, FxObservation[]> | null
  boi: FxObservation[] | null
}

const decoder = new TextDecoder('utf-8', { fatal: true })

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function deviationPercent(value: Decimal, reference: Decimal): Decimal {
  return value.subtract(reference).abs().multiply(Decimal.of(100n)).divide(reference, 4)
}

function dayGap(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000
}

function parseAll(responses: RawResponse[], warnings: string[]): Parsed {
  const parsed: Parsed = { cbu: null, cbuPrevious: null, ecb: null, boi: null }
  for (const response of responses) {
    try {
      const text = decoder.decode(response.body)
      if (response.key === 'cbu-latest') parsed.cbu = parseCbu(text)
      else if (response.key === 'cbu-previous') parsed.cbuPrevious = parseCbu(text)
      else if (response.key === 'ecb') parsed.ecb = parseEcb(text)
      else parsed.boi = parseBoi(text)
    } catch (error) {
      warnings.push(`${response.key}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (parsed.cbu && parsed.cbuPrevious && parsed.cbuPrevious.date >= parsed.cbu.date) parsed.cbuPrevious = null
  return parsed
}

function official(source: FxSourceId, current: FxObservation, previous: FxObservation | null): Candidate {
  return { rate: current.rate, date: current.date, source, method: 'official', legs: null, previous }
}

function cross(source: FxSourceId, date: string, top: [string, Decimal], bottom: [string, Decimal], previous: FxObservation | null): Candidate {
  return {
    rate: crossRate(top[1], bottom[1]).toString(),
    date,
    source,
    method: 'cross',
    legs: [
      { pair: top[0], rate: top[1].toString() },
      { pair: bottom[0], rate: bottom[1].toString() },
    ],
    previous,
  }
}

function cbuOfficial({ cbu, cbuPrevious }: Parsed): Candidate | null {
  const rate = cbu?.rates.get('USD')
  if (!cbu || !rate) return null
  const before = cbuPrevious?.rates.get('USD')
  return official('CBU', { rate: rate.toString(), date: cbu.date }, cbuPrevious && before ? { rate: before.toString(), date: cbuPrevious.date } : null)
}

function cbuCross({ cbu, cbuPrevious }: Parsed, quote: FxQuoteCurrency): Candidate | null {
  const usd = cbu?.rates.get('USD')
  const other = cbu?.rates.get(quote)
  if (!cbu || !usd || !other) return null
  const beforeUsd = cbuPrevious?.rates.get('USD')
  const beforeOther = cbuPrevious?.rates.get(quote)
  const previous =
    cbuPrevious && beforeUsd && beforeOther ? { rate: crossRate(beforeUsd, beforeOther).toString(), date: cbuPrevious.date } : null
  return cross('CBU', cbu.date, ['USD/UZS', usd], [`${quote}/UZS`, other], previous)
}

function ecbCross({ ecb }: Parsed, quote: FxQuoteCurrency): Candidate | null {
  const usd = new Map((ecb?.get('USD') ?? []).map((item) => [item.date, Decimal.parse(item.rate)]))
  const [latest, before] = (ecb?.get(quote) ?? []).filter((item) => usd.has(item.date)).reverse()
  if (!latest) return null
  const top = (item: FxObservation): [string, Decimal] => [`EUR/${quote}`, Decimal.parse(item.rate)]
  const bottom = (item: FxObservation): [string, Decimal] => ['EUR/USD', usd.get(item.date) as Decimal]
  const previous = before ? { rate: crossRate(top(before)[1], bottom(before)[1]).toString(), date: before.date } : null
  return cross('ECB', latest.date, top(latest), bottom(latest), previous)
}

function boiOfficial({ boi }: Parsed): Candidate | null {
  if (!boi || boi.length === 0) return null
  return official('BOI', boi[boi.length - 1], boi.length > 1 ? boi[boi.length - 2] : null)
}

function candidatesFor(parsed: Parsed, quote: FxQuoteCurrency): (Candidate | null)[] {
  if (quote === 'UZS') return [cbuOfficial(parsed)]
  if (quote === 'KRW') return [ecbCross(parsed, 'KRW'), cbuCross(parsed, 'KRW')]
  return [boiOfficial(parsed), ecbCross(parsed, 'ILS'), cbuCross(parsed, 'ILS')]
}

function describe(candidate: Candidate): string {
  return candidate.legs ? `${candidate.source} cross via ${crossVia(candidate.legs)}` : `${candidate.source} official`
}

function compare(subject: string, value: Decimal, reference: string, against: Decimal, tolerance: string): FxCheck {
  const deviation = deviationPercent(value, against)
  return {
    subject,
    reference,
    deviationPercent: deviation.toString(),
    tolerancePercent: tolerance,
    passed: deviation.compareTo(Decimal.parse(tolerance)) <= 0,
  }
}

function crossChecks(quote: FxQuoteCurrency, chosen: Candidate, alternatives: Candidate[]): FxCheck[] {
  return alternatives
    .filter((other) => other !== chosen && dayGap(other.date, chosen.date) <= MAX_CHECK_GAP_DAYS)
    .map((other) =>
      compare(`USD/${quote} ${describe(chosen)}`, Decimal.parse(chosen.rate), `${describe(other)} (${other.date})`, Decimal.parse(other.rate), TOLERANCE[other.source]),
    )
}

function cbuConsistency({ cbu, ecb }: Parsed): FxCheck[] {
  const usd = cbu?.rates.get('USD')
  const eur = cbu?.rates.get('EUR')
  const ecbUsd = ecb?.get('USD')?.at(-1)
  if (!cbu || !usd || !eur || !ecbUsd || dayGap(cbu.date, ecbUsd.date) > MAX_CHECK_GAP_DAYS) return []
  return [compare('EUR/USD implied by CBU', crossRate(eur, usd), `ECB EUR/USD (${ecbUsd.date})`, Decimal.parse(ecbUsd.rate), TOLERANCE.CBU)]
}

export function buildSnapshot({ now, responses, failures, previous, allowLargeMoves = false }: BuildInput): BuildResult {
  const warnings = failures.map((failure) => `${failure.key}: ${failure.error}`)
  const parsed = parseAll(responses, warnings)
  let degraded = warnings.length > 0
  const checks: FxCheck[] = [...cbuConsistency(parsed)]
  const quotes = FX_QUOTES.map((quote): FxQuote => {
    const candidates = candidatesFor(parsed, quote)
    const available = candidates.filter((candidate): candidate is Candidate => candidate !== null)
    const chosen = available[0]
    if (!chosen) {
      const carried = previous?.quotes.find((item) => item.quote === quote)
      if (!carried) throw new FxBuildError(`USD/${quote}: no source is available and there is no previous snapshot`)
      warnings.push(`USD/${quote}: no source is available; keeping the ${carried.date} rate from ${carried.source}`)
      degraded = true
      return carried
    }
    if (chosen !== candidates[0]) {
      warnings.push(`USD/${quote}: primary source unavailable; using ${describe(chosen)}`)
      degraded = true
    }
    checks.push(...crossChecks(quote, chosen, available))
    const before = previous?.quotes.find((item) => item.quote === quote)
    if (before && before.date !== chosen.date) {
      const move = deviationPercent(Decimal.parse(chosen.rate), Decimal.parse(before.rate))
      if (move.compareTo(Decimal.parse(MAX_DAILY_MOVE_PERCENT)) > 0 && !allowLargeMoves) {
        throw new FxBuildError(
          `USD/${quote}: ${chosen.rate} moved ${move.toString()}% from the published ${before.rate}; rerun with --allow-large-moves after review`,
        )
      }
    }
    return { base: 'USD', quote, ...chosen }
  })
  const failed = checks.filter((check) => !check.passed)
  if (failed.length > 0) {
    throw new FxBuildError(
      failed.map((check) => `${check.subject} deviates ${check.deviationPercent}% from ${check.reference} (limit ${check.tolerancePercent}%)`).join('; '),
    )
  }
  if (previous && JSON.stringify(previous.quotes) === JSON.stringify(quotes)) {
    return { snapshot: previous, changed: false, degraded, warnings }
  }
  const fetches: FxFetch[] = responses.map((response) => ({
    source: response.source,
    url: response.url,
    fetchedAt: response.fetchedAt,
    sha256: hex(sha256(response.body)),
  }))
  const snapshot = parseSnapshot(JSON.stringify(sealSnapshot({ schema: FX_SCHEMA, generatedAt: now.toISOString(), quotes, fetches, checks })))
  return { snapshot, changed: true, degraded, warnings }
}

export type Fetcher = (key: RawKey, url: string) => Promise<Uint8Array>

export async function httpFetcher(_key: RawKey, url: string): Promise<Uint8Array> {
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'jaybi-fx-rates (+https://github.com/kool277/iqtisod)', Accept: 'application/json, text/csv;q=0.9' },
        signal: AbortSignal.timeout(20_000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return new Uint8Array(await response.arrayBuffer())
    } catch (error) {
      lastError = error
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 2_000))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

export function replayFetcher(dir: string): Fetcher {
  return async (key) => new Uint8Array(readFileSync(join(dir, RAW_FILES[key])))
}

export async function collect(fetcher: Fetcher, now: Date): Promise<Pick<BuildInput, 'responses' | 'failures'>> {
  const responses: RawResponse[] = []
  const failures: BuildInput['failures'] = []
  const get = async (key: RawKey, url: string) => {
    try {
      const body = await fetcher(key, url)
      responses.push({ key, source: RAW_SOURCES[key], url, body, fetchedAt: now.toISOString() })
      return body
    } catch (error) {
      failures.push({ key, error: error instanceof Error ? error.message : String(error) })
      return null
    }
  }
  const [cbu] = await Promise.all([get('cbu-latest', CBU_LATEST_URL), get('ecb', ECB_URL), get('boi', BOI_URL)])
  if (cbu) {
    try {
      const { date } = parseCbu(decoder.decode(cbu))
      await get('cbu-previous', cbuDateUrl(addDays(date, -1)))
    } catch {
      /* the builder reports the parse failure */
    }
  }
  const order: RawKey[] = ['cbu-latest', 'cbu-previous', 'ecb', 'boi']
  responses.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
  return { responses, failures }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

export function writeOutputs(out: string, result: BuildResult, responses: RawResponse[]): string[] {
  if (!result.changed) return []
  const day = result.snapshot.generatedAt.slice(0, 10)
  const written = [join(out, 'rates', 'latest.json'), join(out, 'rates', 'history', `${day}.json`)]
  for (const path of written) writeJson(path, result.snapshot)
  for (const response of responses) {
    const path = join(out, 'archive', day, RAW_FILES[response.key])
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, response.body)
    written.push(path)
  }
  return written
}

function readPrevious(out: string): FxSnapshot | null {
  const path = join(out, 'rates', 'latest.json')
  return existsSync(path) ? parseSnapshot(readFileSync(path, 'utf8')) : null
}

/** GitHub workflow commands end at a line break; `%`, CR and LF must be escaped so a message cannot start another command. */
export function commandMessage(text: string): string {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

function report(result: BuildResult): void {
  for (const warning of result.warnings) console.log(`::warning::${commandMessage(warning)}`)
  const lines = result.snapshot.quotes.map(
    (quote) => `| USD/${quote.quote} | ${quote.rate} | ${quote.date} | ${quote.source} ${quote.method} | ${quote.previous?.rate ?? '—'} |`,
  )
  const summary = [
    `### Exchange rates ${result.changed ? 'updated' : 'unchanged'}${result.degraded ? ' (degraded)' : ''}`,
    '',
    '| Pair | Rate | Date | Source | Previous |',
    '| --- | --- | --- | --- | --- |',
    ...lines,
    '',
    ...result.snapshot.checks.map((check) => `- ${check.subject} vs ${check.reference}: ${check.deviationPercent}% (limit ${check.tolerancePercent}%)`),
    '',
  ].join('\n')
  console.log(summary)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `changed=${result.changed}\ndegraded=${result.degraded}\ndigest=${result.snapshot.digest}\n`,
    )
  }
}

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: 'string' },
      replay: { type: 'string' },
      now: { type: 'string' },
      'allow-large-moves': { type: 'boolean', default: false },
    },
  })
  if (!values.out) {
    console.error('Usage: node tools/fetch-rates.ts --out <data-dir> [--replay <raw-dir>] [--now <ISO>] [--allow-large-moves]')
    return 2
  }
  try {
    const now = values.now ? new Date(values.now) : new Date()
    if (Number.isNaN(now.getTime())) throw new FxBuildError(`Invalid --now value ${values.now}`)
    const previous = readPrevious(values.out)
    const collected = await collect(values.replay ? replayFetcher(values.replay) : httpFetcher, now)
    const result = buildSnapshot({ now, previous, allowLargeMoves: values['allow-large-moves'], ...collected })
    const written = writeOutputs(values.out, result, collected.responses)
    report(result)
    for (const path of written) console.log(`wrote ${path}`)
    return 0
  } catch (error) {
    console.error(`::error::${commandMessage(error instanceof Error ? error.message : String(error))}`)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
