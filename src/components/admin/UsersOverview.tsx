import { lazy, Suspense, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '../../context/I18nContext'
import type { MessageKey } from '../../i18n'
import { formatWhen } from '../../lib/money'
import type { UsersOverview as Overview } from '../../services/user.service'
import { fill } from '../table/model'

const UsersCharts = lazy(() => import('./UsersCharts').then((module) => ({ default: module.UsersCharts })))

function Tile({ label, value, testId, children }: { label: string; value: ReactNode; testId: string; children?: ReactNode }) {
  return (
    <div data-testid={testId} className="min-w-0 rounded-2xl border border-line bg-paper/50 p-4">
      <p className="text-xs uppercase tracking-[0.12em] text-muted">{label}</p>
      <p className="mt-1 font-display text-3xl tabular-nums">{value}</p>
      {children ? <div className="mt-1 grid gap-0.5 text-sm text-muted">{children}</div> : null}
    </div>
  )
}

const ATTENTION: { key: 'mustChange' | 'noAccess' | 'noGroup' | 'legacyWraps' | 'suspended'; label: MessageKey }[] = [
  { key: 'mustChange', label: 'people.overview.mustChange' },
  { key: 'noAccess', label: 'people.overview.noAccess' },
  { key: 'noGroup', label: 'people.overview.noGroup' },
  { key: 'suspended', label: 'people.overview.suspended' },
  { key: 'legacyWraps', label: 'people.overview.legacy' },
]

/** Counts only: no codes, password copies or keys appear here. */
export function UsersOverview({ overview }: { overview: Overview }) {
  const { t, locale } = useI18n()
  const used = overview.slotsUsed + overview.slotsReserved
  const percent = overview.active > 0 ? Math.round((overview.totpOn / overview.active) * 100) : 0
  const attention = ATTENTION.filter((item) => overview[item.key] > 0)
  return (
    <section data-testid="users-overview" aria-labelledby="users-overview-title" className="grid gap-4 rounded-3xl border border-line bg-card p-5">
      <h2 id="users-overview-title" className="font-display text-2xl">
        {t('people.overview.title')}
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile testId="overview-members" label={t('people.overview.members')} value={overview.members}>
          <span>{fill(t('people.overview.places'), { used, limit: overview.limit })}</span>
          {overview.slotsReserved > 0 ? <span>{fill(t('people.overview.reserved'), { count: overview.slotsReserved })}</span> : null}
          {overview.former > 0 ? <span>{fill(t('people.overview.former'), { count: overview.former })}</span> : null}
        </Tile>
        <Tile testId="overview-totp" label={t('people.overview.totp')} value={`${percent}%`}>
          <span>{fill(t('people.overview.totpOf'), { on: overview.totpOn, active: overview.active })}</span>
        </Tile>
        <div data-testid="overview-attention" className="min-w-0 rounded-2xl border border-line bg-paper/50 p-4 sm:col-span-2">
          <p className="text-xs uppercase tracking-[0.12em] text-muted">{t('people.overview.attention')}</p>
          {attention.length === 0 ? (
            <p className="mt-2 text-sm text-pine-ink">{t('people.overview.allGood')}</p>
          ) : (
            <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
              {attention.map((item) => (
                <li key={item.key} data-testid={`overview-${item.key}`} data-count={overview[item.key]} className="flex justify-between gap-3">
                  <span>{t(item.label)}</span>
                  <span className="font-medium tabular-nums">{overview[item.key]}</span>
                </li>
              ))}
            </ul>
          )}
          {overview.legacyWraps > 0 ? <p className="mt-2 text-xs text-muted">{t('people.overview.legacyHelp')}</p> : null}
        </div>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div data-testid="overview-recent" className="min-w-0 rounded-2xl border border-line bg-paper/50 p-4">
          <p className="text-xs uppercase tracking-[0.12em] text-muted">{t('people.overview.recent')}</p>
          {overview.recent.length === 0 ? (
            <p className="mt-2 text-sm text-muted">{t('people.overview.recentNone')}</p>
          ) : (
            <ul className="mt-2 grid gap-1 text-sm">
              {overview.recent.map((person) => (
                <li key={person.id} className="flex flex-wrap justify-between gap-x-3">
                  <Link to={`/app/users/${person.id}`} className="min-w-0 break-all text-pine-ink hover:underline">
                    {person.displayName ?? person.email}
                  </Link>
                  <span className="whitespace-nowrap tabular-nums text-muted">{formatWhen(person.lastSignInAt, locale)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-muted">{fill(t('people.overview.activeLast30'), { count: overview.activeLast30 })}</p>
        </div>
        <div data-testid="overview-codes" className="min-w-0 rounded-2xl border border-line bg-paper/50 p-4">
          <p className="text-xs uppercase tracking-[0.12em] text-muted">{t('people.overview.openCodes')}</p>
          {overview.openCodes.length === 0 ? (
            <p className="mt-2 text-sm text-muted">{t('people.overview.openCodesNone')}</p>
          ) : (
            <ul className="mt-2 grid gap-1 text-sm">
              {overview.openCodes.slice(0, 5).map((code) => (
                <li key={code.id} className="flex flex-wrap justify-between gap-x-3">
                  <span className="min-w-0 break-all">
                    {code.email} <span className="text-muted">· {code.kind === 'RESET' ? t('invites.kindReset') : t('invites.kindInvite')}</span>
                  </span>
                  <span className={`whitespace-nowrap tabular-nums ${code.expired ? 'text-clay-ink' : 'text-muted'}`}>
                    {code.expired ? t('people.overview.expired') : fill(t('people.overview.expires'), { when: formatWhen(code.expiresAt, locale) })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {overview.members > 0 ? (
        <Suspense fallback={<div className="h-48" />}>
          <UsersCharts overview={overview} />
        </Suspense>
      ) : null}
    </section>
  )
}
