import { CircleCheck, CircleX, Minus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useI18n } from '../../context/I18nContext'
import { useVault } from '../../context/VaultContext'
import type { OpenVault } from '../../domain/types'
import type { MessageKey } from '../../i18n'
import { fillTemplate as fill } from '../../lib/template'
import type { AuditCheckReport, AuditSigProblem } from '../../services/v2/audit-check'

export type SignatureState = { status: 'off' } | { status: 'checking' } | { status: 'failed' } | { status: 'ready'; report: AuditCheckReport }

/** One entry's signature: checked out, written before signatures, its problems, or still being checked. */
export type RowSignature = 'signed' | 'legacy' | 'checking' | AuditSigProblem[]

/**
 * Checks every signature of an open vault with per-person keys whenever its data changes. Badges stay as they were
 * while a new check runs; the check keeps what it verified for the page's life, so a recheck costs only the new entries.
 */
export function useAuditSignatures(enabled: boolean): SignatureState {
  const { query, revision } = useVault()
  const [state, setState] = useState<SignatureState>({ status: enabled ? 'checking' : 'off' })
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void import('../../services/v2/audit-check')
      .then(({ checkVaultAudit }) =>
        query((vault) => {
          const keys = vault.keys
          return keys ? checkVaultAudit(vault as OpenVault & { keys: typeof keys }, { full: true }) : null
        }),
      )
      .then(
        (report) => {
          if (!cancelled) setState(report ? { status: 'ready', report } : { status: 'failed' })
        },
        () => {
          if (!cancelled) setState({ status: 'failed' })
        },
      )
    return () => {
      cancelled = true
    }
  }, [enabled, query, revision])
  return enabled ? state : { status: 'off' }
}

export function signatureOf(state: SignatureState, seq: number): RowSignature {
  if (state.status !== 'ready') return 'checking'
  const problems = state.report.problems.get(seq)
  if (problems) return problems
  return state.report.signedFrom === null || seq < state.report.signedFrom ? 'legacy' : 'signed'
}

export function signatureText(value: RowSignature, t: (key: MessageKey) => string): string {
  if (value === 'signed') return t('keys.audit.signed')
  if (value === 'legacy') return t('keys.audit.legacy')
  if (value === 'checking') return t('keys.audit.checking')
  return value.map((problem) => t(`keys.audit.problem.${problem}`)).join(' · ')
}

export function SignatureBadge({ value }: { value: RowSignature }) {
  const { t } = useI18n()
  const text = signatureText(value, t)
  const kind = typeof value === 'string' ? value : 'problem'
  const Icon = kind === 'signed' ? CircleCheck : kind === 'problem' ? CircleX : Minus
  const tone = kind === 'signed' ? 'text-pine-ink' : kind === 'problem' ? 'text-clay-ink' : 'text-muted'
  return (
    <span data-testid="audit-signature" data-signature={kind} className={`inline-flex items-start gap-1 ${tone}`}>
      <Icon size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>{text}</span>
    </span>
  )
}

export function SignatureSummary({ state }: { state: SignatureState }) {
  const { t } = useI18n()
  if (state.status === 'off') return null
  const report = state.status === 'ready' ? state.report : null
  const problems = report?.problems.size ?? 0
  const tone = problems > 0 || state.status === 'failed' ? 'border-clay text-clay-ink' : 'border-pine/40 text-pine-ink'
  return (
    <p data-testid="audit-signatures" data-state={state.status} data-problems={problems} className={`rounded-2xl border px-4 py-3 text-sm ${state.status === 'checking' ? 'border-line text-muted' : tone}`}>
      {state.status === 'checking'
        ? t('keys.audit.summaryChecking')
        : !report
          ? t('keys.audit.summaryFailed')
          : report.signedFrom === null
            ? t('keys.audit.summaryNone')
            : fill(t('keys.audit.summary'), { signed: report.verified, problems })}
      {report && report.signedFrom !== null && report.legacy > 0 ? <> {fill(t('keys.audit.summaryLegacy'), { legacy: report.legacy })}</> : null}
    </p>
  )
}
