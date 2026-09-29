import { Archive, BookOpen, Layers, LayoutDashboard, Lock, ScrollText, Users } from 'lucide-react'
import { NavLink, Outlet } from 'react-router-dom'
import { PeriodProvider } from '../context/PeriodContext'
import { useI18n } from '../context/I18nContext'
import { useVault } from '../context/VaultContext'
import type { MessageKey } from '../i18n'
import { Permission, canUser } from '../rbac'
import { Preferences } from './Preferences'

const links: {
  to: string
  end?: boolean
  testId: string
  label: MessageKey
  icon: typeof Users
  permission: (typeof Permission)[keyof typeof Permission]
}[] = [
  { to: '/app', end: true, testId: 'nav-dashboard', label: 'nav.dashboard', icon: LayoutDashboard, permission: Permission.READ_DASHBOARD },
  { to: '/app/transactions', testId: 'nav-transactions', label: 'nav.transactions', icon: BookOpen, permission: Permission.READ_TRANSACTIONS },
  { to: '/app/users', testId: 'nav-users', label: 'nav.users', icon: Users, permission: Permission.MANAGE_USERS },
  { to: '/app/groups', testId: 'nav-groups', label: 'nav.groups', icon: Layers, permission: Permission.MANAGE_GROUPS },
  { to: '/app/audit', testId: 'nav-audit', label: 'nav.audit', icon: ScrollText, permission: Permission.READ_AUDIT },
  { to: '/app/backup', testId: 'nav-backup', label: 'nav.backup', icon: Archive, permission: Permission.EXPORT_VAULT },
]

export function AppShell() {
  const { t } = useI18n()
  const { user, vaultName, lock, saveState } = useVault()
  if (!user) return null

  return (
    <PeriodProvider>
      <div className="mx-auto grid min-h-screen max-w-[1440px] md:grid-cols-[240px_minmax(0,1fr)]">
        <a href="#content" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-30 focus:rounded-xl focus:bg-card focus:px-3 focus:py-2">
          {t('common.skip')}
        </a>
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-4 md:col-start-2 md:row-start-1 md:border-b md:px-8">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-brass">{t('app.name')}</p>
            <p className="font-display text-2xl leading-none">{vaultName}</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span data-testid="save-state" className="text-xs text-muted">
              {t(`status.${saveState}`)}
            </span>
            <Preferences />
            <button
              type="button"
              data-testid="lock-vault"
              className="inline-flex items-center gap-2 rounded-full border border-line bg-card px-3 py-1.5 text-sm"
              onClick={() => void lock()}
            >
              <Lock size={16} aria-hidden="true" />
              {t('nav.lock')}
            </button>
          </div>
        </header>
        <nav className="flex gap-1 overflow-x-auto border-b border-line p-3 md:col-start-1 md:row-span-2 md:row-start-1 md:flex-col md:border-b-0 md:border-r md:p-4">
          <p className="mb-4 hidden font-display text-3xl md:block">Moliya</p>
          {links
            .filter((link) => canUser(user, link.permission))
            .map((link) => {
              const Icon = link.icon
              return (
                <NavLink
                  key={link.to}
                  to={link.to}
                  end={link.end}
                  data-testid={link.testId}
                  className={({ isActive }) =>
                    `flex items-center gap-2 whitespace-nowrap rounded-2xl px-3 py-2 text-sm ${isActive ? 'bg-brass-soft text-ink' : 'text-muted hover:bg-card'}`
                  }
                >
                  <Icon size={16} aria-hidden="true" />
                  {t(link.label)}
                </NavLink>
              )
            })}
        </nav>
        <main id="content" className="px-4 py-6 md:col-start-2 md:px-8 md:py-8">
          <Outlet />
        </main>
      </div>
    </PeriodProvider>
  )
}
