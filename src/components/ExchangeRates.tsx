import { ArrowLeftRight, ExternalLink, Minus, RefreshCw, TrendingDown, TrendingUp } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useI18n } from '../context/I18nContext'
import { AppError } from '../domain/errors'
import {
  FX_BASE,
  FX_DIRECTIONS,
  FX_SOURCE_PAGES,
  changePercent,
  convert,
  crossVia,
  displayRate,
  isStale,
  scaledNominal,
  type FxQuote,
  type FxSnapshot,
} from '../domain/fx'
import { toIsoDate } from '../lib/dates'
import { formatDecimal } from '../lib/decimal'
import { errorText } from '../lib/errors'
import { formatIsoDate, formatWhen, intlLocale } from '../lib/money'
import { cacheSnapshot, fetchLatestSnapshot, parseAmountInput, preferNewer, readCachedSnapshot, type LoadedSnapshot } from '../services/fx.service'
import { Button, controlClass } from './ui'

type Failure = 'offline' | 'unavailable' | null

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match)
}

function useExchangeRates() {
  const [loaded, setLoaded] = useState<LoadedSnapshot | null>(() => readCachedSnapshot())
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<Failure>(null)
  const current = useRef(loaded)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const next = preferNewer(current.current, await fetchLatestSnapshot())
      if (next.snapshot.digest !== current.current?.snapshot.digest) {
        current.current = next
        cacheSnapshot(next)
        setLoaded(next)
      }
      setFailure(null)
    } catch {
      setFailure(navigator.onLine === false ? 'offline' : 'unavailable')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const onOnline = () => void refresh()
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [refresh])

  return { snapshot: loaded?.snapshot ?? null, loading, failure, refresh }
}

function ChangeLine({ quote, inverse }: { quote: FxQuote; inverse: boolean }) {
  const { t, locale } = useI18n()
  const change = changePercent(quote, inverse)
  if (!change || !quote.previous) return null
  const date = formatIsoDate(quote.previous.date, locale)
  const Icon = change.sign() > 0 ? TrendingUp : change.sign() < 0 ? TrendingDown : Minus
  const text =
    change.sign() === 0
      ? fill(t('fx.unchanged'), { date })
      : fill(t('fx.change'), { change: `${change.sign() > 0 ? '+' : ''}${formatDecimal(change, intlLocale(locale))}%`, date })
  return (
    <dd data-testid="fx-change" data-change={change.toString()} className="flex items-center gap-1 text-xs text-muted tabular-nums">
      <Icon size={12} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
    </dd>
  )
}

function DirectionRow({ quote, inverse }: { quote: FxQuote; inverse: boolean }) {
  const { locale } = useI18n()
  const intl = intlLocale(locale)
  const from = inverse ? quote.quote : FX_BASE
  const to = inverse ? FX_BASE : quote.quote
  const rate = displayRate(quote, inverse)
  const nominal = scaledNominal(quote, inverse)
  return (
    <div data-testid={`fx-rate-${from}-${to}`} data-rate={rate.toString()} className="min-w-0">
      <dt className="text-xs text-muted">
        {from} → {to}
      </dt>
      <dd className="font-display text-[length:clamp(1rem,7cqi,1.5rem)] leading-tight tabular-nums [overflow-wrap:anywhere]">
        1 {from} = {formatDecimal(rate, intl)} {to}
      </dd>
      {nominal ? (
        <dd data-testid="fx-nominal" className="text-sm text-muted tabular-nums [overflow-wrap:anywhere]">
          {formatDecimal(nominal, intl)} {from} = {formatDecimal(convert(nominal, quote, inverse).rounded, intl)} {to}
        </dd>
      ) : null}
      <ChangeLine quote={quote} inverse={inverse} />
    </div>
  )
}

