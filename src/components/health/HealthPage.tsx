import { CircleCheck, CircleX, Copy, Info, RefreshCw, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '../../context/I18nContext'
import { useLazyCatalog } from '../../context/useLazyCatalog'
import { useVault } from '../../context/VaultContext'
import { hasHealthMessages, loadHealthMessages, type MessageKey } from '../../i18n'
import { HEALTH_GROUPS, overall, summarize, type HealthAction, type HealthResult, type HealthStatus } from '../../health/model'
import { healthReport, shortAgent } from '../../health/report'
import { runHealthChecks } from '../../health/run'
import { BUILD } from '../../lib/version'
import { HelpLink } from '../help/HelpLink'
import { Button } from '../ui'

const STATUS_ICONS: Record<HealthStatus, typeof Info> = { pass: CircleCheck, warn: TriangleAlert, fail: CircleX, info: Info }

const STATUS_STYLES: Record<HealthStatus, string> = {
  pass: 'text-rise',
  warn: 'text-brass',
  fail: 'text-clay-ink',
  info: 'text-muted',
}

const OVERALL_STYLES = {
  pass: 'border-pine/40 bg-pine/10',
  warn: 'border-brass/50 bg-brass-soft',
  fail: 'border-clay/50 bg-clay/10 text-clay-ink',
} as const

const ACTION_ROUTES: Partial<Record<HealthAction, string>> = {
  backup: '/app/backup',
  clock: '/app/users',
  audit: '/app/audit',
  account: '/app/account',
}

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match))
}

type Mode = 'app' | 'standalone' | 'embedded'

/**
 * The health check. In the app it covers the open vault too; before sign-in (`standalone`, or `embedded` in the
 * start-up error screen) it covers only the browser, storage, version, rates and security.
 */
export function HealthPage({ mode = 'app' }: { mode?: Mode }) {
  const catalog = useLazyCatalog(loadHealthMessages, hasHealthMessages)
  const { t } = useI18n()
  if (catalog !== 'ready') {
    return (
      <div role="status" aria-busy={catalog === 'loading'} className="min-h-40 text-sm text-muted">
        {catalog === 'failed' ? t('errors.sqlite') : null}
      </div>
    )
  }
  return <HealthView mode={mode} />
}

