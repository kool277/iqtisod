import { Archive, History, Lock, LockKeyhole, Plus, Search, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useI18n } from '../../context/I18nContext'
import { useSafes } from '../../context/SafeContext'
import { expiryStatus } from '../../domain/cards'
import type { CardItem, SecureItem } from '../../domain/safes'
import { subscriptionSummary } from '../../domain/subscriptions'
import { formatIsoDate, formatMoney, formatWhen } from '../../lib/money'
import { createSafe, listOpenItems, listSafes, type SafeSummary } from '../../services/safe.service'
import { Button, Panel, controlClass } from '../ui'
import { ExpiryBadge, ItemLine } from './ItemBits'
import { EMPTY_SAFE, SafeForm } from './SafeForm'
import { SafesGate, useSafeStatus } from './SafesGate'
import { Dialog, ErrorNotice, PageHeader, SafeGlyph, Warning, secureInputProps, todayIso, useSafeQuery } from './shared'

export function SafesHome() {
  const { t } = useI18n()
  return (
    <div data-testid="safes-page">
      <PageHeader title={t('safes.title')} intro={t('safes.intro')} actions={<SafesNav />} help="safes" />
      <SafesGate>
        <SafesOverview />
      </SafesGate>
    </div>
  )
}

export function SafesNav() {
  const { t } = useI18n()
  const { keyring, lock } = useSafes()
  if (!keyring) return null
  const linkClass = 'inline-flex items-center gap-1.5 rounded-xl border border-line bg-card px-3 py-2 text-sm hover:border-brass'
  return (
    <>
      <Link to="/app/safes/trash" className={linkClass} data-testid="safes-trash-link">
        <Trash2 size={15} aria-hidden="true" />
        {t('safes.trash')}
      </Link>
      <Link to="/app/safes/activity" className={linkClass} data-testid="safes-activity-link">
        <History size={15} aria-hidden="true" />
        {t('safes.activity')}
      </Link>
      <Button variant="quiet" className="py-2" onClick={() => lock()} data-testid="safes-lock">
        <Lock size={15} aria-hidden="true" />
        {t('safes.lock')}
      </Button>
    </>
  )
}

function matches(item: SecureItem, needle: string): boolean {
  const fields = [item.title]
  if (item.kind === 'CARD') fields.push(item.bank, item.cardholder)
  if (item.kind === 'SUBSCRIPTION') fields.push(item.url, item.account)
  return fields.some((field) => field.toLocaleLowerCase().includes(needle))
}