function PairCard({ quote, today }: { quote: FxQuote; today: string }) {
  const { t, locale } = useI18n()
  const stale = isStale(quote.date, today)
  return (
    <article
      data-testid="fx-pair"
      data-quote={quote.quote}
      data-stale={stale}
      className="@container min-w-0 rounded-2xl border border-line px-4 py-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="min-w-0 font-medium [overflow-wrap:anywhere]">
          {FX_BASE} / {quote.quote} <span className="text-sm font-normal text-muted">{t(`fx.currencies.${quote.quote}`)}</span>
        </h3>
        {stale ? (
          <span data-testid="fx-stale" title={t('fx.staleHint')} className="rounded-full bg-brass-soft px-2 py-0.5 text-xs font-medium text-brass">
            {t('fx.stale')}
          </span>
        ) : null}
      </div>
      <dl className="mt-2 grid gap-3">
        <DirectionRow quote={quote} inverse={false} />
        <DirectionRow quote={quote} inverse />
      </dl>
      <p className="mt-3 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
        <span data-testid="fx-date" data-date={quote.date}>
          {fill(t('fx.rateDate'), { date: formatIsoDate(quote.date, locale) })}
        </span>
        <a
          href={FX_SOURCE_PAGES[quote.source]}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="fx-source"
          data-source={quote.source}
          className="inline-flex min-w-0 items-center gap-1 underline decoration-line underline-offset-2 hover:text-ink"
        >
          <span className="[overflow-wrap:anywhere]">{t(`fx.sources.${quote.source}`)}</span>
          <ExternalLink size={11} aria-hidden="true" className="shrink-0" />
        </a>
        {quote.legs ? <span>{fill(t('fx.crossVia'), { via: crossVia(quote.legs) })}</span> : null}
      </p>
    </article>
  )
}

function Converter({ snapshot }: { snapshot: FxSnapshot }) {
  const { t, locale } = useI18n()
  const intl = intlLocale(locale)
  const amountId = useId()
  const directionId = useId()
  const errorId = useId()
  const [amount, setAmount] = useState('100')
  const [selected, setSelected] = useState('USD-UZS')
  const direction = FX_DIRECTIONS.find((item) => item.id === selected) ?? FX_DIRECTIONS[1]
  const quote = snapshot.quotes.find((item) => item.quote === direction.quote) as FxQuote
  const outcome = useMemo(() => {
    try {
      return { result: convert(parseAmountInput(amount, direction.from), quote, direction.inverse), error: null }
    } catch (error) {
      return { result: null, error: error instanceof AppError ? error.code : 'AMOUNT' }
    }
  }, [amount, direction, quote])
  const { result } = outcome

  return (
    <form data-testid="fx-converter" className="@container mt-4 rounded-2xl border border-line px-4 py-3" onSubmit={(event) => event.preventDefault()}>
      <h3 className="text-sm font-medium">{t('fx.converter')}</h3>
      <div className="mt-2 grid gap-3 @lg:grid-cols-2 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.3fr)] @3xl:items-end">
        <div className="min-w-0">
          <label htmlFor={amountId} className="mb-1.5 block text-sm">
            {t('fx.amount')} · {direction.from}
          </label>
          <input
            id={amountId}
            data-testid="fx-amount"
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            aria-invalid={outcome.error ? true : undefined}
            aria-describedby={outcome.error ? errorId : undefined}
            onChange={(event) => setAmount(event.target.value)}
            className={`${controlClass} tabular-nums`}
          />
        </div>
        <div className="min-w-0">
          <label htmlFor={directionId} className="mb-1.5 block text-sm">
            {t('fx.direction')}
          </label>
          <div className="flex gap-2">
            <select
              id={directionId}
              data-testid="fx-direction"
              value={direction.id}
              onChange={(event) => setSelected(event.target.value)}
              className={`${controlClass} min-w-0`}
            >
              {FX_DIRECTIONS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.from} → {item.to}
                </option>
              ))}
            </select>
            <Button
              variant="quiet"
              data-testid="fx-swap"
              aria-label={t('fx.swap')}
              title={t('fx.swap')}
              className="shrink-0 px-3"
              onClick={() => setSelected(`${direction.to}-${direction.from}`)}
            >
              <ArrowLeftRight size={16} aria-hidden="true" />
            </Button>
          </div>
        </div>
        <output
          data-testid="fx-result"
          htmlFor={`${amountId} ${directionId}`}
          aria-live="polite"
          data-amount={result?.rounded.toString() ?? ''}
          data-exact={result?.exact.toString() ?? ''}
          data-currency={direction.to}
          className="min-w-0 @lg:col-span-2 @3xl:col-span-1"
        >
          <span className="block text-sm">{t('fx.result')}</span>
          <span className="block font-display text-[length:clamp(1.25rem,6cqi,2rem)] leading-tight tabular-nums [overflow-wrap:anywhere]">
            {result ? `${formatDecimal(result.rounded, intl)} ${direction.to}` : '—'}
          </span>
          {result && !result.exact.equals(result.rounded) ? (
            <span className="block text-xs text-muted tabular-nums [overflow-wrap:anywhere]">
              {fill(t('fx.exact'), { value: `${formatDecimal(result.exact, intl)} ${direction.to}` })}
            </span>
          ) : null}
        </output>
      </div>
      {outcome.error ? (
        <p id={errorId} role="alert" data-testid="fx-amount-error" className="mt-2 text-sm text-clay-ink">
          {errorText(outcome.error, t)}
        </p>
      ) : null}
    </form>
  )
}

