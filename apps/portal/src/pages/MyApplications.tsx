import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, ExternalLink, LayoutGrid, List } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { listUserApplications } from '../services/data'
import { getPreferences, saveHomeView, type HomeView } from '../services/preferences'
import { openApp } from '../lib/sso'
import { Card } from '../components/ui'
import { cn } from '../lib/utils'
import { HomeTabs } from '../components/HomeTabs'
import type { Application } from '../domain/types'
import { displayAppName, groupByDepartment } from '../domain/departments'
import { CollapseAllControls, CollapseGroup, CollapsibleCard } from '../components/Collapsible'

export function MyApplicationsPage() {
  // Тот же id, что в useAppAccess — иначе разойдутся ключи react-query (BUG-8).
  const { effectiveUserId: userId } = useAuth()

  const [view, setView] = useHomeView(userId)

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
          // BAS-1681: блоки по департаментам по возрастанию, без департамента — последним.
          <CollapseGroup storageKey="home.departments">
            <div className="mb-2 flex items-center justify-between gap-3">
              <ViewSwitch value={view} onChange={setView} />
              <CollapseAllControls />
            </div>
            <div className="space-y-4">
              {groupByDepartment(apps).map((g) => (
                <CollapsibleCard
                  key={g.key}
                  id={g.key}
                  className="bg-transparent shadow-none border-0"
                  headerClassName="px-1 py-2"
                  bodyClassName="pt-1"
                  header={
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold uppercase tracking-wide text-gray-700">{g.label}</span>
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">{g.apps.length}</span>
                    </div>
                  }
                >
                  {view === 'cards' ? (
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
                      {g.apps.map((app) => (
                        <AppCard key={app.id} app={app} />
                      ))}
                    </div>
                  ) : (
                    <Card className="divide-y divide-gray-100">
                      {g.apps.map((app) => (
                        <AppRow key={app.id} app={app} />
                      ))}
                    </Card>
                  )}
                </CollapsibleCard>
              ))}
            </div>
          </CollapseGroup>
        )}
      </div>
    </>
  )
}

/**
 * Вид главной — карточки или список — хранится за пользователем в базе
 * (`user_preferences`), поэтому одинаков на любом компьютере. Пока ответ базы не пришёл,
 * показываем последний выбор из этого браузера (кэш), чтобы вид не мигал. Если запись в
 * базу не удалась (миграция ещё не применена и т.п.) — выбор всё равно работает в этом
 * браузере.
 */
function useHomeView(userId: string | null): [HomeView, (v: HomeView) => void] {
  const qc = useQueryClient()
  const cacheKey = `portal.home.view.${userId ?? 'anon'}`
  const cached = (): HomeView => {
    try {
      return localStorage.getItem(cacheKey) === 'list' ? 'list' : 'cards'
    } catch {
      return 'cards'
    }
  }
  const { authUser } = useAuth()
  const q = useQuery({ queryKey: ['user-preferences', authUser?.id ?? null], queryFn: getPreferences, enabled: !!authUser, retry: false, staleTime: 60_000 })
  const [local, setLocal] = useState<{ key: string; view: HomeView } | null>(null)

  const view: HomeView = local?.key === cacheKey ? local.view : q.data?.homeView ?? cached()

  const saveM = useMutation({ mutationFn: saveHomeView, onSuccess: () => qc.invalidateQueries({ queryKey: ['user-preferences'] }) })

  const set = (v: HomeView) => {
    setLocal({ key: cacheKey, view: v })
    try {
      localStorage.setItem(cacheKey, v)
    } catch {
      // не критично
    }
    saveM.mutate(v)
  }
  return [view, set]
}

function ViewSwitch({ value, onChange }: { value: HomeView; onChange: (v: HomeView) => void }) {
  const item = (v: HomeView, label: string, Icon: typeof List) => (
    <button
      type="button"
      onClick={() => onChange(v)}
      aria-pressed={value === v}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition',
        value === v ? 'bg-white text-gray-900 shadow-card' : 'text-gray-500 hover:text-gray-700',
      )}
    >
      <Icon size={15} /> {label}
    </button>
  )
  return (
    <div className="inline-flex gap-1 rounded-lg bg-gray-100 p-1">
      {item('cards', 'Cards', LayoutGrid)}
      {item('list', 'List', List)}
    </div>
  )
}

/**
 * Как открыть апку. Внутренние живут роутами портала (url = относительный путь, напр.
 * «/production-checklist») и открываются навигацией в той же вкладке. Внешние
 * (task-planner — своя БД/деплой) — в новой вкладке с SSO-handoff.
 */
function useOpenApp(app: Application) {
  const nav = useNavigate()
  const isInternal = !!app.url && app.url.startsWith('/')
  const open = () => {
    if (!app.url) return
    if (isInternal) nav(app.url)
    else openApp(app.url)
  }
  return { isInternal, open }
}

function AppRow({ app }: { app: Application }) {
  const { isInternal, open } = useOpenApp(app)
  return (
    <button
      type="button"
      onClick={open}
      disabled={!app.url}
      title={app.url ? undefined : 'Not deployed yet'}
      className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="text-sm font-medium text-gray-900">{displayAppName(app.name, app.department)}</span>
      {/* Внешняя апка открывается в новой вкладке — это стоит показать; внутренние без значка. */}
      {!isInternal && <ExternalLink size={14} className="shrink-0 text-gray-400" />}
    </button>
  )
}

function AppCard({ app }: { app: Application }) {
  const { isInternal, open } = useOpenApp(app)

  return (
    <Card className="flex flex-col items-center justify-between gap-3 p-3 text-center sm:gap-4 sm:p-5">
      <div className="text-sm font-semibold leading-snug text-gray-900 sm:text-base">{displayAppName(app.name, app.department)}</div>
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
