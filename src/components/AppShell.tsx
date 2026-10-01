import {
  Archive,
  BookOpen,
  Layers,
  LayoutDashboard,
  Lock,
  PanelLeftClose,
  PanelLeftOpen,
  ScrollText,
  Settings,
  UserRound,
  Users,
  Vault,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, Navigate, NavLink, Outlet, useLocation } from 'react-router-dom'
import { PeriodProvider } from '../context/PeriodContext'
import { SafeProvider } from '../context/SafeContext'
import { useI18n } from '../context/I18nContext'
import { useVault } from '../context/VaultContext'
import type { MessageKey } from '../i18n'
import { BUILD } from '../lib/version'
import { Permission, canUser } from '../rbac'
import { backupReminder } from '../services/backup.service'
import { BrandMark } from './Brand'
import { Preferences } from './Preferences'

const SIDEBAR_KEY = 'moliya.sidebar'

const links: {
  to: string
  end?: boolean
  testId: string
  label: MessageKey
  icon: typeof Users
  permission?: (typeof Permission)[keyof typeof Permission]
}[] = [
  { to: '/app', end: true, testId: 'nav-dashboard', label: 'nav.dashboard', icon: LayoutDashboard, permission: Permission.READ_DASHBOARD },
  { to: '/app/transactions', testId: 'nav-transactions', label: 'nav.transactions', icon: BookOpen, permission: Permission.READ_TRANSACTIONS },
  { to: '/app/safes', testId: 'nav-safes', label: 'nav.safes', icon: Vault },
  { to: '/app/users', testId: 'nav-users', label: 'nav.users', icon: Users, permission: Permission.MANAGE_USERS },
  { to: '/app/groups', testId: 'nav-groups', label: 'nav.groups', icon: Layers, permission: Permission.READ_DASHBOARD },
  { to: '/app/audit', testId: 'nav-audit', label: 'nav.audit', icon: ScrollText, permission: Permission.READ_AUDIT },
  { to: '/app/backup', testId: 'nav-backup', label: 'nav.backup', icon: Archive, permission: Permission.EXPORT_VAULT },
  { to: '/app/settings', testId: 'nav-settings', label: 'nav.settings', icon: Settings, permission: Permission.MANAGE_SETTINGS },
  { to: '/app/account', testId: 'nav-account', label: 'nav.account', icon: UserRound },
]

const ACCOUNT_PATH = '/app/account'