function HealthView({ mode }: { mode: Mode }) {
  const { t, locale } = useI18n()
  const { status, user, query, saveState, weakPassword, lock } = useVault()
  const signedIn = mode === 'app' && status === 'ready' && user !== null
  const [results, setResults] = useState<HealthResult[] | null>(null)
  const [running, setRunning] = useState(false)
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const runId = useRef(0)
  const access = useRef({ query, saveState, weak: weakPassword })
  access.current = { query, saveState, weak: weakPassword }

  const run = useCallback(async () => {
    const id = ++runId.current
    setRunning(true)
    setCopyState('idle')
    try {
      const next = await runHealthChecks(signedIn ? access.current : null)
      if (id === runId.current) {
        setResults(next)
        setCheckedAt(new Date())
      }
    } finally {
      if (id === runId.current) setRunning(false)
    }
  }, [signedIn])

  useEffect(() => {
    void run()
  }, [run])

  const title = useCallback((item: HealthResult) => t(`health.checks.${item.id}.title` as MessageKey), [t])
  const report = useMemo(() => {
    if (!results) return ''
    return healthReport(results, {
      appName: 'Jaybi',
      version: BUILD.version,
      commit: BUILD.commit,
      locale,
      createdAt: (checkedAt ?? new Date()).toISOString(),
      agent: typeof navigator === 'undefined' ? '' : shortAgent(navigator.userAgent),
      signedIn,
      title: (item) => t(`health.checks.${item.id}.title` as MessageKey),
      label: (key) => t(`health.facts.${key}` as MessageKey),
    })
  }, [results, checkedAt, locale, signedIn, t])

  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('clipboard')
      await navigator.clipboard.writeText(report)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  const act = async (action: HealthAction) => {
    if (action === 'persist') {
      let granted = false
      try {
        granted = (await navigator.storage?.persist?.()) === true
      } catch {
        granted = false
      }
      setNotice(t(granted ? 'health.persistGranted' : 'health.persistRefused'))
      await run()
      return
    }
    if (action === 'reload') {
      if (status === 'ready') await lock()
      window.location.reload()
    }
  }

  const summary = results ? summarize(results) : null
  const state = results ? overall(results) : null

  return (
    <section data-testid="health-page" data-mode={mode} aria-busy={running} className="grid gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-2xl">
          <div className="flex items-center gap-2">
            <h1 className="font-display text-4xl">{t('health.title')}</h1>
            <HelpLink section="health" signedIn={mode === 'app'} />
          </div>
          <p className="mt-2 text-sm text-muted">{t(signedIn ? 'health.intro' : 'health.introSignedOut')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="quiet" data-testid="health-run" disabled={running} onClick={() => void run()}>
            <RefreshCw size={16} aria-hidden="true" className={running ? 'animate-spin motion-reduce:animate-none' : ''} />
            {running ? t('health.running') : t('health.run')}
          </Button>
          <Button data-testid="health-copy" disabled={!results} onClick={() => void copy()}>
            <Copy size={16} aria-hidden="true" />
            {t('health.copy')}
          </Button>
        </div>
      </div>

      <div aria-live="polite" className="grid gap-3 empty:hidden">
        {copyState !== 'idle' ? (
          <p data-testid="health-copy-status" data-state={copyState} className="rounded-xl bg-brass-soft px-3 py-2 text-sm">
            {t(copyState === 'copied' ? 'health.copied' : 'health.copyFailed')}
          </p>
        ) : null}
        {notice ? (
          <p data-testid="health-notice" className="rounded-xl bg-brass-soft px-3 py-2 text-sm">
            {notice}
          </p>
        ) : null}
      </div>

      {state && summary ? (
        <div role="status" data-testid="health-overall" data-status={state} className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border px-4 py-3 ${OVERALL_STYLES[state]}`}>
          <p className="font-medium">{t(`health.overall.${state}`)}</p>
          <ul className="flex flex-wrap gap-3 text-sm" aria-label={t('health.title')}>
            {(['fail', 'warn', 'pass', 'info'] as const).map((key) => {
              const Icon = STATUS_ICONS[key]
              return (
                <li key={key} data-testid={`health-count-${key}`} data-count={summary[key]} className="inline-flex items-center gap-1">
                  <Icon size={16} aria-hidden="true" className={STATUS_STYLES[key]} />
                  <span>{t(`health.status.${key}`)}</span>
                  <strong className="tabular-nums">{summary[key]}</strong>
                </li>
              )
            })}
          </ul>
        </div>
      ) : (
        <div role="status" aria-busy="true" className="min-h-20 text-sm text-muted">
          {t('health.running')}
        </div>
      )}

      {results
        ? HEALTH_GROUPS.map((group) => {
            const items = results.filter((item) => item.group === group)
            if (items.length === 0) return null
            return (
              <section key={group} data-testid="health-group" data-group={group} aria-labelledby={`health-group-${group}`} className="rounded-3xl border border-line bg-card p-4 sm:p-5">
                <h2 id={`health-group-${group}`} className="font-display text-2xl">
                  {t(`health.groups.${group}`)}
                </h2>
                <ul className="mt-3 divide-y divide-line">
                  {items.map((item) => (
                    <CheckRow key={item.id} item={item} title={title(item)} signedIn={signedIn} onAction={(action) => void act(action)} />
                  ))}
                </ul>
              </section>
            )
          })
        : null}

      {results && !signedIn ? <p className="text-sm text-muted">{t('health.signedOutVault')}</p> : null}

      {results ? (
        <details className="rounded-3xl border border-line bg-card p-4 sm:p-5">
          <summary className="cursor-pointer font-medium">{t('health.reportText')}</summary>
          <p className="mt-2 text-sm text-muted">{t('health.reportNote')}</p>
          <pre data-testid="health-report" className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-paper p-3 text-xs">
            {report}
          </pre>
        </details>
      ) : null}

      {checkedAt ? (
        <p className="text-xs text-muted" data-testid="health-checked-at">
          {fill(t('health.lastRun'), { time: checkedAt.toLocaleTimeString(locale) })}
        </p>
      ) : null}

      {mode === 'standalone' ? (
        <p>
          <Link to="/" className="text-sm text-pine-ink hover:underline">
            {t('health.backToSignIn')}
          </Link>
        </p>
      ) : null}
    </section>
  )
}

function CheckRow({ item, title, signedIn, onAction }: { item: HealthResult; title: string; signedIn: boolean; onAction: (action: HealthAction) => void }) {
  const { t } = useI18n()
  const Icon = STATUS_ICONS[item.status]
  const facts = Object.entries(item.facts ?? {})
  const needsFix = item.status === 'warn' || item.status === 'fail'
  const route = item.action ? ACTION_ROUTES[item.action] : undefined
  return (
    <li data-testid="health-check" data-id={item.id} data-status={item.status} data-detail={item.detail} data-admin={item.adminOnly ? 'true' : undefined} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 py-3">
      <Icon size={20} aria-hidden="true" className={`mt-0.5 ${STATUS_STYLES[item.status]}`} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="font-medium">{title}</h3>
          <span className={`rounded-full border border-line px-2 py-0.5 text-xs ${STATUS_STYLES[item.status]}`}>{t(`health.status.${item.status}`)}</span>
          {item.adminOnly ? (
            <span data-testid="health-admin-badge" className="rounded-full bg-brass-soft px-2 py-0.5 text-xs">
              {t('health.adminOnly')}
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-sm">{t(`health.checks.${item.id}.${item.detail}` as MessageKey)}</p>
        {facts.length > 0 ? (
          <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {facts.map(([key, value]) => (
              <div key={key} className="flex gap-1">
                <dt className="text-muted">{t(`health.facts.${key}` as MessageKey)}:</dt>
                <dd className="tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {needsFix ? (
          <p className="mt-2 rounded-xl bg-paper px-3 py-2 text-sm">
            <strong className="font-medium">{t('health.howToFix')}:</strong> {t(`health.checks.${item.id}.fix` as MessageKey)}
          </p>
        ) : null}
        {item.action && (route ? signedIn : true) ? (
          <div className="mt-2">
            {route ? (
              <Link to={route} data-testid="health-action" data-action={item.action} className="inline-flex rounded-xl border border-line bg-card px-3 py-1.5 text-sm font-medium hover:border-brass">
                {t(`health.actions.${item.action}`)}
              </Link>
            ) : (
              <Button variant="quiet" className="py-1.5" data-testid="health-action" data-action={item.action} onClick={() => onAction(item.action!)}>
                {t(`health.actions.${item.action}`)}
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </li>
  )
}
