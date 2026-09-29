import { Archive, ChevronLeft, CreditCard, Lock, LockKeyhole, Repeat, Search, Settings2, StickyNote } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useI18n } from '../../context/I18nContext'
import { useSafes } from '../../context/SafeContext'
import type { CardItem, ItemKind, SecureItem } from '../../domain/safes'
import {
  closeSafe,
  copyItems,
  hasRecentAuth,
  createItem,
  listItems,
  listOpenItems,
  listSafes,
  moveItems,
  openSafe,
  rotateSafeKey,
  setDefaultSafe,
  setFavorite,
  trashItems,
  trashSafe,
  updateItem,
  updateSafe,
  type SafeSummary,
} from '../../services/safe.service'
import { Button, Field, Panel, controlClass } from '../ui'
import { ItemDetail } from './ItemDetail'
import { ItemForm } from './ItemForm'
import { ItemLine } from './ItemBits'
import { SafeForm } from './SafeForm'
import { SafesGate } from './SafesGate'
import { SafesNav } from './SafesHome'
import { Dialog, ErrorNotice, PageHeader, PasswordInput, ReauthDialog, SafeGlyph, Success, Warning, secureInputProps, todayIso, useSafeQuery } from './shared'

type Filter = 'ALL' | ItemKind | 'FAVORITES'

export function SafeView() {
  const { t } = useI18n()
  return (
    <div data-testid="safe-view">
      <PageHeader title={t('safes.title')} actions={<SafesNav />} />
      <SafesGate>
        <SafeContents />
      </SafesGate>
    </div>
  )
}

function OpenSafeForm({ safeId }: { safeId: string }) {
  const { t } = useI18n()
  const { withKeyring, refresh } = useSafes()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<unknown>(null)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    try {
      await withKeyring((vault, keyring) => openSafe(vault, keyring, safeId, password))
      setPassword('')
      refresh()
    } catch (caught) {
      setError(caught)
    }
  }
  return (
    <Panel className="max-w-md">
      <form className="space-y-4" onSubmit={(event) => void submit(event)} data-testid="safe-open-form">
        <p className="flex items-start gap-2 text-sm">
          <LockKeyhole size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
          <span className="min-w-0">{t('safes.closedSafe')}</span>
        </p>
        <PasswordInput label={t('login.password')} value={password} onChange={setPassword} testId="safe-open-password" autoFocus />
        <ErrorNotice error={error} />
        <Button type="submit" data-testid="safe-open-submit">
          {t('safes.openSafe')}
        </Button>
      </form>
    </Panel>
  )
}

