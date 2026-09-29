import { useMemo, useState, type FormEvent } from 'react'
import { Button, Field, Notice, controlClass } from './ui'
import { useI18n } from '../context/I18nContext'
import { useVault } from '../context/VaultContext'
import { CURRENCIES, type Category, type EntryType } from '../domain/types'
import { readSchemaVersion } from '../db/migrations'
import { BACKUP_VERSION, RECORD_VERSION } from '../db/versions'
import { textForError } from '../lib/errors'
import { formatWhen } from '../lib/money'
import { BUILD } from '../lib/version'
import { Permission, canUser } from '../rbac'
import { categoryLabel, listCategories } from '../services/finance.service'
import {
  categoryInput,
  createCategory,
  deleteCategory,
  updateCategory,
  updateVaultSettings,
  type CategoryInput,
} from '../services/settings.service'

const EMPTY_CATEGORY: CategoryInput = { type: 'EXPENSE', nameEn: '', nameUzLatn: '', nameUzCyrl: '', nameRu: '' }

export function SettingsPage() {
  const { t } = useI18n()
  const { user } = useVault()
  if (!user || !canUser(user, Permission.MANAGE_SETTINGS)) {
    return (
      <p data-testid="forbidden" className="text-clay-ink">
        {t('errors.forbidden')}
      </p>
    )
  }
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="font-display text-4xl">{t('settings.title')}</h1>
        <p className="mt-1 text-sm text-muted">{t('settings.intro')}</p>
      </div>
      <GeneralSettings />
      <CategorySettings />
      <AboutPanel />
    </div>
  )
}

function GeneralSettings() {
  const { t } = useI18n()
  const { run, vaultName, currency } = useVault()
  const [name, setName] = useState(vaultName)
  const [nextCurrency, setNextCurrency] = useState(currency)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setSaved(false)
    try {
      await run((vault) => updateVaultSettings(vault, { vaultName: name, currency: nextCurrency }), { dirty: true })
      setSaved(true)
    } catch (caught) {
      setError(textForError(caught, t))
    }
  }

  return (
    <form className="grid gap-4 rounded-3xl border border-line bg-card p-5" onSubmit={(event) => void onSubmit(event)}>
      <h2 className="font-display text-2xl">{t('settings.general')}</h2>
      {error ? <Notice>{error}</Notice> : null}
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={t('settings.vaultName')}>
          <input
            data-testid="settings-name"
            className={controlClass}
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </Field>
        <Field label={t('settings.currency')}>
          <select
            data-testid="settings-currency"
            className={controlClass}
            value={nextCurrency}
            onChange={(event) => setNextCurrency(event.target.value)}
          >
            {CURRENCIES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <p className="text-sm text-muted">{t('settings.currencyWarn')}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" data-testid="settings-save">
          {t('settings.save')}
        </Button>
        {saved ? (
          <p role="status" className="text-sm text-pine-ink">
            {t('settings.saved')}
          </p>
        ) : null}
      </div>
    </form>
  )
}

