import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Providers } from './providers'
import { Layout } from './Layout'
import { useAuth } from '../auth/AuthProvider'
import { LoginPage } from '../pages/Login'
import { MyApplicationsPage } from '../pages/MyApplications'
import { MyAccountPage } from '../pages/MyAccount'
import { UserManagementPage } from '../pages/UserManagement'
import { ProductionChecklistsPage } from '../pages/production-checklist/ProductionChecklists'
import { TemplateEditorPage } from '../pages/production-checklist/ProductionChecklistDetail'
import { ProjectChecklistPage } from '../pages/production-checklist/ProjectChecklistPage'

function Protected({ children }: { children: React.ReactNode }) {
  const { authUser, profile, denied, loading } = useAuth()
  if (loading) return <div className="p-10 text-gray-500">Loading…</div>
  // denied (email не в whitelist) обрабатывает LoginPage
  if (!authUser || denied || !profile) return <Navigate to="/login" replace />
  return <>{children}</>
}

function AdminOnly({ children }: { children: React.ReactNode }) {
  const { isAdmin } = useAuth()
  if (!isAdmin) return <Navigate to="/" replace />
  return <>{children}</>
}

function Shell() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <Protected>
            <Layout />
          </Protected>
        }
      >
        <Route path="/" element={<MyApplicationsPage />} />
        <Route path="/account" element={<MyAccountPage />} />
        <Route path="/users" element={<AdminOnly><UserManagementPage /></AdminOnly>} />
        <Route path="/production-checklist" element={<ProductionChecklistsPage />} />
        <Route path="/production-checklist/project/:projectId" element={<ProjectChecklistPage />} />
        <Route path="/production-checklist/:id" element={<TemplateEditorPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export function App() {
  return (
    <Providers>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </Providers>
  )
}