function SafeContents() {
  const { t } = useI18n()
  const { safeId = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const selectedId = params.get('item')
  const navigate = useNavigate()
  const { withKeyring, keyring } = useSafes()
  const [filter, setFilter] = useState<Filter>('ALL')
  const [search, setSearch] = useState('')
  const [adding, setAdding] = useState<ItemKind | null>(null)
  const [editing, setEditing] = useState<SecureItem | null>(null)
  const [settings, setSettings] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [bulk, setBulk] = useState<'move' | 'copy' | null>(null)
  const [actionError, setActionError] = useState<unknown>(null)
  const [message, setMessage] = useState<string | null>(null)
  const today = todayIso()

  const { data, error } = useSafeQuery(
    async (vault, current) => {
      const safes = await listSafes(vault, current)
      const safe = safes.find((entry) => entry.id === safeId) ?? null
      const contents = safe?.open ? await listItems(vault, current, safeId) : { items: [], unreadable: [] }
      const cards = (await listOpenItems(vault, current)).items.filter((item): item is CardItem => item.kind === 'CARD')
      return { safes, safe, ...contents, cards }
    },
    [safeId],
  )

  const items = data?.items ?? []
  const needle = search.trim().toLocaleLowerCase()
  const shown = useMemo(
    () =>
      items.filter((item) => {
        if (filter === 'FAVORITES' && !item.favorite) return false
        if (filter !== 'ALL' && filter !== 'FAVORITES' && item.kind !== filter) return false
        return !needle || item.title.toLocaleLowerCase().includes(needle)
      }),
    [items, filter, needle],
  )

  if (error) return <ErrorNotice error={error} />
  if (!data) return <div role="status" aria-busy="true" className="min-h-40" />
  const safe = data.safe
  if (!safe || !safe.meta) {
    return (
      <Panel className="max-w-md space-y-3">
        <p className="text-sm">{t('safeErrors.SAFE_NOT_FOUND')}</p>
        <Link to="/app/safes" className="text-sm text-pine-ink hover:underline">
          {t('safes.back')}
        </Link>
      </Panel>
    )
  }
  const meta = safe.meta
  const readOnly = meta.archived
  const selected = items.find((item) => item.id === selectedId) ?? null
  const targets = data.safes.filter((entry) => entry.id !== safeId && entry.meta && !entry.meta.archived && entry.open)

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setActionError(null)
    setMessage(null)
    try {
      await fn()
      if (done) setMessage(done)
    } catch (caught) {
      setActionError(caught)
    }
  }
  const selectItem = (id: string | null) => {
    const next = new URLSearchParams(params)
    if (id) next.set('item', id)
    else next.delete('item')
    setParams(next, { replace: true })
    setEditing(null)
  }
  const togglePick = (id: string) => {
    const next = new Set(picked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setPicked(next)
  }

  const filters: { id: Filter; label: string }[] = [
    { id: 'ALL', label: t('common.all') },
    { id: 'CARD', label: t('safes.kinds.CARD') },
    { id: 'SUBSCRIPTION', label: t('safes.kinds.SUBSCRIPTION') },
    { id: 'NOTE', label: t('safes.kinds.NOTE') },
    { id: 'FAVORITES', label: t('safes.filterFavorites') },
  ]

  return (
    <div className="space-y-5">
      <Link to="/app/safes" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink" data-testid="safe-back">
        <ChevronLeft size={16} aria-hidden="true" />
        {t('safes.back')}
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <SafeGlyph icon={meta.icon} color={meta.color} size="lg" />
          <div className="min-w-0">
            <h2 className="break-words font-display text-3xl leading-tight" data-testid="safe-title">
              {meta.name}
            </h2>
            {meta.description ? <p className="break-words text-sm text-muted">{meta.description}</p> : null}
            <p className="mt-1 flex flex-wrap gap-1.5 text-xs text-muted">
              {safe.isDefault ? <span className="rounded-full bg-pine/10 px-2 py-0.5 text-pine-ink">{t('safes.isDefault')}</span> : null}
              {meta.requirePassword ? <span className="rounded-full bg-paper px-2 py-0.5">{t('safes.requirePasswordShort')}</span> : null}
              {meta.archived ? <span className="rounded-full bg-paper px-2 py-0.5">{t('safes.archived')}</span> : null}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {safe.open && !readOnly ? (
            <>
              <Button className="py-2" onClick={() => setAdding('CARD')} data-testid="add-card">
                <CreditCard size={15} aria-hidden="true" />
                {t('safes.addCard')}
              </Button>
              <Button variant="quiet" className="py-2" onClick={() => setAdding('SUBSCRIPTION')} data-testid="add-subscription">
                <Repeat size={15} aria-hidden="true" />
                {t('safes.addSubscription')}
              </Button>
              <Button variant="quiet" className="py-2" onClick={() => setAdding('NOTE')} data-testid="add-note">
                <StickyNote size={15} aria-hidden="true" />
                {t('safes.addNote')}
              </Button>
            </>
          ) : null}
          {safe.open ? (
            <Button variant="quiet" className="py-2" onClick={() => setSettings(true)} data-testid="safe-settings">
              <Settings2 size={15} aria-hidden="true" />
              {t('safes.settings')}
            </Button>
          ) : null}
          {meta.requirePassword && safe.open ? (
            <Button
              variant="quiet"
              className="py-2"
              data-testid="safe-close"
              onClick={() => {
                if (keyring) closeSafe(keyring, safeId)
                navigate('/app/safes')
              }}
            >
              <Lock size={15} aria-hidden="true" />
              {t('safes.closeSafe')}
            </Button>
          ) : null}
        </div>
      </div>

      {readOnly ? <Warning testId="safe-archived-notice">{t('safes.archivedNotice')}</Warning> : null}
      {message ? <Success>{message}</Success> : null}
      <ErrorNotice error={actionError} />

      {!safe.open ? (
        <OpenSafeForm safeId={safeId} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('common.type')}>
              {filters.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  aria-pressed={filter === entry.id}
                  data-testid={`filter-${entry.id.toLowerCase()}`}
                  className={`rounded-full border px-3 py-1.5 text-sm ${filter === entry.id ? 'border-pine-ink bg-pine text-on-pine' : 'border-line bg-card text-muted hover:text-ink'}`}
                  onClick={() => setFilter(entry.id)}
                >
                  {entry.label}
                </button>
              ))}
            </div>
            <label className="relative ml-auto min-w-0 basis-56">
              <span className="sr-only">{t('safes.searchSafe')}</span>
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
              <input
                {...secureInputProps}
                type="search"
                placeholder={t('safes.searchSafe')}
                className={`${controlClass} py-2 pl-9`}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            {!readOnly && items.length > 0 ? (
              <Button
                variant={selecting ? 'primary' : 'quiet'}
                className="py-2"
                aria-pressed={selecting}
                data-testid="select-mode"
                onClick={() => {
                  setSelecting(!selecting)
                  setPicked(new Set())
                }}
              >
                {t('safes.select')}
              </Button>
            ) : null}
          </div>

          {selecting && picked.size > 0 ? (
            <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-card px-3 py-2" data-testid="bulk-bar">
              <span className="mr-auto text-sm tabular-nums">
                {picked.size} {t('safes.selected')}
              </span>
              <Button variant="quiet" className="py-1.5" disabled={targets.length === 0} onClick={() => setBulk('move')} data-testid="bulk-move">
                {t('safes.move')}
              </Button>
              <Button variant="quiet" className="py-1.5" disabled={targets.length === 0} onClick={() => setBulk('copy')} data-testid="bulk-copy">
                {t('safes.copyTo')}
              </Button>
              <Button
                variant="danger"
                className="py-1.5"
                data-testid="bulk-trash"
                onClick={() =>
                  void act(async () => {
                    await withKeyring((vault, current) => trashItems(vault, current, [...picked]), { dirty: true })
                    setPicked(new Set())
                    selectItem(null)
                  })
                }
              >
                {t('safes.moveToTrash')}
              </Button>
            </div>
          ) : null}

          {data.unreadable.length > 0 ? <Warning>{t('safes.unreadable')}</Warning> : null}

          <div className={`grid gap-4 ${selected ? 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]' : ''}`}>
            <div className="min-w-0 space-y-2" data-testid="item-list">
              {items.length === 0 ? (
                <Panel className="text-center">
                  <p className="font-medium">{t('safes.empty')}</p>
                  {!readOnly ? <p className="text-sm text-muted">{t('safes.emptyHint')}</p> : null}
                </Panel>
              ) : shown.length === 0 ? (
                <p className="text-sm text-muted">{t('safes.noResults')}</p>
              ) : (
                shown.map((item) =>
                  selecting ? (
                    <label key={item.id} className="flex min-w-0 cursor-pointer items-center gap-3">
                      <input
                        type="checkbox"
                        className="size-4 shrink-0 accent-[var(--app-pine)]"
                        checked={picked.has(item.id)}
                        onChange={() => togglePick(item.id)}
                        data-testid="item-pick"
                      />
                      <span className="min-w-0 flex-1">
                        <ItemLine item={item} today={today} selected={picked.has(item.id)} onOpen={() => togglePick(item.id)} />
                      </span>
                    </label>
                  ) : (
                    <ItemLine key={item.id} item={item} today={today} selected={item.id === selectedId} onOpen={() => selectItem(item.id)} />
                  ),
                )
              )}
            </div>
            {selected ? (
              editing && editing.id === selected.id ? (
                <Panel className="min-w-0">
                  <h2 className="mb-4 font-display text-2xl">{t('safes.editItem')}</h2>
                  <ItemForm
                    kind={selected.kind}
                    item={selected}
                    cards={data.cards}
                    onCancel={() => setEditing(null)}
                    onSubmit={async (input) => {
                      await withKeyring((vault, current) => updateItem(vault, current, selected.id, selected.rev, input), { dirty: true })
                      setEditing(null)
                    }}
                  />
                </Panel>
              ) : (
                <ItemDetail
                  key={selected.id}
                  item={selected}
                  cards={data.cards}
                  readOnly={readOnly}
                  onClose={() => selectItem(null)}
                  onEdit={() => setEditing(selected)}
                  onFavorite={() => void act(() => withKeyring((vault, current) => setFavorite(vault, current, selected.id, selected.rev, !selected.favorite), { dirty: true }))}
                  onTrash={() =>
                    void act(async () => {
                      await withKeyring((vault, current) => trashItems(vault, current, [selected.id]), { dirty: true })
                      selectItem(null)
                    })
                  }
                />
              )
            ) : null}
          </div>
        </>
      )}

      {adding ? (
        <Dialog title={t(adding === 'CARD' ? 'safes.addCard' : adding === 'SUBSCRIPTION' ? 'safes.addSubscription' : 'safes.addNote')} onClose={() => setAdding(null)} testId="item-dialog" wide>
          <ItemForm
            kind={adding}
            cards={data.cards}
            onCancel={() => setAdding(null)}
            onSubmit={async (input) => {
              const id = await withKeyring((vault, current) => createItem(vault, current, safeId, input), { dirty: true })
              setAdding(null)
              selectItem(id)
            }}
          />
        </Dialog>
      ) : null}

      {bulk ? (
        <BulkDialog
          mode={bulk}
          targets={targets}
          onClose={() => setBulk(null)}
          onSubmit={async (target) => {
            const ids = [...picked]
            await withKeyring(
              async (vault, current) => {
                if (bulk === 'move') await moveItems(vault, current, ids, target)
                else await copyItems(vault, current, ids, target)
              },
              { dirty: true },
            )
            setBulk(null)
            setPicked(new Set())
            setSelecting(false)
            setMessage(bulk === 'move' ? t('safes.moved') : t('safes.copiedItems'))
          }}
        />
      ) : null}

      {settings ? <SafeSettings safe={safe} others={data.safes.filter((entry) => entry.id !== safeId)} onClose={() => setSettings(false)} /> : null}
    </div>
  )
}

