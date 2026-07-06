import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Providers } from './providers'
import { Layout } from './Layout'
import { useAuth } from '../auth/AuthProvider'
import { LoginPage } from '../pages/Login'
import { TasksPage } from '../pages/Tasks'
import { CreateTaskPage } from '../pages/CreateTask'
import { AvailabilityPage } from '../pages/Availability'
import { AdminPage } from '../pages/Admin'
import { ProfilePage } from '../pages/Profile'

function Protected({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return <div className="p-10 text-gray-500">Loading…</div>
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

function Shell() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      {/* Хаб приложений теперь отдельный портал; корень ведёт сразу в планировщик */}
      <Route path="/" element={<Navigate to="/tasks" replace />} />
      {/* Task Planner — экраны под общим Layout */}
      <Route
        element={
          <Protected>
            <Layout />
          </Protected>
        }
      >
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/create" element={<CreateTaskPage />} />
        <Route path="/availability" element={<AvailabilityPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/profile" element={<ProfilePage />} />
      </Route>
      <Route path="*" element={<Navigate to="/tasks" replace />} />
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
