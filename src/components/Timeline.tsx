import { useMemo, useState, type FormEvent } from 'react'
import { PeriodPicker } from './PeriodPicker'
import { Button, Field, Notice, controlClass } from './ui'
import { useI18n } from '../context/I18nContext'
import { usePeriod } from '../context/PeriodContext'
import { useVault } from '../context/VaultContext'
import type { EntryType, LedgerEntry, TransactionInput } from '../domain/types'
import { CURRENCIES } from '../domain/types'
import { textForError } from '../lib/errors'
import { toIsoDate } from '../lib/dates'
import { formatIsoDate, formatMoney } from '../lib/money'
import { Permission, canUser } from '../rbac'
import {
  MAX_RECEIPT_BYTES,
  categoryLabel,
  createTransaction,
  deleteTransaction,
  listCategories,
  listTransactions,
  updateTransaction,
} from '../services/finance.service'
import { listGroups } from '../services/group.service'

export function Timeline() {
  const { t, locale } = useI18n()
  const { user, query, run, currency, revision } = useVault()
  const { range } = usePeriod()
  const [typeFilter, setTypeFilter] = useState<EntryType | 'ALL'>('ALL')
  const [composer, setComposer] = useState<'new' | LedgerEntry | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const entries = useMemo(
    () => query((vault) => listTransactions(vault, range, typeFilter)),
    [query, range, typeFilter, revision],
  )
  const categories = useMemo(() => query((vault) => listCategories(vault)), [query, revision])
  const groups = useMemo(() => query((vault) => listGroups(vault)), [query, revision])
  if (!user) return null
  const canCreate = canUser(user, Permission.CREATE_TRANSACTION)
  const canEdit = canUser(user, Permission.UPDATE_TRANSACTION)
  const canDelete = canUser(user, Permission.DELETE_TRANSACTION)

  async function save(input: TransactionInput) {
    await run(async (vault) => {
      if (composer && composer !== 'new') await updateTransaction(vault, composer.id, input)
      else await createTransaction(vault, input)
    }, { dirty: true })
    setComposer(null)
  }

  async function remove(id: string) {
    setError(null)
    try {
      await run((vault) => deleteTransaction(vault, id), { dirty: true })
      setPendingDelete(null)
    } catch (caught) {
      setError(textForError(caught, t))
    }
  }

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl">{t('timeline.title')}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canCreate ? (
            <Button data-testid="add-transaction" onClick={() => setComposer('new')}>
              {t('tx.add')}
            </Button>
          ) : null}
          <select
            data-testid="type-filter"
            className="rounded-xl border border-line bg-card px-3 py-2 text-sm"
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value as EntryType | 'ALL')}
          >
            <option value="ALL">{t('common.all')}</option>
            <option value="INCOME">{t('tx.income')}</option>
            <option value="EXPENSE">{t('tx.expense')}</option>
          </select>
        </div>
      </div>
      <PeriodPicker />
      {error ? <Notice>{error}</Notice> : null}
      {composer ? (
        <TransactionForm
          key={composer === 'new' ? 'new' : composer.id}
          categories={categories}
          groups={groups}
          currency={currency}
          initial={composer === 'new' ? null : composer}
          onCancel={() => setComposer(null)}
          onSubmit={save}
        />
      ) : null}
      {entries.length === 0 ? (
        <p className="text-muted">{t('tx.empty')}</p>
      ) : (
        <ul className="grid gap-3">
          {entries.map((entry) => (
            <li key={entry.id} data-testid="tx-row" data-amount={String(entry.amount)} className="rounded-3xl border border-line bg-card px-4 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.14em] text-muted">{t(entry.type === 'INCOME' ? 'tx.income' : 'tx.expense')}</p>
                  <p className="mt-1 font-display text-2xl">{categoryLabel(entry, locale)}</p>
                  <p className="text-sm text-muted">
                    {formatIsoDate(entry.date, locale)} · {entry.groupName}
                  </p>
                  {entry.notes ? <p className="mt-2 max-w-xl text-sm">{entry.notes}</p> : null}
                  {entry.currency !== currency ? <p className="mt-2 text-xs text-brass">{t('tx.otherCurrency')}</p> : null}
                </div>
                <div className="text-right">
                  <p className={`font-display text-3xl tabular-nums ${entry.type === 'INCOME' ? 'text-pine' : 'text-clay'}`}>
                    {formatMoney(entry.amount, entry.currency, locale)}
                  </p>
                  <div className="mt-3 flex justify-end gap-2">
                    {canEdit ? (
                      <Button variant="quiet" onClick={() => setComposer(entry)}>
                        {t('common.edit')}
                      </Button>
                    ) : null}
                    {canDelete ? (
                      <Button variant="danger" data-testid={`delete-${entry.id}`} onClick={() => setPendingDelete(entry.id)}>
                        {t('common.delete')}
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
              {pendingDelete === entry.id ? (
                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
                  <p className="text-sm">{t('tx.deleteConfirm')}</p>
                  <Button variant="danger" data-testid="confirm-delete" onClick={() => void remove(entry.id)}>
                    {t('common.delete')}
                  </Button>
                  <Button variant="quiet" onClick={() => setPendingDelete(null)}>
                    {t('common.cancel')}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function TransactionForm({
  categories,
  groups,
  currency,
  initial,
  onSubmit,
  onCancel,
}: {
  categories: ReturnType<typeof listCategories>
  groups: ReturnType<typeof listGroups>
  currency: string
  initial: LedgerEntry | null
  onSubmit: (input: TransactionInput) => Promise<void>
  onCancel: () => void
}) {
  const { t, locale } = useI18n()
  const [type, setType] = useState<EntryType>(initial?.type ?? 'EXPENSE')
  const [amount, setAmount] = useState(initial ? String(initial.amount) : '')
  const [categoryId, setCategoryId] = useState(initial ? String(initial.categoryId) : '')
  const [groupId, setGroupId] = useState(initial ? String(initial.groupId) : String(groups[0]?.id ?? ''))
  const [date, setDate] = useState(initial?.date ?? toIsoDate(new Date()))
  const [notes, setNotes] = useState(initial?.notes ?? '')
  const [entryCurrency, setEntryCurrency] = useState(initial?.currency ?? currency)
  const [receipt, setReceipt] = useState<string | null>(initial?.receiptData ?? null)
  const [preview, setPreview] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const matching = categories.filter((category) => category.type === type)
  const selectedCategory = matching.some((category) => String(category.id) === categoryId)
    ? categoryId
    : String(matching[0]?.id ?? '')

  async function onFile(file: File | undefined) {
    if (!file) return
    if (file.size > MAX_RECEIPT_BYTES) {
      setError(t('tx.receiptTooLarge'))
      return
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
    setReceipt(dataUrl)
    setError(null)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      await onSubmit({
        type,
        amount: Number(amount),
        currency: entryCurrency,
        categoryId: Number(selectedCategory),
        groupId: Number(groupId),
        date,
        notes,
        receiptData: receipt,
      })
    } catch (caught) {
      setError(textForError(caught, t))
    } finally {
      setPending(false)
    }
  }

  return (
    <form className="grid gap-4 rounded-3xl border border-line bg-card p-5" onSubmit={(event) => void submit(event)}>
      <h2 className="font-display text-2xl">{initial ? t('tx.edit') : t('tx.add')}</h2>
      {error ? <Notice>{error}</Notice> : null}
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={t('common.type')}>
          <select data-testid="tx-type" className={controlClass} value={type} onChange={(event) => setType(event.target.value as EntryType)}>
            <option value="EXPENSE">{t('tx.expense')}</option>
            <option value="INCOME">{t('tx.income')}</option>
          </select>
        </Field>
        <Field label={t('common.amount')}>
          <input data-testid="tx-amount" className={controlClass} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} required />
        </Field>
        <Field label={t('common.category')}>
          <select data-testid="tx-category" className={controlClass} value={selectedCategory} onChange={(event) => setCategoryId(event.target.value)}>
            {matching.map((category) => (
              <option key={category.id} value={category.id}>
                {categoryLabel(category, locale)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('common.date')}>
          <input data-testid="tx-date" type="date" className={controlClass} value={date} onChange={(event) => setDate(event.target.value)} required />
        </Field>
        <Field label={t('common.currency')}>
          <select data-testid="tx-currency" className={controlClass} value={entryCurrency} onChange={(event) => setEntryCurrency(event.target.value)}>
            {CURRENCIES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </Field>
        {groups.length > 1 ? (
          <Field label={t('common.group')}>
            <select data-testid="tx-group" className={controlClass} value={groupId} onChange={(event) => setGroupId(event.target.value)}>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field label={t('common.notes')}>
          <textarea data-testid="tx-notes" className={controlClass} rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </Field>
        <Field label={t('tx.receipt')}>
          <input data-testid="tx-receipt" type="file" accept="image/*" className="block w-full text-sm" onChange={(event) => void onFile(event.target.files?.[0])} />
          {receipt ? (
            <span className="mt-2 flex gap-2">
              <Button variant="quiet" onClick={() => setPreview(true)}>
                {t('tx.viewReceipt')}
              </Button>
              <Button variant="ghost" onClick={() => setReceipt(null)}>
                {t('tx.removeReceipt')}
              </Button>
            </span>
          ) : null}
        </Field>
      </div>
      <div className="flex gap-2">
        <Button type="submit" data-testid="tx-save" disabled={pending}>
          {initial ? t('tx.update') : t('common.save')}
        </Button>
        <Button variant="quiet" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
      {preview && receipt ? (
        <div className="fixed inset-0 z-20 grid place-items-center bg-[#1d1a15]/60 p-6" onClick={() => setPreview(false)}>
          <img src={receipt} alt="" className="max-h-[80vh] max-w-full rounded-2xl" />
        </div>
      ) : null}
    </form>
  )
}