function BulkDialog({
  mode,
  targets,
  onClose,
  onSubmit,
}: {
  mode: 'move' | 'copy'
  targets: SafeSummary[]
  onClose: () => void
  onSubmit: (target: string) => Promise<void>
}) {
  const { t } = useI18n()
  const [target, setTarget] = useState(targets[0]?.id ?? '')
  const [error, setError] = useState<unknown>(null)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    try {
      await onSubmit(target)
    } catch (caught) {
      setError(caught)
    }
  }
  return (
    <Dialog title={mode === 'move' ? t('safes.move') : t('safes.copyTo')} onClose={onClose} testId="bulk-dialog">
      <form className="space-y-4" onSubmit={(event) => void submit(event)}>
        <Field label={mode === 'move' ? t('safes.moveAllTo') : t('safes.copyTo')}>
          <select className={controlClass} value={target} onChange={(event) => setTarget(event.target.value)} data-testid="bulk-target">
            {targets.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.meta?.name}
              </option>
            ))}
          </select>
        </Field>
        <ErrorNotice error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="quiet" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={!target} data-testid="bulk-submit">
            {mode === 'move' ? t('safes.move') : t('safes.copyTo')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function SafeSettings({ safe, others, onClose }: { safe: SafeSummary; others: SafeSummary[]; onClose: () => void }) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const { withKeyring, keyring } = useSafes()
  const [error, setError] = useState<unknown>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [reauth, setReauth] = useState<(() => void) | null>(null)
  const meta = safe.meta!
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setError(null)
    setMessage(null)
    try {
      await fn()
      if (done) setMessage(done)
    } catch (caught) {
      setError(caught)
    }
  }
  const rotate = () =>
    void act(() => withKeyring((vault, current) => rotateSafeKey(vault, current, safe.id), { dirty: true }), t('safes.rotated'))
  return (
    <Dialog title={t('safes.settings')} onClose={onClose} testId="safe-settings-dialog" wide>
      <div className="space-y-6">
        {!meta.archived ? (
          <SafeForm
            initial={{ name: meta.name, description: meta.description, icon: meta.icon, color: meta.color, requirePassword: meta.requirePassword }}
            submitLabel={t('common.save')}
            onSubmit={async (input) => {
              await withKeyring((vault, current) => updateSafe(vault, current, safe.id, input), { dirty: true })
              setMessage(t('safes.saved'))
            }}
          />
        ) : null}
        {message ? <Success>{message}</Success> : null}
        <ErrorNotice error={error} />
        <div className="flex flex-wrap gap-2 border-t border-line pt-4">
          {!safe.isDefault && !meta.archived ? (
            <Button variant="quiet" className="py-2" data-testid="safe-make-default" onClick={() => void act(() => withKeyring((vault, current) => setDefaultSafe(vault, current, safe.id), { dirty: true }), t('safes.saved'))}>
              {t('safes.makeDefault')}
            </Button>
          ) : null}
          <Button
            variant="quiet"
            className="py-2"
            data-testid="safe-archive"
            onClick={() => void act(() => withKeyring((vault, current) => updateSafe(vault, current, safe.id, { archived: !meta.archived }), { dirty: true }), t('safes.saved'))}
          >
            <Archive size={15} aria-hidden="true" />
            {meta.archived ? t('safes.unarchive') : t('safes.archive')}
          </Button>
          <Button
            variant="quiet"
            className="py-2"
            data-testid="safe-rotate"
            title={t('safes.rotateKeyHelp')}
            onClick={() => (keyring && hasRecentAuth(keyring) ? rotate() : setReauth(() => rotate))}
          >
            {t('safes.rotateKey')}
          </Button>
          <Button variant="danger" className="py-2 sm:ml-auto" data-testid="safe-delete" onClick={() => setDeleting(true)}>
            {t('safes.deleteSafe')}
          </Button>
        </div>
      </div>
      {deleting ? (
        <DeleteSafeDialog
          safe={safe}
          others={others.filter((entry) => entry.meta && !entry.meta.archived && entry.open)}
          onClose={() => setDeleting(false)}
          onDeleted={() => navigate('/app/safes')}
        />
      ) : null}
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
    </Dialog>
  )
}

