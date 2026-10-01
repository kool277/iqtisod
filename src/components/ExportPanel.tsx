import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Button, Field, Notice, controlClass } from './ui'
import { PeriodPicker } from './PeriodPicker'
import { useI18n } from '../context/I18nContext'
import { PeriodProvider, usePeriod } from '../context/PeriodContext'
import { useVault } from '../context/VaultContext'
import { hasExportMessages, loadExportMessages, type Locale, type MessageKey } from '../i18n'
import { downloadFile } from '../lib/download'
import { errorText, textForError } from '../lib/errors'
import { Permission, canUser } from '../rbac'
import { EXPORT_FORMATS, type ExportFormat, type ExportProgress, type Protection } from '../services/export/options'
import { EXPORT_PASSWORD_MIN, estimateStrength, generateExportPassword, passwordProblem, type Strength } from '../services/export/password'
import { listGroups } from '../services/group.service'

const FORMAT_SHORT: Record<ExportFormat, string> = {
  csv: 'CSV',
  json: 'JSON',
  jsonl: 'JSON Lines',
  xlsx: 'Excel',
  pdf: 'PDF',
  sqlite: 'SQLite',
}

const STRENGTH_TEXT: Record<Strength, MessageKey> = {
  weak: 'export.strengthWeak',
  fair: 'export.strengthFair',
  strong: 'export.strengthStrong',
}

const STRENGTH_BARS: Record<Strength, number> = { weak: 1, fair: 2, strong: 3 }

const PROTECTION_OPTIONS: { value: Protection; label: MessageKey; help: MessageKey }[] = [
  { value: 'zip', label: 'export.protectionZip', help: 'export.protectionZipHelp' },
  { value: 'sqlcipher', label: 'export.protectionSqlcipher', help: 'export.protectionSqlcipherHelp' },
  { value: 'none', label: 'export.protectionNone', help: 'export.protectionNoneHelp' },
]

export function ExportPanel() {
  const { t, locale } = useI18n()
  const [loaded, setLoaded] = useState<Locale | null>(() => (hasExportMessages(locale) ? locale : null))
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    setFailed(false)
    loadExportMessages(locale).then(
      () => live && setLoaded(locale),
      () => live && setFailed(true),
    )
    return () => {
      live = false
    }
  }, [locale])

  if (failed && loaded === null) return <Notice>{t('errors.generic')}</Notice>
  // After a language switch the form stays mounted, so a running export is not aborted while the new strings load.
  if (loaded === null) return <div role="status" aria-busy="true" className="min-h-40" />
  return (
    <PeriodProvider initialPreset="month">
      <ExportForm />
    </PeriodProvider>
  )
}

function progressText(progress: ExportProgress, t: (key: MessageKey) => string): string {
  if (progress.stage === 'building') return `${t('export.building')}${progress.format ? ` ${FORMAT_SHORT[progress.format]}` : ''}`
  if (progress.stage === 'encrypting') return t('export.encrypting')
  if (progress.stage === 'done') return t('export.done')
  return t('export.collecting')
}

