import { Suspense, lazy, type ReactNode } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { BootError, LoginPage, SetupPage, Splash } from './components/AuthScreens'
import { UpdateBanner } from './components/UpdateBanner'
import { I18nProvider } from './context/I18nContext'
import { ThemeProvider } from './context/ThemeContext'
import { useVault, VaultProvider } from './context/VaultContext'

const Dashboard = lazy(() => import('./components/Dashboard').then((module) => ({ default: module.Dashboard })))
const Timeline = lazy(() => import('./components/Timeline').then((module) => ({ default: module.Timeline })))
const SettingsPage = lazy(() => import('./components/SettingsPage').then((module) => ({ default: module.SettingsPage })))
const UsersPage = lazy(() => import('./components/admin/UsersPage').then((module) => ({ default: module.UsersPage })))
const GroupsPage = lazy(() => import('./components/AdminPages').then((module) => ({ default: module.GroupsPage })))
const AuditPage = lazy(() => import('./components/AdminPages').then((module) => ({ default: module.AuditPage })))
const BackupPage = lazy(() => import('./components/AdminPages').then((module) => ({ default: module.BackupPage })))
const SafesHome = lazy(() => import('./components/safes/SafesHome').then((module) => ({ default: module.SafesHome })))
const SafeView = lazy(() => import('./components/safes/SafeView').then((module) => ({ default: module.SafeView })))
const SafesTrash = lazy(() => import('./components/safes/SafesTrash').then((module) => ({ default: module.SafesTrash })))
const SafesActivity = lazy(() => import('./components/safes/SafesActivity').then((module) => ({ default: module.SafesActivity })))
const AccountPage = lazy(() => import('./components/AccountPage').then((module) => ({ default: module.AccountPage })))
const RegisterPage = lazy(() => import('./components/auth/RegisterPage').then((module) => ({ default: module.RegisterPage })))

function Page({ children }: { children: ReactNode }) {
  return <Suspense fallback={<div role="status" aria-busy="true" className="min-h-40" />}>{children}</Suspense>
}

function pathFor(status: string): string {
  if (status === 'setup') return '/setup'
  if (status === 'locked' || status === 'challenge') return '/login'
  if (status === 'ready') return '/app'
  return '/'
}

type RouteStatus = 'setup' | 'locked' | 'challenge' | 'ready'

function RequireStatus({ expect, children }: { expect: RouteStatus | RouteStatus[]; children: ReactNode }) {
  const { status } = useVault()
  if (status === 'checking') return <Splash />
  const allowed: string[] = Array.isArray(expect) ? expect : [expect]
  if (!allowed.includes(status)) return <Navigate to={pathFor(status)} replace />
  return children
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
      <Routes>
        <Route path="/setup" element={<RequireStatus expect="setup"><SetupPage /></RequireStatus>} />
        <Route path="/login" element={<RequireStatus expect={['locked', 'challenge']}><LoginPage /></RequireStatus>} />
        <Route path="/register" element={<RequireStatus expect={['locked', 'setup']}><Suspense fallback={<Splash />}><RegisterPage /></Suspense></RequireStatus>} />
        <Route path="/app" element={<RequireStatus expect="ready"><AppShell /></RequireStatus>}>
          <Route index element={<Page><Dashboard /></Page>} />
          <Route path="transactions" element={<Page><Timeline /></Page>} />
          <Route path="users" element={<Page><UsersPage /></Page>} />
          <Route path="groups" element={<Page><GroupsPage /></Page>} />
          <Route path="audit" element={<Page><AuditPage /></Page>} />
          <Route path="backup" element={<Page><BackupPage /></Page>} />
          <Route path="settings" element={<Page><SettingsPage /></Page>} />
          <Route path="safes" element={<Page><SafesHome /></Page>} />
          <Route path="safes/trash" element={<Page><SafesTrash /></Page>} />
          <Route path="safes/activity" element={<Page><SafesActivity /></Page>} />
          <Route path="safes/:safeId" element={<Page><SafeView /></Page>} />
          <Route path="account" element={<Page><AccountPage /></Page>} />
        </Route>
        <Route path="*" element={<HomeRedirect />} />
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
