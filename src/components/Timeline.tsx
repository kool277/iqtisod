import { Paperclip } from 'lucide-react'
import { useCallback, useMemo, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { PeriodPicker } from './PeriodPicker'
import { DataTable, type Column } from './table/DataTable'
import type { FilterState } from './table/model'
import { Button, Field, Notice, controlClass } from './ui'
import { useI18n } from '../context/I18nContext'
import { usePeriod } from '../context/PeriodContext'
import { useVault } from '../context/VaultContext'
import type { EntryType, LedgerEntry, TransactionInput } from '../domain/types'
import { CURRENCIES } from '../domain/types'
import { textForError } from '../lib/errors'
import { toIsoDate } from '../lib/dates'
import { LIMITS } from '../lib/limits'
import { LEDGER_GROUP_PARAM, linkedGroup } from '../lib/ledger-link'
import { formatIsoDate, formatMoney, formatWhen, minorToDecimal } from '../lib/money'
import { RECEIPT_ACCEPT, RECEIPT_TYPES } from '../lib/receipt'
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

function inputOf(entry: LedgerEntry): TransactionInput {
  return {
    type: entry.type,
    amount: minorToDecimal(entry.amountMinor, entry.currency),
    currency: entry.currency,
    categoryId: entry.categoryId,
    groupId: entry.groupId,
    date: entry.date,
    notes: entry.notes ?? '',
    receiptData: entry.receiptData,
  }
}

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
  const [params] = useSearchParams()
  const linked = linkedGroup(params.get(LEDGER_GROUP_PARAM), groups)
  const initialFilters = useMemo<FilterState | undefined>(
    () => (linked == null ? undefined : { group: { kind: 'select', values: [String(linked)] } }),
    [linked],
  )
  const canCreate = Boolean(user && canUser(user, Permission.CREATE_TRANSACTION))
  const canEdit = Boolean(user && canUser(user, Permission.UPDATE_TRANSACTION))
  const canDelete = Boolean(user && canUser(user, Permission.DELETE_TRANSACTION))

  const patch = useCallback(
    (entry: LedgerEntry, change: Partial<TransactionInput>) =>
      run((vault) => updateTransaction(vault, entry.id, { ...inputOf(entry), ...change }), { dirty: true }),
    [run],
  )

  const columns = useMemo<Column<LedgerEntry>[]>(() => {
    const typeText = (type: EntryType) => t(type === 'INCOME' ? 'tx.income' : 'tx.expense')
    const categoryName = (entry: LedgerEntry) => categoryLabel(entry, locale)
    const money = (entry: LedgerEntry) => formatMoney(entry.amountMinor, entry.currency, locale)
    const edit = <K extends keyof TransactionInput>(field: K, input: 'text' | 'decimal' | 'date' | 'select', value: (entry: LedgerEntry) => string, parse: (text: string) => TransactionInput[K]) =>
      canEdit ? { input, value, save: (entry: LedgerEntry, text: string) => patch(entry, { [field]: parse(text) } as Partial<TransactionInput>) } : undefined
    return [
      {
        id: 'date',
        header: t('common.date'),
        hideable: false,
        cell: (entry) => <span className="whitespace-nowrap">{formatIsoDate(entry.date, locale)}</span>,
        sort: { type: 'date', value: (entry) => entry.date },
        search: (entry) => `${entry.date} ${formatIsoDate(entry.date, locale)}`,
        filter: { kind: 'date', value: (entry) => entry.date },
        exportAs: { kind: 'date', value: (entry) => entry.date },
        edit: edit('date', 'date', (entry) => entry.date, (text) => text),
      },
      {
        id: 'type',
        header: t('common.type'),
        cell: (entry) => (
          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${entry.type === 'INCOME' ? 'bg-pine/10 text-pine-ink' : 'bg-clay/10 text-clay-ink'}`}>
            {typeText(entry.type)}
          </span>
        ),
        sort: { type: 'text', value: (entry) => typeText(entry.type) },
        search: (entry) => typeText(entry.type),
        filter: { kind: 'select', value: (entry) => entry.type, options: [{ value: 'INCOME', label: t('tx.income') }, { value: 'EXPENSE', label: t('tx.expense') }] },
        exportAs: { kind: 'text', value: (entry) => typeText(entry.type) },
      },
      {
        id: 'category',
        header: t('common.category'),
        cell: (entry) => <span className="break-words font-medium">{categoryName(entry)}</span>,
        sort: { type: 'text', value: categoryName },
        search: categoryName,
        filter: {
          kind: 'select',
          value: (entry) => String(entry.categoryId),
          options: categories.map((category) => ({ value: String(category.id), label: categoryLabel(category, locale) })),
        },
        exportAs: { kind: 'text', value: categoryName },
        edit: canEdit
          ? {
              input: 'select',
              value: (entry) => String(entry.categoryId),
              options: (entry) =>
                categories.filter((category) => category.type === entry.type).map((category) => ({ value: String(category.id), label: categoryLabel(category, locale) })),
              save: (entry, text) => patch(entry, { categoryId: Number(text) }),
            }
          : undefined,
      },
      {
        id: 'group',
        header: t('common.group'),
        hidden: groups.length <= 1,
        cell: (entry) => <span className="break-words">{entry.groupName}</span>,
        sort: { type: 'text', value: (entry) => entry.groupName },
        search: (entry) => entry.groupName,
        filter: { kind: 'select', value: (entry) => String(entry.groupId), options: groups.map((group) => ({ value: String(group.id), label: group.name })) },
        exportAs: { kind: 'text', value: (entry) => entry.groupName },
        edit:
          canEdit && groups.length > 1
            ? {
                input: 'select',
                value: (entry) => String(entry.groupId),
                options: () => groups.map((group) => ({ value: String(group.id), label: group.name })),
                save: (entry, text) => patch(entry, { groupId: Number(text) }),
              }
            : undefined,
      },
      {
        id: 'amount',
        header: t('common.amount'),
        hideable: false,
        align: 'end',
        cell: (entry) => (
          <span className="grid justify-items-end @max-3xl:justify-items-start">
            <span className={`whitespace-nowrap font-medium ${entry.type === 'INCOME' ? 'text-pine-ink' : 'text-clay-ink'}`}>{money(entry)}</span>
            {entry.currency !== currency ? <span className="text-[11px] font-normal text-brass">{t('tx.otherCurrency')}</span> : null}
          </span>
        ),
        sort: { type: 'money', value: (entry) => ({ minor: entry.amountMinor, currency: entry.currency }) },
        search: (entry) => `${money(entry)} ${minorToDecimal(entry.amountMinor, entry.currency)}`,
        filter: { kind: 'money', value: (entry) => ({ minor: entry.amountMinor, currency: entry.currency }) },
        exportAs: { kind: 'money', value: (entry) => ({ money: entry.amountMinor, currency: entry.currency }) },
        edit: edit('amount', 'decimal', (entry) => minorToDecimal(entry.amountMinor, entry.currency), (text) => text),
      },
      {
        id: 'currency',
        header: t('common.currency'),
        hidden: true,
        cell: (entry) => entry.currency,
        sort: { type: 'text', value: (entry) => entry.currency },
        search: (entry) => entry.currency,
        filter: { kind: 'select', value: (entry) => entry.currency, options: CURRENCIES.map((code) => ({ value: code, label: code })) },
        exportAs: { kind: 'text', value: (entry) => entry.currency },
      },
      {
        id: 'notes',
        header: t('common.notes'),
        className: 'max-w-80',
        cell: (entry) => (entry.notes ? <span className="line-clamp-3 whitespace-pre-line break-words text-muted" title={entry.notes}>{entry.notes}</span> : <span className="text-muted">—</span>),
        sort: { type: 'text', value: (entry) => entry.notes },
        search: (entry) => entry.notes,
        filter: { kind: 'text', value: (entry) => entry.notes },
        exportAs: { kind: 'text', value: (entry) => entry.notes },
        edit: canEdit
          ? { input: 'text', maxLength: LIMITS.notesChars, value: (entry) => entry.notes ?? '', save: (entry, text) => patch(entry, { notes: text }) }
          : undefined,
      },
      {
        id: 'recordedBy',
        header: t('table.col.recordedBy'),
        hidden: true,
        cell: (entry) => <span className="break-all">{entry.userEmail}</span>,
        sort: { type: 'text', value: (entry) => entry.userEmail },
        search: (entry) => entry.userEmail,
        filter: { kind: 'select', value: (entry) => entry.userEmail, options: [] },
        exportAs: { kind: 'text', value: (entry) => entry.userEmail },
      },
      {
        id: 'receipt',
        header: t('tx.receipt'),
        hidden: true,
        cell: (entry) =>
          entry.receiptData ? (
            <span className="inline-flex items-center gap-1 text-muted">
              <Paperclip size={13} aria-hidden="true" />
              {t('table.yes')}
            </span>
          ) : (
            <span className="text-muted">—</span>
          ),
        sort: { type: 'number', value: (entry) => (entry.receiptData ? 1 : 0) },
        filter: { kind: 'select', value: (entry) => (entry.receiptData ? 'yes' : 'no'), options: [{ value: 'yes', label: t('table.yes') }, { value: 'no', label: t('table.no') }] },
        exportAs: { kind: 'boolean', value: (entry) => entry.receiptData != null },
      },
      {
        id: 'created',
        header: t('table.col.created'),
        hidden: true,
        cell: (entry) => <span className="whitespace-nowrap text-muted">{formatWhen(entry.createdAt, locale)}</span>,
        sort: { type: 'date', value: (entry) => entry.createdAt },
        filter: { kind: 'date', value: (entry) => entry.createdAt },
        exportAs: { kind: 'when', value: (entry) => entry.createdAt },
      },
      {
        id: 'updated',
        header: t('table.col.updated'),
        hidden: true,
        cell: (entry) => <span className="whitespace-nowrap text-muted">{formatWhen(entry.updatedAt, locale)}</span>,
        sort: { type: 'date', value: (entry) => entry.updatedAt },
        filter: { kind: 'date', value: (entry) => entry.updatedAt },
        exportAs: { kind: 'when', value: (entry) => entry.updatedAt },
      },
    ]
  }, [t, locale, categories, groups, currency, canEdit, patch])

  const bulkDelete = useMemo(
    () =>
      canDelete
        ? {
            run: async (rows: LedgerEntry[]) => {
              const failures = await run(
                (vault) => {
                  const failed: unknown[] = []
                  for (const entry of rows) {
                    try {
                      deleteTransaction(vault, entry.id)
                    } catch (caught) {
                      failed.push(caught)
                    }
                  }
                  return failed
                },
                { dirty: true },
              )
              if (failures.length > 0) throw failures[0]
            },
          }
        : undefined,
    [canDelete, run],
  )

  if (!user) return null

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
        <div className="min-w-0">
          <h1 className="font-display text-4xl">{t('timeline.title')}</h1>
        </div>
        {canCreate ? (
          <Button data-testid="add-transaction" onClick={() => setComposer('new')}>
            {t('tx.add')}
          </Button>
        ) : null}
      </div>
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
      <DataTable
        key={linked ?? 'all'}
        id="transactions"
        initialFilters={initialFilters}
        label={t('timeline.title')}
        rows={entries}
        columns={columns}
        rowKey={(entry) => entry.id}
        rowAttributes={(entry) => ({ 'data-testid': 'tx-row', 'data-amount': minorToDecimal(entry.amountMinor, entry.currency) })}
        exportTable="transactions"
        exportScope={{ from: range.start, to: range.end, groupId: null }}
        empty={t('tx.empty')}
        bulkDelete={bulkDelete}
        toolbar={
          <>
            <PeriodPicker />
            <label className="text-sm">
              <span className="mb-1 block text-muted">{t('common.type')}</span>
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
            </label>
          </>
        }
        rowActions={
          canEdit || canDelete
            ? (entry) => (
                <>
                  {canEdit ? (
                    <Button variant="quiet" className="px-3 py-1.5" onClick={() => setComposer(entry)}>
                      {t('common.edit')}
                    </Button>
                  ) : null}
                  {canDelete ? (
                    <Button variant="danger" className="px-3 py-1.5" data-testid={`delete-${entry.id}`} onClick={() => setPendingDelete(entry.id)}>
                      {t('common.delete')}
                    </Button>
                  ) : null}
                </>
              )
            : undefined
        }
        expanded={(entry) =>
          pendingDelete === entry.id ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
              <p className="text-sm">{t('tx.deleteConfirm')}</p>
              <Button variant="danger" data-testid="confirm-delete" onClick={() => void remove(entry.id)}>
                {t('common.delete')}
              </Button>
              <Button variant="quiet" onClick={() => setPendingDelete(null)}>
                {t('common.cancel')}
              </Button>
            </div>
          ) : null
        }
        defaultSort={[]}
      />
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
  const [amount, setAmount] = useState(initial ? minorToDecimal(initial.amountMinor, initial.currency) : '')
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
    if (!(RECEIPT_TYPES as readonly string[]).includes(file.type)) {
      setError(t('securityErrors.RECEIPT_TYPE'))
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
        amount,
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
          <input data-testid="tx-receipt" type="file" accept={RECEIPT_ACCEPT} className="block w-full text-sm" onChange={(event) => void onFile(event.target.files?.[0])} />
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
