import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Menu, ExternalLink, UserCog, Settings, LayoutGrid, LogOut, UserCheck } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'

/**
 * Портал «My Applications» — хаб рабочих приложений. Task Planner (Daly Schedule) —
 * одно из приложений (internalPath → открывается внутри этого же фронта).
 * Остальные карточки — внешние приложения портала (url); пока без ссылок (TBD).
 */
type AppEntry = {
  title: string
  /** внутренний роут (наш Task Planner) */
  internalPath?: string
  /** внешняя ссылка на другое приложение портала */
  url?: string
}

const APPS: AppEntry[] = [
  { title: 'Daly Schedule — Task Planner', internalPath: '/tasks' },
  { title: '06-HR-Checklists' },
  { title: '06-HR-Gmail Auto Sender' },
  { title: '02-Sales-Send an offer email' },
  { title: '03-Production-Send Buildertrend Schedule' },
  { title: '06-HR-Sync Airtable Contacts' },
  { title: '03-Production-Checklist' },
]

export function MyApplicationsPage() {
  const [open, setOpen] = useState(false)
  const { user, signOut } = useAuth()
  const nav = useNavigate()

  return (
    <div className="min-h-full bg-gray-50">
      {/* Header */}
      <header className="relative flex items-center justify-between bg-brand-dark px-6 py-4 text-white">
        <img src="/logo.png" alt="Basement Remodeling" className="h-9 w-auto" />
        <h1 className="absolute left-1/2 -translate-x-1/2 text-lg font-semibold tracking-wide">MY APPLICATIONS</h1>
        <button onClick={() => setOpen((v) => !v)} className="rounded-md border border-white/30 p-2 hover:bg-white/10" aria-label="menu">
          <Menu size={18} />
        </button>

        {open && (
          <div className="absolute right-4 top-16 z-20 w-72 rounded-lg border border-gray-200 bg-white py-2 text-gray-800 shadow-lg">
            <div className="px-4 py-2">
              <div className="text-xs text-gray-500">Signed in as</div>
              <div className="truncate text-sm font-medium">{user?.email}</div>
            </div>
            <div className="border-t" />
            <button onClick={() => { setOpen(false); nav('/profile') }} className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-gray-50">
              <Settings size={16} /> My Account
            </button>
            <button
              onClick={() => { setOpen(false); alert('User Management — coming soon (pending client decision, see MIGRATION.md §7).') }}
              className="flex w-full items-center gap-3 px-4 py-2 text-left text-gray-400 hover:bg-gray-50"
            >
              <UserCog size={16} /> User Management
            </button>
            <button onClick={() => { setOpen(false); nav('/') }} className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-gray-50">
              <LayoutGrid size={16} /> My Applications
            </button>
            <div className="my-1 border-t" />
            <button
              onClick={async () => { await signOut(); nav('/login') }}
              className="flex w-full items-center gap-3 px-4 py-2 text-left text-red-600 hover:bg-gray-50"
            >
              <LogOut size={16} /> Sign out
            </button>
          </div>
        )}
      </header>

      {/* Body */}
      <main className="mx-auto max-w-5xl px-6 py-10">
        <div className="mb-8 text-center">
          <h2 className="text-3xl font-bold text-gray-900">My Applications</h2>
          <p className="mt-1 text-gray-500">Access your workplace applications and tools</p>
        </div>

        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {APPS.map((app) => {
            const enabled = !!(app.internalPath || app.url)
            const open = () => {
              if (app.internalPath) nav(app.internalPath)
              else if (app.url) window.open(app.url, '_blank', 'noopener,noreferrer')
            }
            return (
              <div key={app.title} className="flex flex-col items-center rounded-xl border border-gray-200 bg-white p-6 text-center shadow-sm">
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-sky-50 text-sky-500">
                  <UserCheck size={26} />
                </div>
                <h3 className="mb-4 min-h-[3rem] font-semibold text-gray-900">{app.title}</h3>
                <button
                  onClick={open}
                  disabled={!enabled}
                  title={enabled ? '' : 'External app — link TBD'}
                  className={
                    'flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium ' +
                    (enabled ? 'bg-gray-100 text-gray-800 hover:bg-gray-200' : 'cursor-not-allowed bg-gray-50 text-gray-400')
                  }
                >
                  Open Application <ExternalLink size={15} />
                </button>
              </div>
            )
          })}
        </div>

        <p className="mt-8 text-center text-xs text-gray-400">
          Только Task Planner подключён. Остальные приложения портала — внешние (ссылки появятся при провязке).
        </p>
      </main>
    </div>
  )
}
