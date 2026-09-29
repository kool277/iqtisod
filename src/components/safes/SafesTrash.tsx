import { ChevronLeft, RotateCcw, Trash2 } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '../../context/I18nContext'
import { useSafes } from '../../context/SafeContext'
import { hasRecentAuth, listTrash, purgeItems, purgeSafe, restoreItems, restoreSafe, type SafeSummary, type TrashedItem } from '../../services/safe.service'
import { DataTable, type Column } from '../table/DataTable'
import { Button, Field, Panel, controlClass } from '../ui'
import { KIND_ICONS } from './ItemBits'
import { SafesGate } from './SafesGate'
import { SafesNav } from './SafesHome'
import { Dialog, ErrorNotice, PageHeader, ReauthDialog, SafeGlyph, secureInputProps, useSafeQuery } from './shared'

export function SafesTrash() {
  const { t } = useI18n()
  return (
    <div data-testid="safes-trash">
      <PageHeader title={t('safes.trash')} intro={t('safes.trashIntro')} actions={<SafesNav />} />
      <SafesGate>
        <TrashContents />
      </SafesGate>
    </div>
  )
}

function TrashContents() {
  const { t } = useI18n()
  const { withKeyring, keyring } = useSafes()
  const [error, setError] = useState<unknown>(null)
  const [reauth, setReauth] = useState<(() => void) | null>(null)
  const [purging, setPurging] = useState<(SafeSummary & { daysLeft: number }) | null>(null)
  const { data, error: loadError } = useSafeQuery((vault, current) => listTrash(vault, current), [])
  const act = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
    } catch (caught) {
      setError(caught)
    }
  }
  const guarded = (action: () => void) => (keyring && hasRecentAuth(keyring) ? action() : setReauth(() => action))
  const safes = useMemo(() => data?.safes ?? [], [data])
  const items = useMemo(() => data?.items ?? [], [data])
  const iconButton = 'inline-flex h-8 items-center gap-1 rounded-lg border px-2 text-xs'

  const safeColumns = useMemo<Column<TrashedSafe>[]>(() => {
    const name = (safe: TrashedSafe) => safe.meta?.name ?? t('safes.unreadable')
    const count = (safe: TrashedSafe) => safe.itemCount + safe.trashedItemCount
    return [
      {
        id: 'name',
        header: t('table.col.safe'),
        hideable: false,
        cell: (safe) => (
          <span className="flex min-w-0 items-center gap-2.5">
            {safe.meta ? <SafeGlyph icon={safe.meta.icon} color={safe.meta.color} size="sm" /> : null}
            <span className="min-w-0 break-words font-medium">{name(safe)}</span>
          </span>
        ),
        sort: { type: 'text', value: name },
        search: name,
      },
      {
        id: 'count',
        header: t('safes.items'),
        align: 'end',
        cell: (safe) => <span className="tabular-nums">{count(safe)}</span>,
        sort: { type: 'number', value: count },
        filter: { kind: 'number', value: count },
      },
      daysLeftColumn<TrashedSafe>(t('safes.daysLeft')),
    ]
  }, [t])

  const itemColumns = useMemo<Column<TrashedItem>[]>(() => {
    const kind = (item: TrashedItem) => t(`safes.kinds.${item.kind}`)
    return [
      {
        id: 'title',
        header: t('table.col.title'),
        hideable: false,
        cell: (item) => {
          const Icon = KIND_ICONS[item.kind]
          return (
            <span className="flex min-w-0 items-center gap-2.5">
              <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-paper text-muted" aria-hidden="true">
                <Icon size={14} />
              </span>
              <span className="min-w-0 break-words font-medium">{item.title}</span>
            </span>
          )
        },
        sort: { type: 'text', value: (item) => item.title },
        search: (item) => item.title,
      },
      {
        id: 'kind',
        header: t('table.col.kind'),
        cell: kind,
        sort: { type: 'text', value: kind },
        search: kind,
        filter: {
          kind: 'select',
          value: (item) => item.kind,
          options: (['CARD', 'SUBSCRIPTION', 'NOTE'] as const).map((value) => ({ value, label: t(`safes.kinds.${value}`) })),
        },
      },
      {
        id: 'safe',
        header: t('table.col.safe'),
        cell: (item) => item.safeName ?? '—',
        sort: { type: 'text', value: (item) => item.safeName },
        search: (item) => item.safeName,
        filter: { kind: 'text', value: (item) => item.safeName },
      },
      daysLeftColumn<TrashedItem>(t('safes.daysLeft')),
    ]
  }, [t])

  return (
    <div className="space-y-5">
      <Link to="/app/safes" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ChevronLeft size={16} aria-hidden="true" />
        {t('safes.back')}
      </Link>
      <ErrorNotice error={loadError ?? error} />
      {data && safes.length === 0 && items.length === 0 ? (
        <Panel className="text-center text-sm text-muted">{t('safes.emptyTrash')}</Panel>
      ) : null}
      {safes.length > 0 ? (
        <section className="space-y-2">
          <h2 className="font-display text-2xl">{t('safes.trashedSafes')}</h2>
          <DataTable
            id="safes-trash-safes"
            label={t('safes.trashedSafes')}
            rows={safes}
            columns={safeColumns}
            rowKey={(safe) => safe.id}
            rowAttributes={() => ({ 'data-testid': 'trash-safe' })}
            secure
            rowActions={(safe) => (
              <>
                <button
                  type="button"
                  className={`${iconButton} border-line hover:border-brass`}
                  data-testid="trash-safe-restore"
                  onClick={() => void act(() => withKeyring((vault, current) => restoreSafe(vault, current, safe.id), { dirty: true }))}
                >
                  <RotateCcw size={13} aria-hidden="true" />
                  {t('safes.restore')}
                </button>
                <button type="button" className={`${iconButton} border-clay text-clay-ink hover:bg-clay/10`} data-testid="trash-safe-purge" onClick={() => setPurging(safe)}>
                  <Trash2 size={13} aria-hidden="true" />
                  {t('safes.deleteForever')}
                </button>
              </>
            )}
          />
        </section>
      ) : null}
      {items.length > 0 ? (
        <section className="space-y-2">
          <h2 className="font-display text-2xl">{t('safes.trashedItems')}</h2>
          <DataTable
            id="safes-trash-items"
            label={t('safes.trashedItems')}
            rows={items}
            columns={itemColumns}
            rowKey={(item) => item.id}
            rowAttributes={() => ({ 'data-testid': 'trash-item' })}
            secure
            rowActions={(item) => (
              <>
                <button
                  type="button"
                  className={`${iconButton} border-line hover:border-brass`}
                  data-testid="trash-item-restore"
                  onClick={() => void act(() => withKeyring((vault, current) => restoreItems(vault, current, [item.id]), { dirty: true }))}
                >
                  <RotateCcw size={13} aria-hidden="true" />
                  {t('safes.restore')}
                </button>
                <button
                  type="button"
                  className={`${iconButton} border-clay text-clay-ink hover:bg-clay/10`}
                  data-testid="trash-item-purge"
                  onClick={() => guarded(() => void act(() => withKeyring((vault, current) => purgeItems(vault, current, [item.id]), { dirty: true })))}
                >
                  <Trash2 size={13} aria-hidden="true" />
                  {t('safes.deleteForever')}
                </button>
              </>
            )}
          />
        </section>
      ) : null}
      {purging ? <PurgeSafeDialog safe={purging} guarded={guarded} onClose={() => setPurging(null)} /> : null}
      {reauth ? (
        <ReauthDialog
          onCancel={() => setReauth(null)}
          onDone={() => {
            const action = reauth
            setReauth(null)
            action()
          }}
        />
      ) : null}
    </div>
  )
}