export function ExchangeRates() {
  const { t, locale } = useI18n()
  const { snapshot, loading, failure, refresh } = useExchangeRates()
  const today = toIsoDate(new Date())

  return (
    <section
      data-testid="fx-panel"
      aria-labelledby="fx-title"
      aria-busy={loading}
      className="@container min-w-0 rounded-3xl border border-line bg-card px-5 py-4"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id="fx-title" className="font-display text-2xl">
            {t('fx.title')}
          </h2>
          <p className="text-sm text-muted">{t('fx.subtitle')}</p>
        </div>
        <button
          type="button"
          data-testid="fx-refresh"
          aria-label={t('fx.refresh')}
          title={t('fx.refresh')}
          disabled={loading}
          onClick={() => void refresh()}
          className="grid size-8 shrink-0 place-items-center rounded-full border border-line text-muted hover:text-ink disabled:opacity-60"
        >
          <RefreshCw size={15} aria-hidden="true" className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {snapshot && failure ? (
        <div data-testid="fx-notice" data-failure={failure} role="status" className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl bg-brass-soft px-4 py-2 text-sm">
          <span className="min-w-0 flex-1">{t(failure === 'offline' ? 'fx.offlineCached' : 'fx.refreshFailed')}</span>
          <button type="button" data-testid="fx-retry" className="font-medium underline underline-offset-2" onClick={() => void refresh()}>
            {t('fx.retry')}
          </button>
        </div>
      ) : null}

      {snapshot ? (
        <>
          <div className="mt-4 grid gap-3 @3xl:grid-cols-3">
            {snapshot.quotes.map((quote) => (
              <PairCard key={quote.quote} quote={quote} today={today} />
            ))}
          </div>
          <Converter snapshot={snapshot} />
          <p data-testid="fx-published" className="mt-3 text-xs text-muted">
            {fill(t('fx.published'), { when: formatWhen(snapshot.generatedAt, locale) })}
          </p>
        </>
      ) : loading ? (
        <div data-testid="fx-loading" className="mt-4 grid h-40 place-items-center rounded-2xl border border-dashed border-line text-sm text-muted">
          {t('fx.loading')}
        </div>
      ) : (
        <div data-testid="fx-error" data-failure={failure} role="alert" className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl bg-clay/10 px-4 py-3 text-sm text-clay-ink">
          <span className="min-w-0 flex-1">{t(failure === 'offline' ? 'fx.offline' : 'fx.unavailable')}</span>
          <Button variant="quiet" data-testid="fx-retry" onClick={() => void refresh()}>
            {t('fx.retry')}
          </Button>
        </div>
      )}

      <p data-testid="fx-disclaimer" className="mt-3 text-xs text-muted">
        {t('fx.disclaimer')}
      </p>
    </section>
  )
}