export function AppShell() {
  const { t } = useI18n()
  const { user, vaultName, lock, saveState, query, revision, lastBackupAt, weakPassword, storageNearLimit, recoveryLeft, clearRecoveryNotice, failuresSeen, checkFailuresSeen, clearFailuresSeen, auditWarning, dismissAuditWarning, acceptAuditLog } = useVault()
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_KEY) === 'collapsed')
  const [reminderDismissed, setReminderDismissed] = useState(false)
  const reminder = useMemo(() => (user ? query((vault) => backupReminder(vault)) : null), [user, query, revision, lastBackupAt])
  const location = useLocation()
  if (!user) return null
  const forced = user.mustChangePassword
  const visibleLinks = links.filter((link) => (forced ? link.to === ACCOUNT_PATH : !link.permission || canUser(user, link.permission)))

  const toggleSidebar = () => {
    const next = !collapsed
    localStorage.setItem(SIDEBAR_KEY, next ? 'collapsed' : 'expanded')
    setCollapsed(next)
  }
  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose

  return (
    <PeriodProvider>
      <div
        data-testid="app-shell"
        data-sidebar={collapsed ? 'collapsed' : 'expanded'}
        className={`grid min-h-screen grid-rows-[40px_auto_1fr] md:grid-rows-[40px_1fr] transition-[grid-template-columns] duration-200 ${collapsed ? 'md:grid-cols-[65px_minmax(0,1fr)]' : 'md:grid-cols-[240px_minmax(0,1fr)]'}`}
      >
        {/* The router owns the fragment, so href="#content" would navigate to a route called "content". */}
        <button
          type="button"
          data-testid="skip-link"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-30 focus:rounded-xl focus:bg-card focus:px-3 focus:py-2"
          onClick={() => document.getElementById('content')?.focus()}
        >
          {t('common.skip')}
        </button>
        <header className="sticky top-0 z-20 box-border flex h-10 min-w-0 shrink-0 items-center justify-between gap-2 border-b border-line bg-paper px-4 md:col-start-2 md:row-start-1 md:px-8">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              data-testid="sidebar-toggle"
              aria-controls="app-sidebar"
              aria-expanded={!collapsed}
              aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
              title={collapsed ? t('nav.expand') : t('nav.collapse')}
              className="grid size-7 shrink-0 place-items-center rounded-full border border-line bg-card text-muted hover:text-ink"
              onClick={toggleSidebar}
            >
              <ToggleIcon size={16} aria-hidden="true" />
            </button>
            <p className="flex min-w-0 items-baseline gap-2 leading-none">
              <Link to="/app" title={t('nav.dashboard')} className="hidden shrink-0 text-[10px] uppercase tracking-[0.18em] text-brass hover:underline lg:inline">
                {t('app.name')}
              </Link>
              <span className="truncate font-display text-lg leading-none">{vaultName}</span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <span data-testid="save-state" className="sr-only text-xs text-muted sm:not-sr-only sm:whitespace-nowrap">
              {t(`status.${saveState}`)}
            </span>
            <Preferences compact />
            <button
              type="button"
              data-testid="lock-vault"
              aria-label={t('nav.lock')}
              title={t('nav.lock')}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-line bg-card px-2 text-xs sm:px-2.5"
              onClick={() => void lock()}
            >
              <Lock size={14} aria-hidden="true" />
              <span className="hidden sm:inline">{t('nav.lock')}</span>
            </button>
          </div>
        </header>
        <nav
          id="app-sidebar"
          aria-label={t('app.name')}
          className={`${collapsed ? 'hidden md:flex' : 'flex'} gap-1 overflow-x-auto border-b border-line p-3 md:sticky md:top-0 md:col-start-1 md:row-span-2 md:row-start-1 md:h-screen md:flex-col md:overflow-y-auto md:overflow-x-hidden md:border-b-0 md:border-r md:[scrollbar-width:none] md:[&::-webkit-scrollbar]:hidden ${collapsed ? 'md:items-center' : ''}`}
        >
          <Link
            to="/app"
            data-testid="brand-home"
            aria-label={`${t('app.name')}: ${t('nav.dashboard')}`}
            title={t('nav.dashboard')}
            className={`mb-4 hidden h-10 shrink-0 items-center rounded-xl leading-none hover:text-brass md:flex ${collapsed ? 'w-10 justify-center overflow-hidden' : 'gap-3 px-3'}`}
          >
            <BrandMark className={collapsed ? 'text-lg' : 'text-3xl'} />
            {collapsed ? null : <span className="truncate font-display text-xl">{t('app.name')}</span>}
          </Link>
          {visibleLinks.map((link) => {
              const Icon = link.icon
              const label = t(link.label)
              return (
                <NavLink
                  key={link.to}
                  to={link.to}
                  end={link.end}
                  data-testid={link.testId}
                  title={collapsed ? label : undefined}
                  className={({ isActive }) =>
                    `flex shrink-0 items-center gap-2 whitespace-nowrap rounded-2xl px-3 py-2 text-sm md:h-10 md:py-0 ${collapsed ? 'md:w-10 md:justify-center md:px-0' : ''} ${isActive ? 'bg-brass-soft text-ink' : 'text-muted hover:bg-card'}`
                  }
                >
                  <Icon size={collapsed ? 18 : 16} aria-hidden="true" className="shrink-0" />
                  <span className={collapsed ? 'md:sr-only' : 'truncate'}>{label}</span>
                </NavLink>
              )
            })}
          <p
            data-testid="app-version"
            title={`${BUILD.version} (${BUILD.commit})`}
            className={`mt-auto hidden pt-4 text-[11px] tabular-nums text-muted md:block ${collapsed ? 'md:text-center' : 'px-3'}`}
          >
            v{BUILD.version}
          </p>
        </nav>
        <main id="content" tabIndex={-1} className="mx-auto w-full outline-none min-w-0 max-w-[1280px] px-4 py-6 md:col-start-2 md:px-8 md:py-8">
          {weakPassword && !forced && location.pathname !== ACCOUNT_PATH ? (
            <div role="status" data-testid="weak-password-banner" className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-brass/50 bg-brass-soft px-4 py-3 text-sm">
              <span className="min-w-0">{t('security.weakPassword')}</span>
              <Link to={ACCOUNT_PATH} className="shrink-0 rounded-xl border border-line bg-card px-3 py-1.5 font-medium hover:border-brass">
                {t('security.weakAction')}
              </Link>
            </div>
          ) : null}
          {auditWarning && !forced ? (
            <div role="alert" data-testid="audit-warning" data-kind={auditWarning.kind} className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-clay bg-clay/10 px-4 py-3 text-sm text-clay-ink">
              <span className="min-w-0">
                {auditWarning.kind === 'BROKEN' ? (
                  <>
                    {t('security.auditBroken')} <strong className="tabular-nums">#{auditWarning.brokenAt}</strong>
                  </>
                ) : (
                  <>
                    {t(auditWarning.kind === 'SHORTER' ? 'security.auditShorter' : 'security.auditChanged')}{' '}
                    <span className="tabular-nums">
                      ({auditWarning.expected.seq} → {auditWarning.actual.seq})
                    </span>
                  </>
                )}
              </span>
              <span className="flex shrink-0 flex-wrap gap-2">
                <Link to="/app/audit" className="rounded-xl px-3 py-1.5 underline hover:text-ink">
                  {t('security.auditOpen')}
                </Link>
                {auditWarning.kind !== 'BROKEN' ? (
                  <button type="button" data-testid="audit-accept" className="rounded-xl px-3 py-1.5 hover:text-ink" onClick={() => void acceptAuditLog().catch(() => undefined)}>
                    {t('security.auditAccept')}
                  </button>
                ) : null}
                <button type="button" className="rounded-xl px-3 py-1.5 hover:text-ink" onClick={dismissAuditWarning}>
                  {t('common.close')}
                </button>
              </span>
            </div>
          ) : null}
          {(failuresSeen > 0 || checkFailuresSeen > 0) && !forced ? (
            <div role="status" data-testid="failures-seen-banner" className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-clay/50 bg-clay/10 px-4 py-3 text-sm text-clay-ink">
              <span className="min-w-0 space-y-1">
                {failuresSeen > 0 ? (
                  <span className="block">
                    {t('security.failuresSeen')} <strong className="tabular-nums">{failuresSeen}</strong>
                  </span>
                ) : null}
                {checkFailuresSeen > 0 ? (
                  <span className="block" data-testid="check-failures-seen">
                    {t('security.checkFailuresSeen')} <strong className="tabular-nums">{checkFailuresSeen}</strong>
                  </span>
                ) : null}
              </span>
              <button type="button" className="shrink-0 rounded-xl px-3 py-1.5 hover:text-ink" onClick={clearFailuresSeen}>
                {t('common.close')}
              </button>
            </div>
          ) : null}
          {recoveryLeft !== null && !forced ? (
            <div role="status" data-testid="recovery-used-banner" className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-brass/50 bg-brass-soft px-4 py-3 text-sm">
              <span className="min-w-0">
                {t('signInCheck.recoveryUsed')} <strong className="tabular-nums">{recoveryLeft}</strong>
              </span>
              <span className="flex shrink-0 gap-2">
                <Link to={ACCOUNT_PATH} className="rounded-xl border border-line bg-card px-3 py-1.5 font-medium hover:border-brass" onClick={clearRecoveryNotice}>
                  {t('signInCheck.title')}
                </Link>
                <button type="button" className="rounded-xl px-3 py-1.5 text-muted hover:text-ink" onClick={clearRecoveryNotice}>
                  {t('common.close')}
                </button>
              </span>
            </div>
          ) : null}
          {storageNearLimit && !forced ? (
            <div role="status" data-testid="storage-near-limit" className="mb-6 rounded-2xl border border-clay/50 bg-clay/10 px-4 py-3 text-sm text-clay-ink">
              {t('security.storageNear')}
            </div>
          ) : null}
          {reminder && !reminderDismissed && !forced ? (
            <div role="status" data-testid="backup-reminder" data-kind={reminder} className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-brass/50 bg-brass-soft px-4 py-3 text-sm">
              <span className="min-w-0">{t(reminder === 'never' ? 'backup.reminderNever' : 'backup.reminderStale')}</span>
              <span className="flex shrink-0 gap-2">
                <Link to="/app/backup" className="rounded-xl border border-line bg-card px-3 py-1.5 font-medium hover:border-brass" onClick={() => setReminderDismissed(true)}>
                  {t('backup.reminderAction')}
                </Link>
                <button type="button" className="rounded-xl px-3 py-1.5 text-muted hover:text-ink" onClick={() => setReminderDismissed(true)}>
                  {t('backup.dismiss')}
                </button>
              </span>
            </div>
          ) : null}
          <SafeProvider>{forced && location.pathname !== ACCOUNT_PATH ? <Navigate to={ACCOUNT_PATH} replace /> : <Outlet />}</SafeProvider>
        </main>
      </div>
    </PeriodProvider>
  )
}
