import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, ExternalLink } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { listUserApplications } from '../services/data'
import { openApp } from '../lib/sso'
import { Card } from '../components/ui'
import { HomeTabs } from '../components/HomeTabs'
import type { Application } from '../domain/types'

export function MyApplicationsPage() {
  // Тот же id, что в useAppAccess — иначе разойдутся ключи react-query (BUG-8).
  const { effectiveUserId: userId } = useAuth()

  const { data: apps = [], isLoading } = useQuery({
    queryKey: ['user-applications', userId],
    queryFn: () => listUserApplications(userId!),
    enabled: !!userId,
  })

  return (
    <>
      <HomeTabs />
      <div className="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-6 sm:py-8">
        {isLoading ? (
          <div className="py-16 text-center text-gray-400">Loading…</div>
        ) : !userId ? (
          <div className="py-16 text-center text-gray-400">
            No role assigned yet. Ask an administrator to assign you a role.
          </div>
        ) : apps.length === 0 ? (
          <div className="py-16 text-center text-gray-400">No applications available for your role.</div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
            {apps.map((app) => (
              <AppCard key={app.id} app={app} />
            ))}
          </div>
        )}
      </div>
    </>
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
    <Card className="flex flex-col items-center justify-between gap-3 p-3 text-center sm:gap-4 sm:p-5">
      <div className="text-sm font-semibold leading-snug text-gray-900 sm:text-base">{app.name}</div>
      <button
        onClick={open}
        disabled={!app.url}
        title={app.url ? undefined : 'Not deployed yet'}
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-gray-100 px-2 py-2 text-xs font-medium text-gray-700 transition hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50 sm:px-4 sm:text-sm"
      >
        Open
        {isInternal ? <ArrowRight size={14} /> : <ExternalLink size={14} />}
      </button>
    </Card>
  )
}
