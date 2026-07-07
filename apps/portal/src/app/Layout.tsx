import { useEffect, useRef, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { LayoutGrid, LogOut, Menu, Settings, SlidersHorizontal, Users } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { appForPath } from './appRegistry'

/** Заголовок хедера по маршруту (как в оригинале: страница = свой титул). */
const TITLES: [prefix: string, title: string][] = [
  ['/account', 'MY ACCOUNT'],
  ['/users', 'USER MANAGEMENT'],
  ['/production-checklist', '03-PRODUCTION-CHECKLIST'],
  ['/checklist', '06-HR-CHECKLISTS'],
  ['/gmail-auto-sender', '06-HR-GMAIL AUTO SENDER'],
  ['/sales-email-sender', '02-SALES-SEND AN OFFER EMAIL'],
  ['/hr-sync-airtable', '06-HR-SYNC AIRTABLE CONTACTS'],
  ['/', 'MY APPLICATIONS'],
]

export function Layout() {
  const { authUser, isAdmin, signOut } = useAuth()
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const nav = useNavigate()
  const { pathname } = useLocation()
  const title = TITLES.find(([p]) => pathname.startsWith(p) && p !== '/')?.[1] ?? 'MY APPLICATIONS'
  const currentApp = appForPath(pathname) // для контекстного пункта App Settings

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
    <div className="flex min-h-full flex-col">
      <header className="relative z-30 flex items-center justify-between bg-brand-dark px-6 py-4 text-white">
        <button onClick={() => nav('/')} aria-label="Go to My Applications" className="rounded transition hover:opacity-80">
          <img src="/logo.png" alt="Basement Remodeling" className="h-9 w-auto" />
        </button>
        <h1 className="absolute left-1/2 -translate-x-1/2 text-lg font-semibold tracking-wide">{title}</h1>
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
                <div className="truncate text-sm font-medium text-brand-blue">{authUser?.email}</div>
              </div>
              <div className="border-t" />
              <MenuItem icon={<Settings size={16} />} label="My Account" onClick={() => go('/account')} />
              {isAdmin && <MenuItem icon={<Users size={16} />} label="User Management" onClick={() => go('/users')} />}
              {isAdmin && currentApp && (
                <MenuItem
                  icon={<SlidersHorizontal size={16} />}
                  label="App Settings"
                  onClick={() => go(`/settings/${currentApp.code}`)}
                />
              )}
              <MenuItem icon={<LayoutGrid size={16} />} label="My Applications" onClick={() => go('/')} />
              <div className="border-t" />
              <MenuItem
                icon={<LogOut size={16} />}
                label="Sign out"
                className="text-red-600 hover:bg-red-50"
                onClick={() => {
                  setOpen(false)
                  signOut()
                }}
              />
            </div>
          )}
        </div>
      </header>

      <main className="flex-1">
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
