import { useMemo } from 'react'
import { FinanceCharts } from './Charts'
import { PeriodPicker } from './PeriodPicker'
import { useI18n } from '../context/I18nContext'
import { usePeriod } from '../context/PeriodContext'
import { useVault } from '../context/VaultContext'
import { loadDashboard } from '../services/finance.service'
import { formatMoney, intlLocale } from '../lib/money'

export function Dashboard() {
  const { t, locale } = useI18n()
  const { query, currency, revision } = useVault()
  const { range } = usePeriod()
  const data = useMemo(
    () => query((vault) => loadDashboard(vault, range, locale)),
    [query, range, locale, revision],
  )
  const savings = Math.round(data.savingsRate * 10) / 10
  const cards = [
    { id: 'kpi-net', label: t('kpi.net'), amount: data.net, text: formatMoney(data.net, currency, locale) },
    { id: 'kpi-income', label: t('kpi.income'), amount: data.income, text: formatMoney(data.income, currency, locale) },
    { id: 'kpi-expense', label: t('kpi.expense'), amount: data.expense, text: formatMoney(data.expense, currency, locale) },
    {
      id: 'kpi-savings',
      label: t('kpi.savings'),
      amount: savings,
      text: `${new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 1 }).format(savings)}%`,
    },
  ]

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl">{t('dashboard.title')}</h1>
          <p className="mt-1 text-sm text-muted">{t('dashboard.subtitle')}</p>
        </div>
        <PeriodPicker />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => (
          <article key={card.id} className="rounded-3xl border border-line bg-card px-5 py-4">
            <p className="text-sm text-muted">{card.label}</p>
            <p data-testid={card.id} data-amount={String(card.amount)} className="mt-2 font-display text-4xl tabular-nums">
              {card.text}
            </p>
          </article>
        ))}
      </div>
      <FinanceCharts data={data} />
    </div>
  )
}
