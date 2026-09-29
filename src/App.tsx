import type { ReactNode } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuditPage, BackupPage, GroupsPage, UsersPage } from './components/AdminPages'
import { AppShell } from './components/AppShell'
import { BootError, LoginPage, SetupPage, Splash } from './components/AuthScreens'
import { Dashboard } from './components/Dashboard'
import { SettingsPage } from './components/SettingsPage'
import { Timeline } from './components/Timeline'
import { I18nProvider } from './context/I18nContext'
import { ThemeProvider } from './context/ThemeContext'
import { useVault, VaultProvider } from './context/VaultContext'

function pathFor(status: string): string {
  if (status === 'setup') return '/setup'
  if (status === 'locked') return '/login'
  if (status === 'ready') return '/app'
  return '/'
}

function RequireStatus({ expect, children }: { expect: 'setup' | 'locked' | 'ready'; children: ReactNode }) {
  const { status } = useVault()
  if (status === 'checking') return <Splash />
  if (status !== expect) return <Navigate to={pathFor(status)} replace />
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
    <Routes>
      <Route path="/setup" element={<RequireStatus expect="setup"><SetupPage /></RequireStatus>} />
      <Route path="/login" element={<RequireStatus expect="locked"><LoginPage /></RequireStatus>} />
      <Route path="/app" element={<RequireStatus expect="ready"><AppShell /></RequireStatus>}>
        <Route index element={<Dashboard />} />
        <Route path="transactions" element={<Timeline />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="groups" element={<GroupsPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="backup" element={<BackupPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<HomeRedirect />} />
    </Routes>
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
