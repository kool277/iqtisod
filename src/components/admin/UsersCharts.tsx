import { ArcElement, BarElement, CategoryScale, Chart as ChartJS, Legend, LinearScale, Tooltip } from 'chart.js'
import { Bar, Doughnut } from 'react-chartjs-2'
import { useI18n } from '../../context/I18nContext'
import { useTheme } from '../../context/ThemeContext'
import type { UsersOverview } from '../../services/user.service'
import { roleLabel } from './shared'

ChartJS.register(CategoryScale, LinearScale, BarElement, ArcElement, Tooltip, Legend)

const ROLE_COLORS = ['#166534', '#8d5b2a', '#3d6b8a']

/** Small role and group charts for the People overview, drawn in the same palette as the dashboard. */
export function UsersCharts({ overview }: { overview: UsersOverview }) {
  const { t } = useI18n()
  const { resolved } = useTheme()
  const ink = resolved === 'dark' ? '#f3efe6' : '#1d1a15'
  const grid = resolved === 'dark' ? 'rgba(243,239,230,0.08)' : 'rgba(29,26,21,0.08)'
  const edge = resolved === 'dark' ? '#16a34a' : '#166534'
  const legend = { position: 'right' as const, labels: { color: ink, boxWidth: 12 } }
  const roles = overview.byRole.filter((item) => item.count > 0)
  const groups = overview.byGroup.slice(0, 8)
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section data-testid="chart-users-roles" aria-label={t('people.overview.byRole')} className="min-w-0 rounded-2xl border border-line bg-paper/50 p-4">
        <h3 className="mb-2 text-sm font-medium text-muted">{t('people.overview.byRole')}</h3>
        <div className="relative h-40 min-w-0">
          <Doughnut
            data={{
              labels: roles.map((item) => roleLabel(item.role, t)),
              datasets: [{ data: roles.map((item) => item.count), backgroundColor: ROLE_COLORS, borderWidth: 0 }],
            }}
            options={{ responsive: true, maintainAspectRatio: false, plugins: { legend }, cutout: '62%' }}
          />
        </div>
      </section>
      <section data-testid="chart-users-groups" aria-label={t('people.overview.byGroup')} className="min-w-0 rounded-2xl border border-line bg-paper/50 p-4">
        <h3 className="mb-2 text-sm font-medium text-muted">{t('people.overview.byGroup')}</h3>
        <div className="relative h-40 min-w-0">
          <Bar
            data={{
              labels: groups.map((item) => item.name ?? t('people.overview.noGroupLabel')),
              datasets: [{ label: t('people.overview.members'), data: groups.map((item) => item.count), backgroundColor: '#166534', borderColor: edge, borderWidth: 1, borderRadius: 6 }],
            }}
            options={{
              indexAxis: 'y',
              responsive: true,
              maintainAspectRatio: false,
              plugins: { legend: { display: false } },
              scales: {
                x: { ticks: { color: ink, precision: 0 }, grid: { color: grid }, beginAtZero: true },
                y: { ticks: { color: ink }, grid: { display: false } },
              },
            }}
          />
        </div>
      </section>
    </div>
  )
}
