import { CircleHelp } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useI18n } from '../../context/I18nContext'

export type HelpSectionId = 'start' | 'signIn' | 'dashboard' | 'transactions' | 'groups' | 'users' | 'safes' | 'backup' | 'settings' | 'account' | 'audit' | 'health' | 'troubleshooting'

/** A small round "?" that opens the guide at the section about the current screen. */
export function HelpLink({ section, signedIn = true, className = '', testId = 'help-link' }: { section: HelpSectionId; signedIn?: boolean; className?: string; testId?: string }) {
  const { t } = useI18n()
  return (
    <Link
      to={`${signedIn ? '/app/help' : '/help'}?section=${section}`}
      data-testid={testId}
      data-section={section}
      aria-label={t('nav.helpPage')}
      title={t('nav.helpPage')}
      className={`inline-grid size-7 shrink-0 place-items-center rounded-full border border-line bg-card text-muted hover:text-ink ${className}`}
    >
      <CircleHelp size={16} aria-hidden="true" />
    </Link>
  )
}
