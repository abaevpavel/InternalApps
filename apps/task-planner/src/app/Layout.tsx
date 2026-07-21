import { useEffect, useRef, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  Menu, Plus, ListChecks, CalendarDays, Users, Settings, SlidersHorizontal, LogOut, LayoutGrid,
} from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { goToPortal } from '../lib/portal'

const SECTION_TITLES: Record<string, string> = {
  '/tasks': 'TASKS',
  '/create': 'CREATE TASK',
  '/availability': 'TEAMS AVAILABILITY',
  '/admin': 'ADMIN',
  '/profile': 'MY ACCOUNT',
  '/settings': 'APP SETTINGS',
}

export function Layout() {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const { user, signOut } = useAuth()
  const nav = useNavigate()
  const loc = useLocation()
  const section = SECTION_TITLES[loc.pathname] ?? 'TASKS'
  const isAdmin = user?.role === 'super_admin' || user?.role === 'pm'

  // Клик вне меню закрывает его — как в портале.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  function go(path: string) {
    setOpen(false)
    nav(path)
  }

  return (
    <div className="min-h-full">
      <header className="relative z-30 flex items-center justify-between bg-brand-dark px-6 py-4 text-white">
        {/* Лого — возврат на главную портала (внешний origin, не роут этой апки) */}
        <button
          onClick={() => goToPortal('/')}
          aria-label="Go to My Applications"
          className="rounded transition hover:opacity-80"
        >
          <img src="/logo.png" alt="Basement Remodeling" className="h-9 w-auto" />
        </button>
        <h1 className="absolute left-1/2 -translate-x-1/2 text-lg font-semibold tracking-wide">
          DALY SCHEDULE — {section}
        </h1>
        <div ref={menuRef}>
          <button
            onClick={() => setOpen((v) => !v)}
            className="rounded-md border border-white/30 p-2 hover:bg-white/10"
            aria-label="menu"
          >
            <Menu size={18} />
          </button>

          {open && (
            <div className="absolute right-4 top-16 w-72 rounded-lg border border-gray-200 bg-white py-2 text-gray-800 shadow-lg">
              <div className="px-4 py-2">
                <div className="text-xs text-gray-500">Signed in as</div>
                <div className="truncate text-sm font-medium text-brand-blue">{user?.email}</div>
                {user?.role && <div className="text-xs uppercase text-gray-500">{user.role}</div>}
              </div>
              <div className="border-t" />

              {/* Экраны самого приложения */}
              <MenuItem icon={<ListChecks size={16} />} label="Tasks" onClick={() => go('/tasks')} />
              <MenuItem icon={<Plus size={16} />} label="Create Task" onClick={() => go('/create')} />
              <MenuItem icon={<CalendarDays size={16} />} label="Teams Availability" onClick={() => go('/availability')} />
              {isAdmin && <MenuItem icon={<Users size={16} />} label="Admin" onClick={() => go('/admin')} />}
              <div className="border-t" />

              {/* Общий для всех апок портала блок */}
              <MenuItem icon={<Settings size={16} />} label="My Account" onClick={() => go('/profile')} />
              {isAdmin && (
                <MenuItem icon={<SlidersHorizontal size={16} />} label="App Settings" onClick={() => go('/settings')} />
              )}
              <MenuItem icon={<LayoutGrid size={16} />} label="My Applications" onClick={() => goToPortal('/')} />
              <div className="border-t" />
              <MenuItem
                icon={<LogOut size={16} />}
                label="Sign out"
                className="text-red-600 hover:bg-red-50"
                onClick={async () => {
                  setOpen(false)
                  await signOut()
                  nav('/login')
                }}
              />
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  )
}

function MenuItem({
  icon, label, onClick, className,
}: { icon: React.ReactNode; label: string; onClick: () => void; className?: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-3 px-4 py-2.5 text-sm hover:bg-gray-50 ${className ?? ''}`}
    >
      {icon}
      {label}
    </button>
  )
}
