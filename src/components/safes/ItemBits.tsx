import { CreditCard, Repeat, Star, StickyNote } from 'lucide-react'
import { useI18n } from '../../context/I18nContext'
import type { Locale, MessageKey } from '../../i18n'
import { expiryLabel, expiryStatus, lastFour } from '../../domain/cards'
import type { ItemKind, SecureItem, SubscriptionItem } from '../../domain/safes'
import { nextRenewal } from '../../domain/subscriptions'
import { formatIsoDate, formatMoney } from '../../lib/money'

export const KIND_ICONS: Record<ItemKind, typeof CreditCard> = { CARD: CreditCard, SUBSCRIPTION: Repeat, NOTE: StickyNote }

type T = (key: MessageKey) => string

export function cycleText(item: Pick<SubscriptionItem, 'cycle' | 'customDays'>, t: T): string {
  if (item.cycle === 'CUSTOM') return `${item.customDays ?? 0} ${t('safes.sub.inDays')}`
  return t(`safes.sub.cycles.${item.cycle}`)
}

export function itemSubtitle(item: SecureItem, t: T, locale: Locale, today: string): string {
  if (item.kind === 'CARD') return `${t(`safes.card.brands.${item.brand}`)} •••• ${lastFour(item.number)} · ${expiryLabel(item.expMonth, item.expYear)}`
  if (item.kind === 'SUBSCRIPTION') {
    const price = `${formatMoney(item.amountMinor, item.currency, locale)} · ${cycleText(item, t)}`
    if (item.status !== 'ACTIVE') return `${price} · ${t(`safes.sub.statuses.${item.status}`)}`
    return `${price} · ${formatIsoDate(nextRenewal(item.anchorDate, item.cycle, item.customDays, today), locale)}`
  }
  return t('safes.kinds.NOTE')
}

export function ItemBadge({ item, today }: { item: SecureItem; today: string }) {
  if (item.kind !== 'CARD') return null
  const status = expiryStatus(item.expMonth, item.expYear, today)
  if (status === 'OK') return null
  return <ExpiryBadge status={status} />
}

export function ExpiryBadge({ status }: { status: 'SOON' | 'EXPIRED' }) {
  const { t } = useI18n()
  return (
    <span className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${status === 'EXPIRED' ? 'bg-clay/15 text-clay-ink' : 'bg-brass-soft text-brass'}`}>
      {status === 'EXPIRED' ? t('safes.card.expired') : t('safes.card.expiresSoon')}
    </span>
  )
}

export function ItemLine({
  item,
  today,
  selected,
  onOpen,
  extra,
}: {
  item: SecureItem
  today: string
  selected?: boolean
  onOpen: () => void
  extra?: string
}) {
  const { t, locale } = useI18n()
  const Icon = KIND_ICONS[item.kind]
  return (
    <button
      type="button"
      data-testid="safe-item"
      data-kind={item.kind}
      onClick={onOpen}
      className={`flex w-full min-w-0 items-center gap-3 rounded-2xl border px-3 py-2.5 text-left transition ${selected ? 'border-pine-ink bg-pine/5' : 'border-line bg-card hover:border-brass'}`}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-paper text-muted" aria-hidden="true">
        <Icon size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium">{item.title}</span>
          {item.favorite ? <Star size={12} className="shrink-0 fill-brass text-brass" aria-label={t('safes.favorites')} /> : null}
        </span>
        <span className="block truncate text-xs text-muted">{extra ? `${extra} · ` : ''}{itemSubtitle(item, t, locale, today)}</span>
      </span>
      <ItemBadge item={item} today={today} />
    </button>
  )
}
