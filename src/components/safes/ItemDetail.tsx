import { Copy, ExternalLink, Eye, EyeOff, Pencil, Star, Trash2, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useI18n } from '../../context/I18nContext'
import { useSafes } from '../../context/SafeContext'
import { expiryLabel, expiryStatus, formatPan, lastFour } from '../../domain/cards'
import type { CardItem, SecureItem } from '../../domain/safes'
import { nextRenewal, safeUrl } from '../../domain/subscriptions'
import { copySecret } from '../../lib/clipboard'
import { formatIsoDate, formatMoney, formatWhen } from '../../lib/money'
import { hasRecentAuth } from '../../services/safe.service'
import { Button } from '../ui'
import { ExpiryBadge, KIND_ICONS, cycleText } from './ItemBits'
import { ReauthDialog, todayIso } from './shared'

function useReauth() {
  const { keyring } = useSafes()
  const [pending, setPending] = useState<(() => void) | null>(null)
  const guard = (action: () => void) => {
    if (keyring && hasRecentAuth(keyring)) action()
    else setPending(() => action)
  }
  const dialog = pending ? (
    <ReauthDialog
      onCancel={() => setPending(null)}
      onDone={() => {
        const action = pending
        setPending(null)
        action()
      }}
    />
  ) : null
  return { guard, dialog }
}

function CopyButton({ value, guard, testId }: { value: string; guard?: (action: () => void) => void; testId: string }) {
  const { t } = useI18n()
  const { keyring } = useSafes()
  const [state, setState] = useState<'copied' | 'failed' | null>(null)
  useEffect(() => {
    if (!state) return
    const timer = window.setTimeout(() => setState(null), 3000)
    return () => window.clearTimeout(timer)
  }, [state])
  const copy = () => {
    copySecret(value, keyring?.meta.clipboardSeconds ?? 30).then(
      () => setState('copied'),
      () => setState('failed'),
    )
  }
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        data-testid={testId}
        title={t('safes.copy')}
        className="inline-flex h-8 items-center gap-1 rounded-lg border border-line px-2 text-xs hover:border-brass"
        onClick={() => (guard ? guard(copy) : copy())}
      >
        <Copy size={13} aria-hidden="true" />
        {t('safes.copy')}
      </button>
      {state ? (
        <span role="status" className={`text-xs ${state === 'failed' ? 'text-clay-ink' : 'text-muted'}`}>
          {state === 'copied' ? t('safes.copied') : t('safes.copyFailed')}
        </span>
      ) : null}
    </span>
  )
}

function RevealField({
  label,
  value,
  masked,
  guard,
  testId,
}: {
  label: string
  value: string
  masked: string
  guard: (action: () => void) => void
  testId: string
}) {
  const { t } = useI18n()
  const { keyring } = useSafes()
  const seconds = keyring?.meta.revealSeconds ?? 15
  const [hideAt, setHideAt] = useState<number | null>(null)
  const [, setTick] = useState(0)
  useEffect(() => {
    if (hideAt === null) return
    const timer = window.setTimeout(() => setHideAt(null), Math.max(0, hideAt - Date.now()))
    const tick = window.setInterval(() => {
      if (Date.now() >= hideAt) setHideAt(null)
      else setTick((value) => value + 1)
    }, 1000)
    return () => {
      window.clearTimeout(timer)
      window.clearInterval(tick)
    }
  }, [hideAt])
  const revealed = hideAt !== null && Date.now() < hideAt
  const left = hideAt === null ? 0 : Math.ceil((hideAt - Date.now()) / 1000)
  return (
    <div className="space-y-1.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="flex flex-wrap items-center gap-2">
        <span data-testid={testId} className="min-w-0 break-all font-mono text-base tracking-wider" translate="no">
          {revealed ? value : masked}
        </span>
        <span className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid={`${testId}-reveal`}
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-line px-2 text-xs hover:border-brass"
            onClick={() => (revealed ? setHideAt(null) : guard(() => setHideAt(Date.now() + seconds * 1000)))}
          >
            {revealed ? <EyeOff size={13} aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />}
            {revealed ? t('safes.hide') : t('safes.reveal')}
          </button>
          <CopyButton value={value} guard={guard} testId={`${testId}-copy`} />
          {revealed ? (
            <span className="text-xs tabular-nums text-muted" data-testid={`${testId}-countdown`}>
              {t('safes.hidesIn')} {left} {t('safes.seconds')}
            </span>
          ) : null}
        </span>
      </dd>
    </div>
  )
}

function Plain({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="break-words text-sm">{children}</dd>
    </div>
  )
}

