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
import { EmployeeChecklistsPage } from '../pages/hr-checklists/EmployeeChecklists'
import { ChecklistDetailPage } from '../pages/hr-checklists/ChecklistDetail'
import { GmailAutoSenderPage } from '../pages/gmail-sender/GmailAutoSender'
import { SalesEmailSenderPage } from '../pages/sales/SalesEmailSender'
import { AppSettingsPage } from '../pages/AppSettings'
import { HRSyncAirtablePage } from '../pages/hr-sync/HRSyncAirtable'
import { SendBuildertrendSchedulePage } from '../pages/buildertrend-schedule/SendBuildertrendSchedule'
import { TasksPage } from '../pages/task-planner/Tasks'
import { CreateTaskPage } from '../pages/task-planner/CreateTask'
import { AvailabilityPage } from '../pages/task-planner/Availability'
import { AdminPage as TaskPlannerAdminPage } from '../pages/task-planner/Admin'
import { TaskPlannerLayout } from '../pages/task-planner/TaskPlannerLayout'

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
        <Route path="/checklists" element={<EmployeeChecklistsPage />} />
        <Route path="/checklist/:id" element={<ChecklistDetailPage />} />
        <Route path="/gmail-auto-sender" element={<GmailAutoSenderPage />} />
        <Route path="/sales-email-sender" element={<SalesEmailSenderPage />} />
        <Route path="/hr-sync-airtable" element={<HRSyncAirtablePage />} />
        <Route path="/buildertrend-schedule" element={<SendBuildertrendSchedulePage />} />
        {/* Task Planner (Daly Schedule) — роуты портала, общая БД (таблицы tp_*) */}
        <Route path="/task-planner" element={<TaskPlannerLayout />}>
          <Route index element={<TasksPage />} />
          <Route path="create" element={<CreateTaskPage />} />
          <Route path="availability" element={<AvailabilityPage />} />
          <Route path="admin" element={<TaskPlannerAdminPage />} />
        </Route>
        <Route path="/settings/:appCode" element={<AdminOnly><AppSettingsPage /></AdminOnly>} />
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
