import { Suspense, lazy, useMemo, type ComponentType } from 'react'
import { PeriodPicker } from './PeriodPicker'
import { useI18n } from '../context/I18nContext'
import { usePeriod } from '../context/PeriodContext'
import { useVault } from '../context/VaultContext'
import { loadDashboard } from '../services/finance.service'
import { formatMoney, intlLocale, minorToDecimal } from '../lib/money'

const FinanceCharts = lazy(() => import('./Charts').then((module) => ({ default: module.FinanceCharts })))
const ExchangeRates = lazy<ComponentType>(() =>
  import('./ExchangeRates').then(
    (module) => ({ default: module.ExchangeRates }),
    () => ({ default: () => null }),
  ),
)

export function Dashboard() {
  const { t, locale } = useI18n()
  const { query, currency, revision } = useVault()
  const { range } = usePeriod()
  const data = useMemo(
    () => query((vault) => loadDashboard(vault, range, locale)),
    [query, range, locale, revision],
  )
  const money = (minor: number) => ({ amount: minorToDecimal(minor, currency), text: formatMoney(minor, currency, locale) })
  const cards = [
    { id: 'kpi-net', label: t('kpi.net'), ...money(data.net) },
    { id: 'kpi-income', label: t('kpi.income'), ...money(data.income) },
    { id: 'kpi-expense', label: t('kpi.expense'), ...money(data.expense) },
    {
      id: 'kpi-savings',
      label: t('kpi.savings'),
      amount: String(data.savingsRate),
      text: `${new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 1 }).format(data.savingsRate)}%`,
    },
  ]

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-4xl">{t('dashboard.title')}</h1>
          <p className="mt-1 text-sm text-muted">{t('dashboard.subtitle')}</p>
        </div>
        <PeriodPicker />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
        {cards.map((card) => (
          <article key={card.id} className="@container min-w-0 rounded-3xl border border-line bg-card px-5 py-4">
            <p className="text-sm text-muted">{card.label}</p>
            <p
              data-testid={card.id}
              data-amount={card.amount}
              title={card.text}
              className="mt-2 font-display text-[length:clamp(1.25rem,9cqi,2.25rem)] leading-tight tabular-nums [overflow-wrap:anywhere]"
            >
              {card.text}
            </p>
          </article>
        ))}
      </div>
      {data.otherCurrencies.length > 0 ? (
        <section data-testid="other-currencies" className="rounded-3xl border border-line bg-card px-5 py-4">
          <h2 className="text-sm text-muted">{t('dashboard.otherCurrencies')}</h2>
          <ul className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm tabular-nums">
            {data.otherCurrencies.map((row) => (
              <li key={row.currency} data-currency={row.currency}>
                <span className="font-medium">{row.currency}</span>{' '}
                <span className="text-pine-ink">+{formatMoney(row.income, row.currency, locale)}</span>{' '}
                <span className="text-clay-ink">−{formatMoney(row.expense, row.currency, locale)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <Suspense fallback={<div className="h-72 rounded-3xl border border-line bg-card" />}>
        <ExchangeRates />
      </Suspense>
      <Suspense fallback={<div className="h-64 rounded-3xl border border-line bg-card" />}>
        <FinanceCharts data={data} />
      </Suspense>
    </div>
  )
}
