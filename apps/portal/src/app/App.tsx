import { lazy } from 'react'
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { Providers } from './providers'
import { Layout } from './Layout'
import { useAuth } from '../auth/AuthProvider'
import { useAppAccess } from '../auth/useAppAccess'
import { Button } from '../components/ui'
// Ядро (первый экран) — eager: логин, список апок, аккаунт.
import { LoginPage } from '../pages/Login'
import { MyApplicationsPage } from '../pages/MyApplications'
import { MyAccountPage } from '../pages/MyAccount'

// Страницы апок — lazy: каждая апка в своём чанке, грузится только при переходе
// на её роут. Тяжёлые зависимости (@react-pdf, @dnd-kit, react-quill, Google Maps)
// уезжают из ядра. Компоненты — именованные экспорты → мапим в { default }.
const UserManagementPage = lazy(() => import('../pages/UserManagement').then((m) => ({ default: m.UserManagementPage })))
const AppSettingsPage = lazy(() => import('../pages/AppSettings').then((m) => ({ default: m.AppSettingsPage })))
const ProductionChecklistsPage = lazy(() => import('../pages/production-checklist/ProductionChecklists').then((m) => ({ default: m.ProductionChecklistsPage })))
const TemplateEditorPage = lazy(() => import('../pages/production-checklist/ProductionChecklistDetail').then((m) => ({ default: m.TemplateEditorPage })))
const ProjectChecklistPage = lazy(() => import('../pages/production-checklist/ProjectChecklistPage').then((m) => ({ default: m.ProjectChecklistPage })))
const EmployeeChecklistsPage = lazy(() => import('../pages/hr-checklists/EmployeeChecklists').then((m) => ({ default: m.EmployeeChecklistsPage })))
const ChecklistDetailPage = lazy(() => import('../pages/hr-checklists/ChecklistDetail').then((m) => ({ default: m.ChecklistDetailPage })))
const GmailAutoSenderPage = lazy(() => import('../pages/gmail-sender/GmailAutoSender').then((m) => ({ default: m.GmailAutoSenderPage })))
const SalesEmailSenderPage = lazy(() => import('../pages/sales/SalesEmailSender').then((m) => ({ default: m.SalesEmailSenderPage })))
const HRSyncAirtablePage = lazy(() => import('../pages/hr-sync/HRSyncAirtable').then((m) => ({ default: m.HRSyncAirtablePage })))
const SendBuildertrendSchedulePage = lazy(() => import('../pages/buildertrend-schedule/SendBuildertrendSchedule').then((m) => ({ default: m.SendBuildertrendSchedulePage })))
const TasksPage = lazy(() => import('../pages/task-planner/Tasks').then((m) => ({ default: m.TasksPage })))
const CreateTaskPage = lazy(() => import('../pages/task-planner/CreateTask').then((m) => ({ default: m.CreateTaskPage })))
const AvailabilityPage = lazy(() => import('../pages/task-planner/Availability').then((m) => ({ default: m.AvailabilityPage })))
const TaskPlannerAdminPage = lazy(() => import('../pages/task-planner/Admin').then((m) => ({ default: m.AdminPage })))
const TaskPlannerLayout = lazy(() => import('../pages/task-planner/TaskPlannerLayout').then((m) => ({ default: m.TaskPlannerLayout })))

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

/**
 * Per-app route-gate (правило 3): пускает на роут апки только тех, кому она выдана
 * ролью. Админ проходит всегда. Портальные страницы (`/`, `/account`, …) под этот
 * гейт не заведены — они снаружи. Обёртка на layout-роуте → `<Outlet />` внутри.
 */
function AppAccessGuard() {
  const { isAdmin } = useAuth()
  const { loading, canAccessPath } = useAppAccess()
  const { pathname } = useLocation()
  if (isAdmin) return <Outlet />
  if (loading) return <div className="p-10 text-gray-500">Loading…</div>
  if (!canAccessPath(pathname)) return <AccessDenied />
  return <Outlet />
}

function AccessDenied() {
  return (
    <div className="mx-auto max-w-lg px-6 py-24 text-center">
      <h2 className="text-2xl font-bold text-gray-900">Access denied</h2>
      <p className="mt-3 text-gray-500">
        You don’t have access to this application. Ask an administrator to grant your role
        access, then try again.
      </p>
      <div className="mt-8">
        <Button onClick={() => { window.location.href = '/' }}>Back to My Applications</Button>
      </div>
    </div>
  )
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
        {/* Портальные страницы — вне per-app гейта (свои гейты: Protected/AdminOnly). */}
        <Route path="/" element={<MyApplicationsPage />} />
        <Route path="/account" element={<MyAccountPage />} />
        <Route path="/users" element={<AdminOnly><UserManagementPage /></AdminOnly>} />
        <Route path="/settings/:appCode" element={<AdminOnly><AppSettingsPage /></AdminOnly>} />
        {/* Роуты приложений — за per-app route-gate (доступ по ролям, admin bypass). */}
        <Route element={<AppAccessGuard />}>
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
        </Route>
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
