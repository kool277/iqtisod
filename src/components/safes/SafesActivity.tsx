import { ChevronLeft } from 'lucide-react'
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '../../context/I18nContext'
import { SAFE_EVENT_TYPES } from '../../domain/safes'
import { formatWhen } from '../../lib/money'
import { listSafeEvents, listSafes } from '../../services/safe.service'
import { DataTable, type Column } from '../table/DataTable'
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

type EventRow = Awaited<ReturnType<typeof listSafeEvents>>[number] & { safeName: string | null }

function ActivityList() {
  const { t, locale } = useI18n()
  const { data, error } = useSafeQuery(async (vault, keyring) => {
    const [events, safes] = [await listSafeEvents(vault, keyring), await listSafes(vault, keyring, { includeTrashed: true })]
    const names = new Map(safes.map((safe) => [safe.id, safe.meta?.name ?? null]))
    return events.map((event): EventRow => ({ ...event, safeName: event.safeId ? (names.get(event.safeId) ?? null) : null }))
  }, [])

  const columns = useMemo<Column<EventRow>[]>(() => {
    const label = (event: EventRow) => t(`safes.events.${event.type}`)
    return [
      {
        id: 'event',
        header: t('table.col.event'),
        hideable: false,
        cell: (event) => (
          <span className="font-medium">
            {label(event)}
            {event.count && event.count > 1 ? <span className="font-normal text-muted tabular-nums"> ×{event.count}</span> : null}
          </span>
        ),
        sort: { type: 'text', value: label },
        search: label,
        filter: { kind: 'select', value: (event) => event.type, options: SAFE_EVENT_TYPES.map((type) => ({ value: type, label: t(`safes.events.${type}`) })) },
      },
      {
        id: 'safe',
        header: t('table.col.safe'),
        cell: (event) => <span className="break-words text-muted">{event.safeName ?? '—'}</span>,
        sort: { type: 'text', value: (event) => event.safeName },
        search: (event) => event.safeName,
      },
      {
        id: 'count',
        header: t('table.col.count'),
        hidden: true,
        align: 'end',
        cell: (event) => <span className="tabular-nums">{event.count ?? 1}</span>,
        sort: { type: 'number', value: (event) => event.count ?? 1 },
        filter: { kind: 'number', value: (event) => event.count ?? 1 },
      },
      {
        id: 'when',
        header: t('audit.when'),
        align: 'end',
        cell: (event) => (
          <time dateTime={event.at} className="whitespace-nowrap text-xs text-muted tabular-nums">
            {formatWhen(event.at, locale)}
          </time>
        ),
        sort: { type: 'date', value: (event) => event.at },
        filter: { kind: 'date', value: (event) => event.at },
      },
    ]
  }, [locale, t])

  return (
    <div className="space-y-5">
      <Link to="/app/safes" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ChevronLeft size={16} aria-hidden="true" />
        {t('safes.back')}
      </Link>
      <ErrorNotice error={error} />
      {data && data.length === 0 ? <Panel className="text-center text-sm text-muted">{t('safes.activityEmpty')}</Panel> : null}
      {data && data.length > 0 ? (
        <div data-testid="safe-events">
          <DataTable
            id="safe-events"
            label={t('safes.activity')}
            rows={data}
            columns={columns}
            rowKey={(event) => event.id}
            rowAttributes={() => ({ 'data-testid': 'safe-event' })}
            secure
            defaultPageSize={50}
          />
        </div>
      ) : null}
    </div>
  )
}