function DeleteSafeDialog({ safe, others, onClose, onDeleted }: { safe: SafeSummary; others: SafeSummary[]; onClose: () => void; onDeleted: () => void }) {
  const { t } = useI18n()
  const { withKeyring } = useSafes()
  const [choice, setChoice] = useState<'move' | 'contents'>(others.length > 0 ? 'move' : 'contents')
  const [target, setTarget] = useState(others[0]?.id ?? '')
  const [error, setError] = useState<unknown>(null)
  const hasItems = safe.itemCount > 0
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    try {
      await withKeyring(
        (vault, current) =>
          trashSafe(vault, current, safe.id, hasItems && choice === 'move' ? { withContents: false, moveItemsTo: target } : { withContents: true }),
        { dirty: true },
      )
      onDeleted()
    } catch (caught) {
      setError(caught)
    }
  }
  return (
    <Dialog title={t('safes.deleteSafe')} onClose={onClose} testId="safe-delete-dialog">
      <form className="space-y-4" onSubmit={(event) => void submit(event)}>
        <p className="text-sm text-muted">{t('safes.trashIntro')}</p>
        {hasItems ? (
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm">{t('safes.deleteNonEmpty')}</legend>
            {others.length > 0 ? (
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="delete-choice" checked={choice === 'move'} onChange={() => setChoice('move')} data-testid="delete-move" />
                <span className="shrink-0">{t('safes.moveAllTo')}</span>
                <select className={`${controlClass} py-1.5`} value={target} disabled={choice !== 'move'} onChange={(event) => setTarget(event.target.value)} data-testid="delete-target">
                  {others.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.meta?.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="delete-choice" checked={choice === 'contents'} onChange={() => setChoice('contents')} data-testid="delete-contents" />
              {t('safes.deleteWithContents')}
            </label>
          </fieldset>
        ) : null}
        <ErrorNotice error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="quiet" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="danger" data-testid="safe-delete-confirm">
            {t('safes.moveToTrash')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}