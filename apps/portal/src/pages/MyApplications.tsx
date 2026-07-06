import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, ExternalLink, UserCheck } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { listUserApplications } from '../services/data'
import { openApp } from '../lib/sso'
import { Card } from '../components/ui'
import type { Application } from '../domain/types'

export function MyApplicationsPage() {
  const { profile } = useAuth()
  const userId = profile?.user_id ?? null

  const { data: apps = [], isLoading } = useQuery({
    queryKey: ['user-applications', userId],
    queryFn: () => listUserApplications(userId!),
    enabled: !!userId,
  })

  return (
    <div className="mx-auto max-w-7xl px-6 py-10">
      <div className="mb-10 text-center">
        <h2 className="text-4xl font-bold tracking-tight text-gray-900">My Applications</h2>
        <p className="mt-2 text-gray-500">Access your workplace applications and tools</p>
      </div>

      {isLoading ? (
        <div className="py-16 text-center text-gray-400">Loading…</div>
      ) : !userId ? (
        <div className="py-16 text-center text-gray-400">
          No role assigned yet. Ask an administrator to assign you a role.
        </div>
      ) : apps.length === 0 ? (
        <div className="py-16 text-center text-gray-400">No applications available for your role.</div>
      ) : (
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {apps.map((app) => (
            <AppCard key={app.id} app={app} />
          ))}
        </div>
      )}
    </div>
  )
}

function AppCard({ app }: { app: Application }) {
  const nav = useNavigate()
  // Внутренние апки живут роутами портала (url = относительный путь, напр. «/production-checklist»)
  // и открываются навигацией в той же вкладке. Внешние (task-planner — своя БД/деплой) —
  // в новой вкладке с SSO-handoff.
  const isInternal = !!app.url && app.url.startsWith('/')

  function open() {
    if (!app.url) return
    if (isInternal) nav(app.url)
    else openApp(app.url)
  }

  return (
    <Card className="flex flex-col items-center gap-5 px-8 py-10 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-blue-100 text-brand-blue">
        <UserCheck size={28} />
      </div>
      <div className="min-h-[3.5rem] text-xl font-bold leading-snug text-gray-900">{app.name}</div>
      <button
        onClick={open}
        disabled={!app.url}
        title={app.url ? undefined : 'Not deployed yet'}
        className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-gray-100 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Open Application
        {isInternal ? <ArrowRight size={15} /> : <ExternalLink size={15} />}
      </button>
    </Card>
  )
}