function ExportForm() {
  const { t, locale } = useI18n()
  const { user, query, run, revision } = useVault()
  const { range } = usePeriod()
  const groups = useMemo(() => query((vault) => listGroups(vault)), [query, revision])
  const [formats, setFormats] = useState<ExportFormat[]>(['csv'])
  const [periodMode, setPeriodMode] = useState<'all' | 'period'>('all')
  const [groupId, setGroupId] = useState('')
  const [includeAudit, setIncludeAudit] = useState(false)
  const [includeReceipts, setIncludeReceipts] = useState(false)
  const [protection, setProtection] = useState<Protection>('zip')
  // ZIP is only as strong as its password, so it starts with a generated one.
  const [password, setPassword] = useState(() => generateExportPassword())
  const [confirm, setConfirm] = useState(password)
  const [showPassword, setShowPassword] = useState(true)
  const [copied, setCopied] = useState(false)
  const [plainConfirmed, setPlainConfirmed] = useState(false)
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const isAdmin = user?.roleName === 'Admin'
  const auditAvailable = Boolean(user && canUser(user, Permission.READ_AUDIT)) && groupId === ''
  const encrypted = protection !== 'none'
  const strength = password ? estimateStrength(password) : null
  const busy = progress !== null

  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 2000)
    return () => window.clearTimeout(timer)
  }, [copied])

  function toggleFormat(format: ExportFormat) {
    setFormats((current) => (current.includes(format) ? current.filter((item) => item !== format) : [...current, format]))
  }

  function onGenerate() {
    const generated = generateExportPassword()
    setPassword(generated)
    setConfirm(generated)
    setShowPassword(true)
  }

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(password)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  function clientProblem(): string | null {
    if (protection !== 'sqlcipher' && formats.length === 0) return 'EXPORT_NO_FORMAT'
    if (!encrypted) return plainConfirmed ? null : 'EXPORT_PLAIN_UNCONFIRMED'
    return passwordProblem(password, confirm, protection)
  }

  function chooseProtection(value: Protection) {
    setProtection(value)
    if (value === 'zip' && !password) onGenerate()
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setNotice(null)
    const problem = clientProblem()
    if (problem) {
      setError(errorText(problem, t))
      return
    }
    const controller = new AbortController()
    abortRef.current = controller
    setProgress({ stage: 'collecting' })
    try {
      const { runExport } = await import('../services/export')
      const result = await run(
        (vault) =>
          runExport(
            vault,
            {
              formats,
              period: periodMode === 'period' ? { from: range.start, to: range.end } : null,
              groupId: groupId ? Number(groupId) : null,
              includeAudit: includeAudit && auditAvailable,
              includeReceipts,
              protection,
              password: encrypted ? password : undefined,
              passwordConfirm: encrypted ? confirm : undefined,
              plainConfirmed,
              locale,
            },
            { signal: controller.signal, onProgress: setProgress },
          ),
        { dirty: true },
      )
      downloadFile(result.blob, result.fileName, result.mime)
      setPassword('')
      setConfirm('')
      setShowPassword(false)
      setNotice(t('export.done'))
    } catch (caught) {
      setError(textForError(caught, t))
      await run(() => undefined, { dirty: true }).catch(() => undefined)
    } finally {
      abortRef.current = null
      setProgress(null)
    }
  }

  return (
    <form data-testid="export-panel" className="grid gap-5 rounded-3xl border border-line bg-card p-5" onSubmit={(event) => void onSubmit(event)}>
      <div>
        <h2 className="font-display text-2xl">{t('export.title')}</h2>
        <p className="mt-2 text-sm text-muted">{t('export.intro')}</p>
      </div>

      <fieldset className="grid gap-2" disabled={busy}>
        <legend className="mb-2 text-sm font-medium">{t('export.formats')}</legend>
        {EXPORT_FORMATS.map((format) => (
          <label key={format} className={`flex items-center gap-2 text-sm ${protection === 'sqlcipher' ? 'opacity-60' : ''}`}>
            <input
              type="checkbox"
              data-testid={`export-format-${format}`}
              checked={protection === 'sqlcipher' ? format === 'sqlite' : formats.includes(format)}
              disabled={protection === 'sqlcipher'}
              onChange={() => toggleFormat(format)}
            />
            {t(`export.format.${format}`)}
          </label>
        ))}
        {formats.includes('csv') && protection !== 'sqlcipher' ? <p className="text-xs text-muted">{t('export.csvExcelHint')}</p> : null}
      </fieldset>

      <fieldset className="grid gap-3" disabled={busy}>
        <legend className="mb-2 text-sm font-medium">{t('export.period')}</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" name="export-period" data-testid="export-period-all" checked={periodMode === 'all'} onChange={() => setPeriodMode('all')} />
            {t('export.allData')}
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="export-period" data-testid="export-period-selected" checked={periodMode === 'period'} onChange={() => setPeriodMode('period')} />
            {t('export.selectedPeriod')}
          </label>
        </div>
        {periodMode === 'period' ? <PeriodPicker /> : null}
      </fieldset>

      <fieldset className="grid gap-3" disabled={busy}>
        {isAdmin ? (
          <Field label={t('export.group')}>
            <select data-testid="export-group" className={controlClass} value={groupId} onChange={(event) => setGroupId(event.target.value)}>
              <option value="">{t('export.allGroups')}</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <label className={`flex items-start gap-2 text-sm ${auditAvailable ? '' : 'opacity-60'}`}>
          <input
            type="checkbox"
            className="mt-0.5"
            data-testid="export-include-audit"
            checked={includeAudit && auditAvailable}
            disabled={!auditAvailable}
            onChange={(event) => setIncludeAudit(event.target.checked)}
          />
          <span>
            {t('export.includeAudit')}
            <span className="block text-xs text-muted">{t('export.includeAuditHelp')}</span>
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" data-testid="export-include-receipts" checked={includeReceipts} onChange={(event) => setIncludeReceipts(event.target.checked)} />
          {t('export.includeReceipts')}
        </label>
      </fieldset>

      <fieldset className="grid gap-3" disabled={busy}>
        <legend className="mb-2 text-sm font-medium">{t('export.protection')}</legend>
        {PROTECTION_OPTIONS.map((option) => (
          <label key={option.value} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="export-protection"
              className="mt-0.5"
              data-testid={`export-protection-${option.value}`}
              checked={protection === option.value}
              onChange={() => chooseProtection(option.value)}
            />
            <span>
              {t(option.label)}
              <span className={`block text-xs ${option.value === 'none' ? 'text-clay-ink' : 'text-muted'}`}>{t(option.help)}</span>
            </span>
          </label>
        ))}

        {encrypted ? (
          <div className="grid gap-3 rounded-2xl border border-line p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('export.password')}>
                <input
                  data-testid="export-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  spellCheck={false}
                  minLength={EXPORT_PASSWORD_MIN}
                  className={`${controlClass} font-mono`}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
              <Field label={t('export.passwordConfirm')}>
                <input
                  data-testid="export-password-confirm"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  spellCheck={false}
                  className={`${controlClass} font-mono`}
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                />
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="quiet" data-testid="export-generate" onClick={onGenerate}>
                {t('export.generate')}
              </Button>
              <Button variant="quiet" data-testid="export-show" aria-pressed={showPassword} onClick={() => setShowPassword((value) => !value)}>
                {showPassword ? t('export.hide') : t('export.show')}
              </Button>
              <Button variant="quiet" data-testid="export-copy" disabled={!password} onClick={() => void onCopy()}>
                {copied ? t('export.copied') : t('export.copy')}
              </Button>
              {strength ? (
                <span data-testid="export-strength" data-strength={strength} className="ml-auto flex items-center gap-2 text-xs">
                  <span className="text-muted">{t('export.strength')}:</span>
                  <span className="flex gap-1" aria-hidden="true">
                    {[1, 2, 3].map((bar) => (
                      <span
                        key={bar}
                        className={`h-1.5 w-6 rounded-full ${bar <= STRENGTH_BARS[strength] ? (strength === 'weak' ? 'bg-clay' : strength === 'fair' ? 'bg-brass' : 'bg-pine') : 'bg-line'}`}
                      />
                    ))}
                  </span>
                  <span className="font-medium">{t(STRENGTH_TEXT[strength])}</span>
                </span>
              ) : null}
            </div>
            <p className="text-xs text-muted">{t('export.passwordHelp')}</p>
          </div>
        ) : (
          <label className="flex items-center gap-2 rounded-2xl border border-clay/50 p-4 text-sm text-clay-ink">
            <input type="checkbox" data-testid="export-plain-confirm" checked={plainConfirmed} onChange={(event) => setPlainConfirmed(event.target.checked)} />
            {t('export.plainConfirm')}
          </label>
        )}
      </fieldset>

      {error ? <Notice>{error}</Notice> : null}
      <p data-testid="export-progress" aria-live="polite" className="min-h-5 text-sm text-pine-ink">
        {progress ? progressText(progress, t) : (notice ?? '')}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" data-testid="export-start" disabled={busy}>
          {t('export.start')}
        </Button>
        {busy ? (
          <Button variant="quiet" data-testid="export-cancel" onClick={() => abortRef.current?.abort()}>
            {t('export.cancel')}
          </Button>
        ) : null}
      </div>
    </form>
  )
}
