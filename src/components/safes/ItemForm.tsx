import { ShieldAlert } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { useI18n } from '../../context/I18nContext'
import { useVault } from '../../context/VaultContext'
import { checkCardNumber, detectBrand, digitsOnly, formatPan } from '../../domain/cards'
import {
  BILLING_CYCLES,
  CARD_BRANDS,
  SAFE_LIMITS,
  SUBSCRIPTION_STATUSES,
  type BillingCycle,
  type CardBrand,
  type CardItem,
  type ItemKind,
  type SecureItem,
  type SecureItemInput,
  type SubscriptionStatus,
} from '../../domain/safes'
import { CURRENCIES, isCurrency, type CurrencyCode } from '../../domain/types'
import { minorToDecimal, parseAmount } from '../../lib/money'
import { Button, Field, controlClass } from '../ui'
import { ErrorNotice, secureInputProps, todayIso } from './shared'

type CardDraft = { cardholder: string; number: string; brand: CardBrand; brandTouched: boolean; expMonth: string; expYear: string; cvv: string; showCvv: boolean; bank: string; notes: string }
type SubDraft = {
  url: string
  amount: string
  currency: CurrencyCode
  cycle: BillingCycle
  customDays: string
  anchorDate: string
  status: SubscriptionStatus
  trialEndsOn: string
  remindDaysBefore: string
  cardItemId: string
  account: string
  notes: string
}

function initialCard(item?: SecureItem): CardDraft {
  if (item?.kind === 'CARD') {
    return {
      cardholder: item.cardholder,
      number: formatPan(item.number, item.brand),
      brand: item.brand,
      brandTouched: true,
      expMonth: String(item.expMonth),
      expYear: String(item.expYear),
      cvv: item.cvv ?? '',
      showCvv: item.cvv !== null,
      bank: item.bank,
      notes: item.notes,
    }
  }
  return { cardholder: '', number: '', brand: 'OTHER', brandTouched: false, expMonth: '', expYear: '', cvv: '', showCvv: false, bank: '', notes: '' }
}

function initialSub(item: SecureItem | undefined, currency: string): SubDraft {
  if (item?.kind === 'SUBSCRIPTION') {
    return {
      url: item.url,
      amount: minorToDecimal(item.amountMinor, item.currency),
      currency: item.currency,
      cycle: item.cycle,
      customDays: item.customDays == null ? '' : String(item.customDays),
      anchorDate: item.anchorDate,
      status: item.status,
      trialEndsOn: item.trialEndsOn ?? '',
      remindDaysBefore: String(item.remindDaysBefore),
      cardItemId: item.cardItemId ?? '',
      account: item.account,
      notes: item.notes,
    }
  }
  return {
    url: '',
    amount: '',
    currency: isCurrency(currency) ? currency : 'USD',
    cycle: 'MONTHLY',
    customDays: '30',
    anchorDate: todayIso(),
    status: 'ACTIVE',
    trialEndsOn: '',
    remindDaysBefore: '3',
    cardItemId: '',
    account: '',
    notes: '',
  }
}

