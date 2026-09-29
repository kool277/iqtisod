import { ArrowDown, ArrowUp, Equal } from 'lucide-react'
import { useI18n } from '../../context/I18nContext'
import type { CurrencySummary, GroupSummary, SummaryTotals } from '../../domain/group-summary'
import { formatIsoDate, intlLocale } from '../../lib/money'
import { formatMinorExact, minorToPlainDecimal } from '../../lib/money-exact'

export type Kind = 'income' | 'expense' | 'net'

const ICONS = { income: ArrowUp, expense: ArrowDown, net: Equal } as const

function Figure({ kind, minor, currency }: { kind: Kind; minor: bigint; currency: string }) {
  const { t, locale } = useI18n()
  const Icon = ICONS[kind]
  const tone = kind === 'income' || (kind === 'net' && minor >= 0n) ? 'text-pine-ink' : 'text-clay-ink'
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1 text-xs text-muted">
        <Icon size={14} aria-hidden="true" className={tone} />
        {t(`groupSummary.${kind}`)}
      </dt>
      <dd
        data-testid={`summary-${kind}`}
        data-amount={minorToPlainDecimal(minor, currency)}
        className={`font-display text-xl leading-tight tabular-nums [overflow-wrap:anywhere] ${tone}`}
      >
        {formatMinorExact(minor, currency, locale)}
      </dd>
    </div>
  )
}

function CurrencyLine({ line, showCode }: { line: CurrencySummary; showCode: boolean }) {
  return (
    <li data-currency={line.currency} className="grid gap-1">
      {showCode ? <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted">{line.currency}</p> : null}
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-x-6 gap-y-2">
        <Figure kind="income" minor={line.incomeMinor} currency={line.currency} />
        <Figure kind="expense" minor={line.expenseMinor} currency={line.currency} />
        <Figure kind="net" minor={line.netMinor} currency={line.currency} />
      </dl>
    </li>
  )
}

/** Income, expenses and net per currency, plus count and last activity. */
export function SummaryFigures({ totals, testId = 'group-summary' }: { totals: SummaryTotals; testId?: string }) {
  const { t, locale } = useI18n()
  if (totals.count === 0) {
    return (
      <p data-testid={testId} data-count="0" className="text-sm text-muted">
        {t('groupSummary.empty')}
      </p>
    )
  }
  const showCode = totals.currencies.length > 1
  return (
    <div data-testid={testId} data-count={totals.count} className="grid gap-3">
      <ul className="grid gap-3">
        {totals.currencies.map((line) => (
          <CurrencyLine key={line.currency} line={line} showCode={showCode} />
        ))}
      </ul>
      <p className="text-xs text-muted">
        {t('groupSummary.transactions')}: <span className="tabular-nums text-ink">{new Intl.NumberFormat(intlLocale(locale)).format(totals.count)}</span>
        {totals.lastDate ? (
          <>
            {' · '}
            {t('groupSummary.lastActivity')}: <span data-testid="summary-last" data-date={totals.lastDate} className="text-ink">{formatIsoDate(totals.lastDate, locale)}</span>
          </>
        ) : null}
      </p>
    </div>
  )
}

const MINOR_OF = { income: 'incomeMinor', expense: 'expenseMinor', net: 'netMinor' } as const

export function amountOf(line: CurrencySummary, kind: Kind): bigint {
  return line[MINOR_OF[kind]]
}

/** A table cell: one amount per currency, one line each; a dash when the group had no transactions. */
export function SummaryAmounts({ summary, kind }: { summary: GroupSummary | undefined; kind: Kind }) {
  const { locale } = useI18n()
  if (!summary || summary.count === 0) return <span className="text-muted">—</span>
  return (
    <span className="grid justify-items-end gap-0.5 @max-3xl:justify-items-start">
      {summary.currencies.map((line) => {
        const minor = amountOf(line, kind)
        const tone = kind === 'income' || (kind === 'net' && minor >= 0n) ? 'text-pine-ink' : 'text-clay-ink'
        return (
          <span
            key={line.currency}
            data-currency={line.currency}
            data-testid={`summary-${kind}`}
            data-amount={minorToPlainDecimal(minor, line.currency)}
            className={`font-medium tabular-nums [overflow-wrap:anywhere] ${tone}`}
          >
            {formatMinorExact(minor, line.currency, locale)}
          </span>
        )
      })}
    </span>
  )
}

/** Plain text for an exported cell, such as `1250.5 USD; -40 EUR`. */
export function summaryAmountsText(summary: GroupSummary | undefined, kind: Kind): string | null {
  if (!summary || summary.count === 0) return null
  return summary.currencies.map((line) => `${minorToPlainDecimal(amountOf(line, kind), line.currency)} ${line.currency}`).join('; ')
}

/** The strip above the group list: everything the viewer may see, per currency. */
export function GroupSummaryTotals({ totals }: { totals: SummaryTotals }) {
  const { t } = useI18n()
  return (
    <section aria-labelledby="group-summary-total-title" className="grid gap-3 rounded-3xl border border-line bg-card px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="group-summary-total-title" className="text-sm font-medium">
          {t('groupSummary.total')}
        </h2>
        {totals.currencies.length > 1 ? <p className="text-xs text-muted">{t('groupSummary.perCurrency')}</p> : null}
      </div>
      <SummaryFigures totals={totals} testId="group-summary-total" />
    </section>
  )
}
