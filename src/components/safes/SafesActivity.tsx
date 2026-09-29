import { ChevronLeft } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useI18n } from '../../context/I18nContext'
import { formatWhen } from '../../lib/money'
import { listSafeEvents, listSafes } from '../../services/safe.service'
import { Panel } from '../ui'
import { SafesGate } from './SafesGate'
import { SafesNav } from './SafesHome'
import { ErrorNotice, PageHeader, useSafeQuery } from './shared'

export function SafesActivity() {
  const { t } = useI18n()
  return (
    <div data-testid="safes-activity">
      <PageHeader title={t('safes.activity')} intro={t('safes.activityIntro')} actions={<SafesNav />} />
      <SafesGate>
        <ActivityList />
      </SafesGate>
    </div>
  )
}

function ActivityList() {
  const { t, locale } = useI18n()
  const { data, error } = useSafeQuery(async (vault, keyring) => {
    const [events, safes] = [await listSafeEvents(vault, keyring), await listSafes(vault, keyring, { includeTrashed: true })]
    return { events, names: new Map(safes.map((safe) => [safe.id, safe.meta?.name ?? null])) }
  }, [])
  return (
    <div className="space-y-5">
      <Link to="/app/safes" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ChevronLeft size={16} aria-hidden="true" />
        {t('safes.back')}
      </Link>
      <ErrorNotice error={error} />
      {data && data.events.length === 0 ? <Panel className="text-center text-sm text-muted">{t('safes.activityEmpty')}</Panel> : null}
      {data && data.events.length > 0 ? (
        <ol className="divide-y divide-line rounded-3xl border border-line bg-card" data-testid="safe-events">
          {data.events.map((event) => {
            const name = event.safeId ? data.names.get(event.safeId) : null
            return (
              <li key={event.id} className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3" data-testid="safe-event">
                <span className="min-w-0">
                  <span className="text-sm font-medium">{t(`safes.events.${event.type}`)}</span>
                  {event.count && event.count > 1 ? <span className="text-sm text-muted tabular-nums"> ×{event.count}</span> : null}
                  {name ? <span className="block truncate text-xs text-muted">{name}</span> : null}
                </span>
                <time dateTime={event.at} className="shrink-0 text-xs text-muted tabular-nums">
                  {formatWhen(event.at, locale)}
                </time>
              </li>
            )
          })}
        </ol>
      ) : null}
    </div>
  )
}