function Row({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2">{children}</div>
}

export function ItemForm({
  kind,
  item,
  cards,
  onSubmit,
  onCancel,
}: {
  kind: ItemKind
  item?: SecureItem
  cards: CardItem[]
  onSubmit: (input: SecureItemInput) => Promise<void>
  onCancel: () => void
}) {
  const { t } = useI18n()
  const { currency } = useVault()
  const [title, setTitle] = useState(item?.title ?? '')
  const [card, setCard] = useState<CardDraft>(() => initialCard(item))
  const [sub, setSub] = useState<SubDraft>(() => initialSub(item, currency))
  const [body, setBody] = useState(item?.kind === 'NOTE' ? item.body : '')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const thisYear = new Date().getFullYear()
  const years = Array.from({ length: 21 }, (_, index) => thisYear - 5 + index)
  const digits = digitsOnly(card.number)
  const numberCheck = checkCardNumber(digits, card.brand)

  const build = (): SecureItemInput => {
    if (kind === 'CARD') {
      return {
        kind,
        title,
        cardholder: card.cardholder,
        number: digits,
        brand: card.brand,
        expMonth: Number(card.expMonth),
        expYear: Number(card.expYear),
        cvv: card.showCvv && card.cvv.trim() ? card.cvv.trim() : null,
        bank: card.bank,
        notes: card.notes,
      }
    }
    if (kind === 'SUBSCRIPTION') {
      return {
        kind,
        title,
        url: sub.url.trim(),
        amountMinor: parseAmount(sub.amount, sub.currency),
        currency: sub.currency,
        cycle: sub.cycle,
        customDays: sub.cycle === 'CUSTOM' ? Number(sub.customDays) : null,
        anchorDate: sub.anchorDate,
        status: sub.status,
        trialEndsOn: sub.trialEndsOn || null,
        remindDaysBefore: Number(sub.remindDaysBefore),
        cardItemId: sub.cardItemId || null,
        account: sub.account,
        notes: sub.notes,
      }
    }
    return { kind: 'NOTE', title, body }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await onSubmit(build())
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  const input = (value: string, onChange: (value: string) => void, props: Record<string, unknown> = {}) => (
    <input {...secureInputProps} className={controlClass} value={value} onChange={(event) => onChange(event.target.value)} {...props} />
  )

  return (
    <form className="space-y-4" onSubmit={(event) => void submit(event)} data-testid="item-form" data-kind={kind}>
      <Field label={t('safes.itemTitle')}>{input(title, setTitle, { required: true, maxLength: SAFE_LIMITS.title, 'data-testid': 'item-title' })}</Field>

      {kind === 'CARD' ? (
        <>
          <Field label={t('safes.card.number')}>
            {input(
              card.number,
              (value) => {
                const nextDigits = digitsOnly(value)
                setCard({ ...card, number: value, brand: card.brandTouched ? card.brand : detectBrand(nextDigits) })
              },
              { required: true, inputMode: 'numeric', maxLength: 23, className: `${controlClass} font-mono tracking-wider`, 'data-testid': 'card-number' },
            )}
          </Field>
          {digits.length >= 12 && numberCheck.valid && numberCheck.luhnWarning ? (
            <p className="text-xs text-brass" data-testid="card-luhn-warning">
              {t('safes.card.luhnWarn')}
            </p>
          ) : null}
          <Row>
            <Field label={t('safes.card.brand')}>
              <select
                className={controlClass}
                value={card.brand}
                data-testid="card-brand"
                onChange={(event) => setCard({ ...card, brand: event.target.value as CardBrand, brandTouched: true })}
              >
                {CARD_BRANDS.map((brand) => (
                  <option key={brand} value={brand}>
                    {t(`safes.card.brands.${brand}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('safes.card.cardholder')}>
              {input(card.cardholder, (cardholder) => setCard({ ...card, cardholder }), { maxLength: SAFE_LIMITS.cardholder, 'data-testid': 'card-holder' })}
            </Field>
          </Row>
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium">{t('safes.card.expiry')}</legend>
            <div className="grid grid-cols-2 gap-4">
              <label className="block">
                <span className="sr-only">{t('safes.card.expMonth')}</span>
                <select required className={controlClass} value={card.expMonth} data-testid="card-exp-month" onChange={(event) => setCard({ ...card, expMonth: event.target.value })}>
                  <option value="">{t('safes.card.expMonth')}</option>
                  {Array.from({ length: 12 }, (_, index) => index + 1).map((month) => (
                    <option key={month} value={month}>
                      {String(month).padStart(2, '0')}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="sr-only">{t('safes.card.expYear')}</span>
                <select required className={controlClass} value={card.expYear} data-testid="card-exp-year" onChange={(event) => setCard({ ...card, expYear: event.target.value })}>
                  <option value="">{t('safes.card.expYear')}</option>
                  {years.map((year) => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </fieldset>
          <Field label={t('safes.card.bank')}>{input(card.bank, (bank) => setCard({ ...card, bank }), { maxLength: SAFE_LIMITS.bank, 'data-testid': 'card-bank' })}</Field>
          {card.showCvv ? (
            <div className="space-y-2 rounded-2xl border border-brass/50 p-3">
              <Field label={t('safes.card.cvv')}>
                {input(card.cvv, (cvv) => setCard({ ...card, cvv }), {
                  type: 'password',
                  inputMode: 'numeric',
                  maxLength: 4,
                  className: `${controlClass} max-w-32 font-mono`,
                  'data-testid': 'card-cvv',
                })}
              </Field>
              <p className="text-xs text-muted">{t('safes.card.cvvWarn')}</p>
            </div>
          ) : (
            <button type="button" className="text-sm text-pine-ink hover:underline" data-testid="card-add-cvv" onClick={() => setCard({ ...card, showCvv: true })}>
              {t('safes.card.addCvv')}
            </button>
          )}
          <p className="flex items-start gap-2 text-xs text-muted">
            <ShieldAlert size={14} className="mt-px shrink-0" aria-hidden="true" />
            <span className="min-w-0">{t('safes.card.pinNotStored')}</span>
          </p>
          <Field label={t('common.notes')}>
            <textarea {...secureInputProps} rows={2} maxLength={SAFE_LIMITS.notes} className={controlClass} value={card.notes} onChange={(event) => setCard({ ...card, notes: event.target.value })} />
          </Field>
        </>
      ) : null}

      {kind === 'SUBSCRIPTION' ? (
        <>
          <Row>
            <Field label={t('safes.sub.amount')}>
              {input(sub.amount, (amount) => setSub({ ...sub, amount }), { required: true, inputMode: 'decimal', 'data-testid': 'sub-amount' })}
            </Field>
            <Field label={t('common.currency')}>
              <select className={controlClass} value={sub.currency} data-testid="sub-currency" onChange={(event) => setSub({ ...sub, currency: event.target.value as CurrencyCode })}>
                {CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </Field>
          </Row>
          <Row>
            <Field label={t('safes.sub.cycle')}>
              <select className={controlClass} value={sub.cycle} data-testid="sub-cycle" onChange={(event) => setSub({ ...sub, cycle: event.target.value as BillingCycle })}>
                {BILLING_CYCLES.map((cycle) => (
                  <option key={cycle} value={cycle}>
                    {t(`safes.sub.cycles.${cycle}`)}
                  </option>
                ))}
              </select>
            </Field>
            {sub.cycle === 'CUSTOM' ? (
              <Field label={t('safes.sub.customDays')}>
                {input(sub.customDays, (customDays) => setSub({ ...sub, customDays }), { required: true, type: 'number', min: 1, max: SAFE_LIMITS.customDays, 'data-testid': 'sub-custom-days' })}
              </Field>
            ) : (
              <Field label={t('safes.sub.status')}>
                <StatusSelect value={sub.status} onChange={(status) => setSub({ ...sub, status })} />
              </Field>
            )}
          </Row>
          <Row>
            <Field label={t('safes.sub.anchor')}>
              {input(sub.anchorDate, (anchorDate) => setSub({ ...sub, anchorDate }), { required: true, type: 'date', 'data-testid': 'sub-anchor' })}
            </Field>
            {sub.cycle === 'CUSTOM' ? (
              <Field label={t('safes.sub.status')}>
                <StatusSelect value={sub.status} onChange={(status) => setSub({ ...sub, status })} />
              </Field>
            ) : (
              <Field label={t('safes.sub.remind')}>
                {input(sub.remindDaysBefore, (remindDaysBefore) => setSub({ ...sub, remindDaysBefore }), { type: 'number', min: 0, max: SAFE_LIMITS.remindDays, 'data-testid': 'sub-remind' })}
              </Field>
            )}
          </Row>
          <Row>
            <Field label={t('safes.sub.card')}>
              <select className={controlClass} value={sub.cardItemId} data-testid="sub-card" onChange={(event) => setSub({ ...sub, cardItemId: event.target.value })}>
                <option value="">{t('safes.sub.noCard')}</option>
                {sub.cardItemId && !cards.some((entry) => entry.id === sub.cardItemId) ? <option value={sub.cardItemId}>{t('safes.sub.lockedCard')}</option> : null}
                {cards.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.title}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('safes.sub.trialEnds')}>{input(sub.trialEndsOn, (trialEndsOn) => setSub({ ...sub, trialEndsOn }), { type: 'date', 'data-testid': 'sub-trial' })}</Field>
          </Row>
          {sub.cycle === 'CUSTOM' ? (
            <Field label={t('safes.sub.remind')}>
              {input(sub.remindDaysBefore, (remindDaysBefore) => setSub({ ...sub, remindDaysBefore }), { type: 'number', min: 0, max: SAFE_LIMITS.remindDays, 'data-testid': 'sub-remind' })}
            </Field>
          ) : null}
          <Field label={t('safes.sub.url')}>{input(sub.url, (url) => setSub({ ...sub, url }), { type: 'url', maxLength: SAFE_LIMITS.url, placeholder: 'https://', 'data-testid': 'sub-url' })}</Field>
          <Field label={t('safes.sub.account')}>{input(sub.account, (account) => setSub({ ...sub, account }), { maxLength: SAFE_LIMITS.account, 'data-testid': 'sub-account' })}</Field>
          <Field label={t('common.notes')}>
            <textarea {...secureInputProps} rows={2} maxLength={SAFE_LIMITS.notes} className={controlClass} value={sub.notes} onChange={(event) => setSub({ ...sub, notes: event.target.value })} />
          </Field>
        </>
      ) : null}

      {kind === 'NOTE' ? (
        <Field label={t('safes.note.body')}>
          <textarea
            {...secureInputProps}
            rows={8}
            maxLength={SAFE_LIMITS.noteBody}
            data-testid="note-body"
            className={controlClass}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        </Field>
      ) : null}

      <ErrorNotice error={error} />
      <div className="flex justify-end gap-2">
        <Button variant="quiet" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={busy} data-testid="item-submit">
          {t('common.save')}
        </Button>
      </div>
    </form>
  )
}

function StatusSelect({ value, onChange }: { value: SubscriptionStatus; onChange: (value: SubscriptionStatus) => void }) {
  const { t } = useI18n()
  return (
    <select className={controlClass} value={value} data-testid="sub-status" onChange={(event) => onChange(event.target.value as SubscriptionStatus)}>
      {SUBSCRIPTION_STATUSES.map((status) => (
        <option key={status} value={status}>
          {t(`safes.sub.statuses.${status}`)}
        </option>
      ))}
    </select>
  )
}