export function ItemDetail({
  item,
  cards,
  readOnly,
  onEdit,
  onFavorite,
  onTrash,
  onClose,
}: {
  item: SecureItem
  cards: CardItem[]
  readOnly: boolean
  onEdit: () => void
  onFavorite: () => void
  onTrash: () => void
  onClose: () => void
}) {
  const { t, locale } = useI18n()
  const { guard, dialog } = useReauth()
  const today = todayIso()
  const Icon = KIND_ICONS[item.kind]
  return (
    <section className="min-w-0 rounded-3xl border border-line bg-card p-5" data-testid="item-detail" data-kind={item.kind}>
      <div className="mb-4 flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-paper text-muted" aria-hidden="true">
          <Icon size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="break-words font-display text-2xl leading-tight">{item.title}</h2>
          <p className="text-xs text-muted">{t(`safes.kinds.${item.kind}`)}</p>
        </div>
        <button
          type="button"
          title={t('common.close')}
          aria-label={t('common.close')}
          className="grid size-8 shrink-0 place-items-center rounded-full text-muted hover:bg-brass-soft hover:text-ink"
          onClick={onClose}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      <dl className="space-y-4">
        {item.kind === 'CARD' ? (
          <>
            <RevealField
              label={t('safes.card.number')}
              value={formatPan(item.number, item.brand)}
              masked={`•••• •••• •••• ${lastFour(item.number)}`}
              guard={guard}
              testId="card-number-value"
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Plain label={t('safes.card.expiry')}>
                <span className="inline-flex items-center gap-2">
                  <span className="tabular-nums">{expiryLabel(item.expMonth, item.expYear)}</span>
                  {(() => {
                    const status = expiryStatus(item.expMonth, item.expYear, today)
                    return status === 'OK' ? null : <ExpiryBadge status={status} />
                  })()}
                </span>
              </Plain>
              <Plain label={t('safes.card.brand')}>{t(`safes.card.brands.${item.brand}`)}</Plain>
              {item.cardholder ? <Plain label={t('safes.card.cardholder')}>{item.cardholder}</Plain> : null}
              {item.bank ? <Plain label={t('safes.card.bank')}>{item.bank}</Plain> : null}
            </div>
            {item.cvv ? <RevealField label={t('safes.card.cvv')} value={item.cvv} masked="•••" guard={guard} testId="card-cvv-value" /> : null}
            {item.notes ? <Plain label={t('common.notes')}>{<span className="whitespace-pre-wrap">{item.notes}</span>}</Plain> : null}
          </>
        ) : null}

        {item.kind === 'SUBSCRIPTION' ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Plain label={t('safes.sub.amount')}>
                <span className="tabular-nums">{formatMoney(item.amountMinor, item.currency, locale)}</span> · {cycleText(item, t)}
              </Plain>
              <Plain label={t('safes.sub.status')}>{t(`safes.sub.statuses.${item.status}`)}</Plain>
              {item.status === 'ACTIVE' ? (
                <Plain label={t('safes.sub.nextRenewal')}>
                  <span data-testid="sub-next">{formatIsoDate(nextRenewal(item.anchorDate, item.cycle, item.customDays, today), locale)}</span>
                </Plain>
              ) : null}
              {item.trialEndsOn ? <Plain label={t('safes.sub.trialEnds')}>{formatIsoDate(item.trialEndsOn, locale)}</Plain> : null}
              <Plain label={t('safes.sub.card')}>
                {item.cardItemId ? (cards.find((card) => card.id === item.cardItemId)?.title ?? t('safes.sub.lockedCard')) : t('safes.sub.noCard')}
              </Plain>
              <Plain label={t('safes.sub.remind')}>{item.remindDaysBefore}</Plain>
            </div>
            {item.url && safeUrl(item.url) ? (
              <Plain label={t('safes.sub.url')}>
                <a href={safeUrl(item.url)!} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="inline-flex max-w-full items-center gap-1 text-pine-ink hover:underline">
                  <span className="truncate">{item.url}</span>
                  <ExternalLink size={12} className="shrink-0" aria-hidden="true" />
                </a>
              </Plain>
            ) : null}
            {item.account ? (
              <div className="space-y-1">
                <dt className="text-xs text-muted">{t('safes.sub.account')}</dt>
                <dd className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="min-w-0 break-all">{item.account}</span>
                  <CopyButton value={item.account} testId="sub-account-copy" />
                </dd>
              </div>
            ) : null}
            {item.notes ? <Plain label={t('common.notes')}>{<span className="whitespace-pre-wrap">{item.notes}</span>}</Plain> : null}
          </>
        ) : null}

        {item.kind === 'NOTE' ? (
          <div className="space-y-2">
            <dt className="sr-only">{t('safes.note.body')}</dt>
            <dd className="whitespace-pre-wrap break-words rounded-2xl bg-paper p-4 text-sm" data-testid="note-body-value">
              {item.body}
            </dd>
            <CopyButton value={item.body} testId="note-copy" />
          </div>
        ) : null}
      </dl>

      <p className="mt-4 text-xs text-muted">{formatWhen(item.updatedAt, locale)}</p>

      {!readOnly ? (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
          <Button variant="quiet" className="py-2" onClick={onEdit} data-testid="item-edit">
            <Pencil size={14} aria-hidden="true" />
            {t('safes.editItem')}
          </Button>
          <Button variant="quiet" className="py-2" onClick={onFavorite} data-testid="item-favorite" aria-pressed={item.favorite}>
            <Star size={14} aria-hidden="true" className={item.favorite ? 'fill-brass text-brass' : ''} />
            {item.favorite ? t('safes.unfavorite') : t('safes.favorite')}
          </Button>
          <Button variant="danger" className="py-2" onClick={onTrash} data-testid="item-trash">
            <Trash2 size={14} aria-hidden="true" />
            {t('safes.moveToTrash')}
          </Button>
        </div>
      ) : null}
      {dialog}
    </section>
  )
}