function CategorySettings() {
  const { t, locale } = useI18n()
  const { query, run, revision } = useVault()
  const [editing, setEditing] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const categories = useMemo(() => query((vault) => listCategories(vault)), [query, revision])

  async function save(action: () => Promise<unknown>) {
    setError(null)
    try {
      await action()
      return true
    } catch (caught) {
      setError(textForError(caught, t))
      return false
    }
  }

  const sections: { type: EntryType; label: string }[] = [
    { type: 'INCOME', label: t('tx.income') },
    { type: 'EXPENSE', label: t('tx.expense') },
  ]

  return (
    <section className="grid gap-4 rounded-3xl border border-line bg-card p-5">
      <div>
        <h2 className="font-display text-2xl">{t('settings.categories')}</h2>
        <p className="mt-1 text-sm text-muted">{t('settings.categoriesIntro')}</p>
      </div>
      {error ? <Notice>{error}</Notice> : null}
      <CategoryForm
        title={t('settings.addCategory')}
        initial={EMPTY_CATEGORY}
        withType
        testPrefix="category"
        onSubmit={(input) => save(() => run((vault) => createCategory(vault, input), { dirty: true }))}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        {sections.map((section) => (
          <div key={section.type} className="min-w-0">
            <h3 className="mb-2 text-xs uppercase tracking-[0.14em] text-muted">{section.label}</h3>
            <ul className="grid gap-2">
              {categories
                .filter((category) => category.type === section.type)
                .map((category) => (
                  <CategoryRow
                    key={category.id}
                    category={category}
                    label={categoryLabel(category, locale)}
                    editing={editing === category.id}
                    onEdit={() => setEditing(editing === category.id ? null : category.id)}
                    onSave={async (input) => {
                      const ok = await save(() =>
                        run((vault) => updateCategory(vault, category.id, input), { dirty: true }),
                      )
                      if (ok) setEditing(null)
                    }}
                    onRemove={() => void save(() => run((vault) => deleteCategory(vault, category.id), { dirty: true }))}
                  />
                ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}

function CategoryRow({
  category,
  label,
  editing,
  onEdit,
  onSave,
  onRemove,
}: {
  category: Category
  label: string
  editing: boolean
  onEdit: () => void
  onSave: (input: CategoryInput) => Promise<void>
  onRemove: () => void
}) {
  const { t } = useI18n()
  return (
    <li data-testid="category-row" className="rounded-2xl border border-line px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 break-words font-medium">{label}</p>
        <div className="flex gap-2">
          <Button variant="quiet" className="px-3 py-1.5" onClick={onEdit}>
            {t('common.edit')}
          </Button>
          <Button variant="danger" className="px-3 py-1.5" onClick={onRemove}>
            {t('settings.remove')}
          </Button>
        </div>
      </div>
      {editing ? (
        <div className="mt-3">
          <CategoryForm
            title={t('settings.editCategory')}
            initial={categoryInput(category)}
            testPrefix={`category-edit-${category.id}`}
            onSubmit={async (input) => {
              await onSave(input)
              return true
            }}
          />
        </div>
      ) : null}
    </li>
  )
}

function CategoryForm({
  title,
  initial,
  withType = false,
  testPrefix,
  onSubmit,
}: {
  title: string
  initial: CategoryInput
  withType?: boolean
  testPrefix: string
  onSubmit: (input: CategoryInput) => Promise<boolean>
}) {
  const { t } = useI18n()
  const [values, setValues] = useState<CategoryInput>(initial)
  const [pending, setPending] = useState(false)
  const set = (key: keyof CategoryInput) => (value: string) => setValues((current) => ({ ...current, [key]: value }))

  async function submit(event: FormEvent) {
    event.preventDefault()
    setPending(true)
    try {
      const ok = await onSubmit(values)
      if (ok && withType) setValues(EMPTY_CATEGORY)
    } finally {
      setPending(false)
    }
  }

  return (
    <form className="grid gap-3" onSubmit={(event) => void submit(event)} aria-label={title}>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {withType ? (
          <Field label={t('common.type')}>
            <select
              data-testid={`${testPrefix}-type`}
              className={controlClass}
              value={values.type}
              onChange={(event) => set('type')(event.target.value)}
            >
              <option value="EXPENSE">{t('tx.expense')}</option>
              <option value="INCOME">{t('tx.income')}</option>
            </select>
          </Field>
        ) : null}
        <Field label={t('settings.nameEn')}>
          <input data-testid={`${testPrefix}-en`} className={controlClass} maxLength={60} value={values.nameEn} onChange={(event) => set('nameEn')(event.target.value)} required />
        </Field>
        <Field label={t('settings.nameUzLatn')}>
          <input data-testid={`${testPrefix}-uz-latn`} className={controlClass} maxLength={60} value={values.nameUzLatn} onChange={(event) => set('nameUzLatn')(event.target.value)} />
        </Field>
        <Field label={t('settings.nameUzCyrl')}>
          <input data-testid={`${testPrefix}-uz-cyrl`} className={controlClass} maxLength={60} value={values.nameUzCyrl} onChange={(event) => set('nameUzCyrl')(event.target.value)} />
        </Field>
        <Field label={t('settings.nameRu')}>
          <input data-testid={`${testPrefix}-ru`} className={controlClass} maxLength={60} value={values.nameRu} onChange={(event) => set('nameRu')(event.target.value)} />
        </Field>
      </div>
      <div>
        <Button type="submit" data-testid={`${testPrefix}-save`} disabled={pending}>
          {withType ? t('settings.addCategory') : t('common.save')}
        </Button>
      </div>
    </form>
  )
}

function AboutPanel() {
  const { t, locale } = useI18n()
  const { query } = useVault()
  const facts = useMemo(
    () => query((vault) => ({ createdAt: vault.createdAt, schema: readSchemaVersion(vault.db) })),
    [query],
  )
  const rows: { id: string; label: string; value: string }[] = [
    { id: 'about-version', label: t('about.version'), value: BUILD.version },
    { id: 'about-commit', label: t('about.commit'), value: BUILD.commit },
    { id: 'about-built', label: t('about.built'), value: BUILD.builtAt ? formatWhen(BUILD.builtAt, locale) : t('about.unknown') },
    { id: 'about-schema', label: t('about.schema'), value: String(facts.schema) },
    { id: 'about-record', label: t('about.record'), value: String(RECORD_VERSION) },
    { id: 'about-backup', label: t('about.backup'), value: String(BACKUP_VERSION) },
    { id: 'about-created', label: t('about.created'), value: facts.createdAt ? formatWhen(facts.createdAt, locale) : t('about.unknown') },
  ]
  return (
    <section data-testid="about-panel" className="rounded-3xl border border-line bg-card p-5">
      <h2 className="font-display text-2xl">{t('about.title')}</h2>
      <p className="mt-1 text-sm text-muted">{t('about.intro')}</p>
      <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        {rows.map((row) => (
          <div key={row.id} className="contents">
            <dt className="text-muted">{row.label}</dt>
            <dd data-testid={row.id} className="break-all font-mono text-xs leading-5">
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