type TrashedSafe = SafeSummary & { daysLeft: number }

function daysLeftColumn<T extends { daysLeft: number }>(header: string): Column<T> {
  return {
    id: 'daysLeft',
    header,
    align: 'end',
    cell: (row) => <span className={`tabular-nums ${row.daysLeft <= 3 ? 'text-clay-ink' : ''}`}>{row.daysLeft}</span>,
    sort: { type: 'number', value: (row) => row.daysLeft },
    filter: { kind: 'number', value: (row) => row.daysLeft },
  }
}

function PurgeSafeDialog({ safe, guarded, onClose }: { safe: SafeSummary; guarded: (action: () => void) => void; onClose: () => void }) {
  const { t } = useI18n()
  const { withKeyring } = useSafes()
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<unknown>(null)
  const purge = async () => {
    setError(null)
    try {
      await withKeyring((vault, current) => purgeSafe(vault, current, safe.id, typed), { dirty: true })
      onClose()
    } catch (caught) {
      setError(caught)
    }
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    guarded(() => void purge())
  }
  return (
    <Dialog title={t('safes.deleteForever')} onClose={onClose} testId="purge-safe-dialog">
      <form className="space-y-4" onSubmit={submit}>
        <p className="text-sm text-clay-ink">{t('safes.deleteForeverConfirm')}</p>
        {safe.meta ? (
          <Field label={t('safes.typeNameToConfirm')}>
            <input {...secureInputProps} required className={controlClass} value={typed} onChange={(event) => setTyped(event.target.value)} data-testid="purge-safe-name" />
          </Field>
        ) : null}
        <ErrorNotice error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="quiet" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="danger" data-testid="purge-safe-confirm">
            {t('safes.deleteForever')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
