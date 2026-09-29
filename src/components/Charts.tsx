import {
  ArcElement,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
} from 'chart.js'
import type { ReactNode } from 'react'
import { Bar, Doughnut, Line } from 'react-chartjs-2'
import { useI18n } from '../context/I18nContext'
import { useTheme } from '../context/ThemeContext'
import type { DashboardData } from '../domain/types'
import type { Locale } from '../i18n'
import { intlLocale } from '../lib/money'

ChartJS.register(CategoryScale, LinearScale, BarElement, ArcElement, PointElement, LineElement, Tooltip, Legend)

const slices = ['#0f6e56', '#8d5b2a', '#9d3b34', '#3d6b8a', '#6b5b95', '#b86b2a', '#2f6f4e', '#8a4b63']

function monthLabel(month: string, locale: Locale): string {
  const [year, mon] = month.split('-').map(Number)
  return new Date(year, mon - 1, 1).toLocaleDateString(intlLocale(locale), { month: 'short' })
}

export function FinanceCharts({ data }: { data: DashboardData }) {
  const { t, locale } = useI18n()
  const { resolved } = useTheme()
  const ink = resolved === 'dark' ? '#f3efe6' : '#1d1a15'
  const grid = resolved === 'dark' ? 'rgba(243,239,230,0.08)' : 'rgba(29,26,21,0.08)'
  const income = resolved === 'dark' ? '#8ee0c4' : '#0f6e56'
  const expense = resolved === 'dark' ? '#f0b0a8' : '#9d3b34'
  const labels = data.months.map((month) => monthLabel(month, locale))
  const hasFlow = data.incomeByMonth.some((value) => value > 0) || data.expenseByMonth.some((value) => value > 0)
  const legend = { labels: { color: ink } }
  const scales = {
    x: { ticks: { color: ink }, grid: { color: grid } },
    y: { ticks: { color: ink }, grid: { color: grid }, beginAtZero: true },
  }

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <ChartCard title={t('chart.incomeVsExpense')} testId="chart-monthly">
        {hasFlow ? (
          <Bar
            data={{
              labels,
              datasets: [
                { label: t('chart.income'), data: data.incomeByMonth, backgroundColor: income, borderRadius: 8 },
                { label: t('chart.expense'), data: data.expenseByMonth, backgroundColor: expense, borderRadius: 8 },
              ],
            }}
            options={{ responsive: true, maintainAspectRatio: false, plugins: { legend }, scales }}
          />
        ) : (
          <Empty label={t('chart.noData')} />
        )}
      </ChartCard>
      <ChartCard title={t('chart.byCategory')} testId="chart-category">
        {data.categories.length > 0 ? (
          <Doughnut
            data={{
              labels: data.categories.map((item) => item.label),
              datasets: [{ data: data.categories.map((item) => item.total), backgroundColor: slices, borderWidth: 0 }],
            }}
            options={{ responsive: true, maintainAspectRatio: false, plugins: { legend }, cutout: '62%' }}
          />
        ) : (
          <Empty label={t('chart.noData')} />
        )}
      </ChartCard>
      <ChartCard title={t('chart.trend')} testId="chart-trend">
        {data.trend.length > 0 ? (
          <Line
            data={{
              labels: data.trend.map((item) => item.date),
              datasets: [
                {
                  label: t('chart.expense'),
                  data: data.trend.map((item) => item.total),
                  borderColor: expense,
                  backgroundColor: expense,
                  tension: 0.3,
                  pointRadius: 3,
                },
              ],
            }}
            options={{ responsive: true, maintainAspectRatio: false, plugins: { legend }, scales }}
          />
        ) : (
          <Empty label={t('chart.noData')} />
        )}
      </ChartCard>
      <ChartCard
        title={data.breakdownMode === 'group' ? t('chart.breakdownGroups') : t('chart.breakdown')}
        testId="chart-breakdown"
      >
        {data.breakdown.length > 0 ? (
          <Bar
            data={{
              labels: data.breakdown.map((item) => item.label),
              datasets: [{ label: t('chart.expense'), data: data.breakdown.map((item) => item.total), backgroundColor: income, borderRadius: 8 }],
            }}
            options={{ responsive: true, maintainAspectRatio: false, plugins: { legend }, scales }}
          />
        ) : (
          <Empty label={t('chart.noData')} />
        )}
      </ChartCard>
    </div>
  )
}

function ChartCard({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <section data-testid={testId} className="rounded-3xl border border-line bg-card p-5" aria-label={title}>
      <h2 className="mb-4 font-display text-2xl">{title}</h2>
      <div className="h-64">{children}</div>
    </section>
  )
}

function Empty({ label }: { label: string }) {
  return <p className="grid h-full place-items-center text-sm text-muted">{label}</p>
}