function SafesOverview() {
  const { t, locale } = useI18n()
  const navigate = useNavigate()
  const { previousUnlockAt, withKeyring } = useSafes()
  const status = useSafeStatus()
  const [search, setSearch] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [creating, setCreating] = useState(false)
  const today = todayIso()
  const { data, error } = useSafeQuery(
    async (vault, keyring) => ({ safes: await listSafes(vault, keyring), open: await listOpenItems(vault, keyring) }),
    [],
  )
  const safes = data?.safes ?? []
  const items = data?.open.items ?? []
  const names = useMemo(() => new Map(safes.map((safe) => [safe.id, safe.meta?.name ?? ''])), [safes])
  const summary = useMemo(() => subscriptionSummary(items, today), [items, today])
  const expiring = useMemo(
    () =>
      items
        .filter((item): item is CardItem => item.kind === 'CARD')
        .map((card) => ({ card, status: expiryStatus(card.expMonth, card.expYear, today) }))
        .filter((entry) => entry.status !== 'OK'),
    [items, today],
  )
  const favorites = items.filter((item) => item.favorite)
  const needle = search.trim().toLocaleLowerCase()
  const results = needle ? items.filter((item) => matches(item, needle)) : []
  const visible = safes.filter((safe) => showArchived || !safe.meta?.archived)
  const hasArchived = safes.some((safe) => safe.meta?.archived)
  const openItem = (item: SecureItem) => navigate(`/app/safes/${item.safeId}?item=${item.id}`)

  return (
    <div className="space-y-6">
      <p className="text-xs text-muted" data-testid="safes-last-unlock">
        {previousUnlockAt ? `${t('safes.lastUnlocked')}: ${formatWhen(previousUnlockAt, locale)}` : t('safes.lastUnlockedNever')}
      </p>
      {status && !status.hasRecovery ? (
        <Warning testId="no-recovery-banner">
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0">{t('safes.noRecoveryWarn')}</span>
            <Link to="/app/account" className="shrink-0 rounded-xl border border-line bg-card px-3 py-1.5 font-medium hover:border-brass">
              {t('safes.noRecoveryAction')}
            </Link>
          </span>
        </Warning>
      ) : null}
      <ErrorNotice error={error} />
      <div className="flex flex-wrap items-center gap-3">
        <label className="relative min-w-0 flex-1 basis-64">
          <span className="sr-only">{t('safes.search')}</span>
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
          <input
            {...secureInputProps}
            type="search"
            data-testid="safes-search"
            placeholder={t('safes.search')}
            className={`${controlClass} pl-9`}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <Button onClick={() => setCreating(true)} data-testid="safe-new">
          <Plus size={16} aria-hidden="true" />
          {t('safes.newSafe')}
        </Button>
      </div>

      {needle ? (
        <section aria-label={t('safes.search')} className="space-y-2" data-testid="safes-search-results">
          {results.length === 0 ? <p className="text-sm text-muted">{t('safes.noResults')}</p> : null}
          {results.map((item) => (
            <ItemLine key={item.id} item={item} today={today} extra={names.get(item.safeId)} onOpen={() => openItem(item)} />
          ))}
        </section>
      ) : (
        <>
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="safe-grid">
            {visible.map((safe) => (
              <SafeCard key={safe.id} safe={safe} />
            ))}
          </section>
          {hasArchived ? (
            <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-muted">
              <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} data-testid="safes-show-archived" />
              {t('safes.showArchived')}
            </label>
          ) : null}
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel className="min-w-0">
              <div data-testid="subscription-summary" className="space-y-4">
                <h2 className="font-display text-2xl">{t('safes.sub.upcoming')}</h2>
                {summary.totals.length > 0 ? (
                  <dl className="grid gap-2 sm:grid-cols-2">
                    {summary.totals.map((total) => (
                      <div key={total.currency} className="min-w-0 rounded-2xl bg-paper px-3 py-2" data-testid="subscription-total">
                        <dt className="text-xs text-muted">
                          {total.currency} · {t('safes.sub.monthlyTotal')}
                        </dt>
                        <dd className="truncate text-lg font-medium tabular-nums">{formatMoney(total.monthlyMinor, total.currency, locale)}</dd>
                        <dd className="truncate text-xs text-muted tabular-nums">
                          {t('safes.sub.yearlyTotal')}: {formatMoney(total.yearlyMinor, total.currency, locale)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                {summary.upcoming.length === 0 ? (
                  <p className="text-sm text-muted">{t('safes.sub.noUpcoming')}</p>
                ) : (
                  <ul className="divide-y divide-line">
                    {summary.upcoming.map((payment) => (
                      <li key={payment.itemId} className="flex min-w-0 items-center justify-between gap-3 py-2" data-testid="upcoming-payment">
                        <Link to={`/app/safes/${payment.safeId}?item=${payment.itemId}`} className="min-w-0 hover:underline">
                          <span className="block truncate text-sm font-medium">{payment.title}</span>
                          <span className="block truncate text-xs text-muted">
                            {payment.daysLeft === 0 ? t('safes.sub.today') : formatIsoDate(payment.date, locale)}
                          </span>
                        </Link>
                        <span className={`shrink-0 text-sm tabular-nums ${payment.soon ? 'font-medium text-clay-ink' : ''}`}>
                          {formatMoney(payment.amountMinor, payment.currency, locale)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-muted">{t('safes.sub.approx')}</p>
              </div>
            </Panel>
            <div className="min-w-0 space-y-4">
              <Panel>
                <h2 className="mb-3 font-display text-2xl">{t('safes.expiringCards')}</h2>
                {expiring.length === 0 ? (
                  <p className="text-sm text-muted">{t('safes.noExpiring')}</p>
                ) : (
                  <ul className="space-y-2" data-testid="expiring-cards">
                    {expiring.map(({ card, status: expiry }) => (
                      <li key={card.id} className="flex min-w-0 items-center justify-between gap-2">
                        <Link to={`/app/safes/${card.safeId}?item=${card.id}`} className="min-w-0 truncate text-sm hover:underline">
                          {card.title}
                        </Link>
                        {expiry !== 'OK' ? <ExpiryBadge status={expiry} /> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
              {favorites.length > 0 ? (
                <Panel>
                  <h2 className="mb-3 font-display text-2xl">{t('safes.favorites')}</h2>
                  <div className="space-y-2" data-testid="favorite-items">
                    {favorites.map((item) => (
                      <ItemLine key={item.id} item={item} today={today} extra={names.get(item.safeId)} onOpen={() => openItem(item)} />
                    ))}
                  </div>
                </Panel>
              ) : null}
            </div>
          </div>
        </>
      )}

      {creating ? (
        <Dialog title={t('safes.newSafe')} onClose={() => setCreating(false)} testId="safe-create-dialog">
          <SafeForm
            initial={EMPTY_SAFE}
            submitLabel={t('common.create')}
            onCancel={() => setCreating(false)}
            onSubmit={async (input) => {
              const id = await withKeyring((vault, keyring) => createSafe(vault, keyring, input), { dirty: true })
              setCreating(false)
              navigate(`/app/safes/${id}`)
            }}
          />
        </Dialog>
      ) : null}
    </div>
  )
}

function SafeCard({ safe }: { safe: SafeSummary }) {
  const { t } = useI18n()
  const meta = safe.meta
  if (!meta) {
    return (
      <div className="rounded-3xl border border-dashed border-clay bg-card p-5 text-sm text-clay-ink" data-testid="safe-card">
        {t('safes.unreadable')}
      </div>
    )
  }
  return (
    <Link
      to={`/app/safes/${safe.id}`}
      data-testid="safe-card"
      className={`flex min-w-0 flex-col gap-3 rounded-3xl border border-line bg-card p-5 transition hover:border-brass ${meta.archived ? 'opacity-70' : ''}`}
    >
      <span className="flex min-w-0 items-start gap-3">
        <SafeGlyph icon={meta.icon} color={meta.color} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-display text-xl leading-tight">{meta.name}</span>
          {meta.description ? <span className="line-clamp-2 break-words text-sm text-muted">{meta.description}</span> : null}
        </span>
        {meta.requirePassword ? (
          <LockKeyhole size={16} className="mt-1 shrink-0 text-muted" aria-label={t('safes.requirePasswordShort')} />
        ) : null}
      </span>
      <span className="mt-auto flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <span className="tabular-nums">
          {safe.itemCount} {t('safes.items').toLocaleLowerCase()}
        </span>
        {safe.isDefault ? <span className="rounded-full bg-pine/10 px-2 py-0.5 text-pine-ink">{t('safes.isDefault')}</span> : null}
        {meta.archived ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-paper px-2 py-0.5">
            <Archive size={11} aria-hidden="true" />
            {t('safes.archived')}
          </span>
        ) : null}
      </span>
    </Link>
  )
}
