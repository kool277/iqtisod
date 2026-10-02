import { Suspense, lazy, type ReactNode } from 'react'
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { BootError, LoginPage, SetupPage, Splash } from './components/AuthScreens'
import { MoveNotice } from './components/MoveNotice'
import { NotFound } from './components/NotFound'
import { SupportFrame } from './components/SupportFrame'
import { UpdateBanner } from './components/UpdateBanner'
import { I18nProvider } from './context/I18nContext'
import { ThemeProvider } from './context/ThemeContext'
import { useVault, VaultProvider, type VaultLockReason } from './context/VaultContext'
import { RETURN_PARAM, loginPathFor, returnPath } from './lib/return-to'

const Dashboard = lazy(() => import('./components/Dashboard').then((module) => ({ default: module.Dashboard })))
const Timeline = lazy(() => import('./components/Timeline').then((module) => ({ default: module.Timeline })))
const SettingsPage = lazy(() => import('./components/SettingsPage').then((module) => ({ default: module.SettingsPage })))
const UsersPage = lazy(() => import('./components/admin/UsersPage').then((module) => ({ default: module.UsersPage })))
const UserDetailPage = lazy(() => import('./components/admin/UsersPage').then((module) => ({ default: module.UserDetailPage })))
const GroupsPage = lazy(() => import('./components/AdminPages').then((module) => ({ default: module.GroupsPage })))
const AuditPage = lazy(() => import('./components/AdminPages').then((module) => ({ default: module.AuditPage })))
const BackupPage = lazy(() => import('./components/AdminPages').then((module) => ({ default: module.BackupPage })))
const SafesHome = lazy(() => import('./components/safes/SafesHome').then((module) => ({ default: module.SafesHome })))
const SafeView = lazy(() => import('./components/safes/SafeView').then((module) => ({ default: module.SafeView })))
const SafesTrash = lazy(() => import('./components/safes/SafesTrash').then((module) => ({ default: module.SafesTrash })))
const SafesActivity = lazy(() => import('./components/safes/SafesActivity').then((module) => ({ default: module.SafesActivity })))
const AccountPage = lazy(() => import('./components/AccountPage').then((module) => ({ default: module.AccountPage })))
const RegisterPage = lazy(() => import('./components/auth/RegisterPage').then((module) => ({ default: module.RegisterPage })))
const HealthPage = lazy(() => import('./components/health/HealthPage').then((module) => ({ default: module.HealthPage })))
const HelpPage = lazy(() => import('./components/help/HelpPage').then((module) => ({ default: module.HelpPage })))

function Page({ children }: { children: ReactNode }) {
  return <Suspense fallback={<div role="status" aria-busy="true" className="min-h-40" />}>{children}</Suspense>
}

type Where = { pathname: string; search: string }

/**
 * Where a vault status belongs. A link opened while locked, or a page left by an idle lock, goes to sign-in
 * with a way back that sign-in then follows. **Lock** ends the visit, so whoever signs in next starts fresh.
 */
function pathFor(status: string, from?: Where, lockReason?: VaultLockReason | null): string {
  if (status === 'setup') return '/setup'
  if (status === 'locked' || status === 'challenge') return from?.pathname.startsWith('/app') && lockReason !== 'manual' ? loginPathFor(from.pathname, from.search) : '/login'
  if (status === 'ready') return (from?.pathname === '/login' && returnPath(new URLSearchParams(from.search).get(RETURN_PARAM))) || '/app'
  return '/'
}

type RouteStatus = 'setup' | 'locked' | 'challenge' | 'ready'

function RequireStatus({ expect, children }: { expect: RouteStatus | RouteStatus[]; children: ReactNode }) {
  const { status, lockReason } = useVault()
  const location = useLocation()
  if (status === 'checking') return <Splash />
  const allowed: string[] = Array.isArray(expect) ? expect : [expect]
  if (!allowed.includes(status)) return <Navigate to={pathFor(status, location, lockReason)} replace />
  return children
}

/** Help and the health check also open before sign-in; once the vault is open they move into the app. */
function BeforeSignIn({ inApp, children }: { inApp: string; children: ReactNode }) {
  const { status } = useVault()
  const location = useLocation()
  if (status === 'checking') return <Splash />
  if (status === 'ready') return <Navigate to={`${inApp}${location.search}`} replace />
  return <Suspense fallback={<Splash />}>{children}</Suspense>
}

function HomeRedirect() {
  const { status } = useVault()
  if (status === 'checking') return <Splash />
  return <Navigate to={pathFor(status)} replace />
}

function AppRoutes() {
  const { status, bootError } = useVault()
  if (status === 'error') return <BootError message={bootError ?? ''} />
  return (
    <>
      <UpdateBanner />
      <MoveNotice />
      <Routes>
        <Route path="/setup" element={<RequireStatus expect="setup"><SetupPage /></RequireStatus>} />
        <Route path="/login" element={<RequireStatus expect={['locked', 'challenge']}><LoginPage /></RequireStatus>} />
        <Route path="/register" element={<RequireStatus expect={['locked', 'setup']}><Suspense fallback={<Splash />}><RegisterPage /></Suspense></RequireStatus>} />
        <Route path="/health" element={<BeforeSignIn inApp="/app/health"><SupportFrame><HealthPage mode="standalone" /></SupportFrame></BeforeSignIn>} />
        <Route path="/help" element={<BeforeSignIn inApp="/app/help"><SupportFrame><HelpPage standalone /></SupportFrame></BeforeSignIn>} />
        <Route path="/app" element={<RequireStatus expect="ready"><AppShell /></RequireStatus>}>
          <Route index element={<Page><Dashboard /></Page>} />
          <Route path="transactions" element={<Page><Timeline /></Page>} />
          <Route path="users" element={<Page><UsersPage /></Page>} />
          <Route path="users/:userId" element={<Page><UserDetailPage /></Page>} />
          <Route path="groups" element={<Page><GroupsPage /></Page>} />
          <Route path="audit" element={<Page><AuditPage /></Page>} />
          <Route path="backup" element={<Page><BackupPage /></Page>} />
          <Route path="settings" element={<Page><SettingsPage /></Page>} />
          <Route path="safes" element={<Page><SafesHome /></Page>} />
          <Route path="safes/trash" element={<Page><SafesTrash /></Page>} />
          <Route path="safes/activity" element={<Page><SafesActivity /></Page>} />
          <Route path="safes/:safeId" element={<Page><SafeView /></Page>} />
          <Route path="account" element={<Page><AccountPage /></Page>} />
          <Route path="health" element={<Page><HealthPage /></Page>} />
          <Route path="help" element={<Page><HelpPage /></Page>} />
          <Route path="*" element={<NotFound />} />
        </Route>
        <Route path="/" element={<HomeRedirect />} />
        <Route path="*" element={<NotFound standalone />} />
      </Routes>
    </>
  )
}

export function App() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <VaultProvider>
          <HashRouter>
            <AppRoutes />
          </HashRouter>
        </VaultProvider>
      </I18nProvider>
    </ThemeProvider>
  )
}
