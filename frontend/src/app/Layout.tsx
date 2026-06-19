import { useState } from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Menu, Plus, ListChecks, CalendarDays, Users, User, LogOut } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'

const SECTION_TITLES: Record<string, string> = {
  '/tasks': 'TASKS',
  '/create': 'CREATE TASK',
  '/availability': 'TEAMS AVAILABILITY',
  '/admin': 'ADMIN',
  '/profile': 'PROFILE',
}

export function Layout() {
  const [open, setOpen] = useState(false)
  const { user, signOut } = useAuth()
  const nav = useNavigate()
  const loc = useLocation()
  const section = SECTION_TITLES[loc.pathname] ?? 'TASKS'

  const menu = [
    { to: '/create', label: 'Create Task', icon: Plus },
    { to: '/tasks', label: 'Tasks', icon: ListChecks },
    { to: '/availability', label: 'Teams Availability', icon: CalendarDays },
    { to: '/admin', label: 'Admin', icon: Users },
    { to: '/profile', label: 'Profile', icon: User },
  ]

  return (
    <div className="min-h-full">
      <header className="relative flex items-center justify-between bg-brand-dark px-6 py-4 text-white">
        <div className="flex items-center gap-3">
          <div className="text-xl font-extrabold tracking-tight text-sky-400">BASEMENT<span className="text-white">REMODELING</span></div>
        </div>
        <h1 className="absolute left-1/2 -translate-x-1/2 text-lg font-semibold tracking-wide">
          DALY SCHEDULE — {section}
        </h1>
        <button
          onClick={() => setOpen((v) => !v)}
          className="rounded-md border border-white/30 p-2 hover:bg-white/10"
          aria-label="menu"
        >
          <Menu size={18} />
        </button>

        {open && (
          <div className="absolute right-4 top-16 z-20 w-64 rounded-lg border border-gray-200 bg-white py-2 text-gray-800 shadow-lg">
            {menu.map((m) => (
              <Link
                key={m.to}
                to={m.to}
                onClick={() => setOpen(false)}
                className="flex items-center gap-3 px-4 py-2 hover:bg-gray-50"
              >
                <m.icon size={16} /> {m.label}
              </Link>
            ))}
            <div className="my-2 border-t" />
            <div className="px-4 py-1 text-sm">
              <div className="font-medium">{user?.email}</div>
              <div className="text-xs uppercase text-gray-500">{user?.role}</div>
            </div>
            <button
              onClick={async () => {
                await signOut()
                nav('/login')
              }}
              className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-gray-50"
            >
              <LogOut size={16} /> Sign out
            </button>
          </div>
        )}
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  )
}
