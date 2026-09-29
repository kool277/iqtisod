import { ChevronLeft, RotateCcw, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '../../context/I18nContext'
import { useSafes } from '../../context/SafeContext'
import { hasRecentAuth, listTrash, purgeItems, purgeSafe, restoreItems, restoreSafe, type SafeSummary } from '../../services/safe.service'
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
  const safes = data?.safes ?? []
  const items = data?.items ?? []
  const iconButton = 'inline-flex h-8 items-center gap-1 rounded-lg border px-2 text-xs'

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
          {safes.map((safe) => (
            <div key={safe.id} className="flex min-w-0 flex-wrap items-center gap-3 rounded-2xl border border-line bg-card px-3 py-2.5" data-testid="trash-safe">
              {safe.meta ? <SafeGlyph icon={safe.meta.icon} color={safe.meta.color} size="sm" /> : null}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{safe.meta?.name ?? t('safes.unreadable')}</span>
                <span className="block text-xs text-muted tabular-nums">
                  {safe.itemCount + safe.trashedItemCount} {t('safes.items').toLocaleLowerCase()} · {t('safes.daysLeft')}: {safe.daysLeft}
                </span>
              </span>
              <span className="flex shrink-0 gap-2">
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
              </span>
            </div>
          ))}
        </section>
      ) : null}
      {items.length > 0 ? (
        <section className="space-y-2">
          <h2 className="font-display text-2xl">{t('safes.trashedItems')}</h2>
          {items.map((item) => {
            const Icon = KIND_ICONS[item.kind]
            return (
              <div key={item.id} className="flex min-w-0 flex-wrap items-center gap-3 rounded-2xl border border-line bg-card px-3 py-2.5" data-testid="trash-item">
                <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-paper text-muted" aria-hidden="true">
                  <Icon size={14} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{item.title}</span>
                  <span className="block truncate text-xs text-muted tabular-nums">
                    {item.safeName ? `${t('safes.inSafe')}: ${item.safeName} · ` : ''}
                    {t('safes.daysLeft')}: {item.daysLeft}
                  </span>
                </span>
                <span className="flex shrink-0 gap-2">
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
                    onClick={() =>
                      guarded(() => void act(() => withKeyring((vault, current) => purgeItems(vault, current, [item.id]), { dirty: true })))
                    }
                  >
                    <Trash2 size={13} aria-hidden="true" />
                    {t('safes.deleteForever')}
                  </button>
                </span>
              </div>
            )
          })}
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
