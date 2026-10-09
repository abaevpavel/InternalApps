import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { Card, Input } from '../components/ui'
import { cn, errMsg } from '../lib/utils'
import type { AppConfig } from '../app/appRegistry'
import { useAppRecord } from '../app/useAppRecord'
import { listProfiles, listRoles } from '../services/data'
import { listAppRoleAssignments, setUserAppRoles } from '../services/app-user-roles'
import { fetchTeamAccounts } from '../services/task-planner/data'
import type { Profile } from '../domain/types'

/**
 * App Settings → Roles (BAS-1509): кому какие роли ВНУТРИ апки. Отмечается галочками
 * на пользователя, ролей у человека может быть несколько. Хранится в `app_user_roles`
 * (миграция 0028); каждая отметка сохраняется сразу и попадает в историю портала.
 *
 * Доступ к самой апке выдаётся не здесь, а портальной ролью (Portal Settings → Roles).
 * По умолчанию список — те, у кого доступ есть, плюс те, у кого уже стоят роли;
 * остальных можно показать переключателем, у них будет пометка «no app access».
 */
export function AppRolesTab({ app }: { app: AppConfig }) {
  const qc = useQueryClient()
  const slots = app.appRoles ?? []
  const { record } = useAppRecord(app)
  const [showAll, setShowAll] = useState(false)
  const [search, setSearch] = useState('')

  const profilesQ = useQuery({ queryKey: ['profiles'], queryFn: listProfiles })
  const rolesQ = useQuery({ queryKey: ['roles'], queryFn: listRoles })
  const assignQ = useQuery({ queryKey: ['app-role-assignments', app.code], queryFn: () => listAppRoleAssignments(app.code) })
  // Task Planner: у Lead Carpenter бригада находится по email — показываем, нашлась ли.
  const isPlanner = app.code === 'task-planner'
  const crewsQ = useQuery({ queryKey: ['tp-team-accounts'], queryFn: fetchTeamAccounts, enabled: isPlanner })

  // Портальные роли, дающие доступ к апке.
  const accessRoleIds = useMemo(() => {
    if (!record) return new Set<string>()
    return new Set((rolesQ.data ?? []).filter((r) => r.applications.some((a) => a.id === record.id)).map((r) => r.id))
  }, [rolesQ.data, record])

  const crewByEmail = useMemo(
    () => new Map((crewsQ.data ?? []).filter((c) => c.email).map((c) => [c.email!.toLowerCase(), c.name])),
    [crewsQ.data],
  )

  const saveM = useMutation({
    mutationFn: (v: { userId: string; roles: string[]; current: string[] }) =>
      setUserAppRoles(app.code, v.userId, v.roles, v.current),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['app-role-assignments', app.code] })
      qc.invalidateQueries({ queryKey: ['app-user-roles', app.code] })
    },
  })

  if (!slots.length) {
    return <Card className="px-6 py-10 text-center text-sm text-gray-400">This app has no internal roles.</Card>
  }
  const error = profilesQ.error ?? rolesQ.error ?? assignQ.error
  if (error) return <Card className="px-6 py-10 text-center text-sm text-red-600">{errMsg(error)}</Card>
  if (profilesQ.isLoading || rolesQ.isLoading || assignQ.isLoading) {
    return <Card className="px-6 py-10 text-center text-sm text-gray-400">Loading…</Card>
  }

  const assignments = assignQ.data ?? new Map<string, string[]>()
  const hasAccess = (p: Profile) => p.roles.some((r) => accessRoleIds.has(r.id))
  const q = search.trim().toLowerCase()
  const users = (profilesQ.data ?? [])
    .filter((p): p is Profile & { user_id: string } => !!p.user_id)
    .filter((p) => showAll || hasAccess(p) || (assignments.get(p.user_id)?.length ?? 0) > 0)
    .filter((p) => !q || `${p.first_name ?? ''} ${p.last_name ?? ''} ${p.email}`.toLowerCase().includes(q))
    .sort((a, b) => displayName(a).localeCompare(displayName(b)))

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">
        What each person can do inside this app. A person may hold several roles. Access to the app itself is
        granted by a portal role in <span className="font-medium">Portal Settings → Roles</span>.
      </p>

      <ul className="space-y-1 text-xs text-gray-500">
        {slots.map((s) => (
          <li key={s.key}>
            <span className="font-medium text-gray-700">{s.short ?? s.label}</span>
            {s.short && s.short !== s.label && <span> ({s.label})</span>}
            {s.hint && <span> — {s.hint}</span>}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-3">
        <Input className="max-w-xs" placeholder="Search people…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-gray-600">
          <input type="checkbox" className="accent-brand-blue" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          Show people without access to the app
        </label>
        {saveM.error && <span className="text-sm text-red-600">{errMsg(saveM.error)}</span>}
      </div>

      {/* Компактный список: строка — человек, справа роли-переключатели. На узком экране
          переключатели уходят под имя. */}
      <Card className="divide-y divide-gray-100">
        {users.length === 0 && <div className="px-4 py-8 text-center text-sm text-gray-400">No people.</div>}
        {users.map((p) => {
          const current = assignments.get(p.user_id) ?? []
          const pending = saveM.isPending && saveM.variables?.userId === p.user_id
          const crew = crewByEmail.get(p.email.toLowerCase()) ?? null
          const name = displayName(p)
          const toggle = (key: string) => {
            const next = current.includes(key) ? current.filter((r) => r !== key) : [...current, key]
            saveM.mutate({ userId: p.user_id, roles: next, current })
          }
          return (
            <div key={p.user_id} className="flex flex-col gap-2 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-sm font-medium text-gray-900">{name}</span>
                  <span className="hidden truncate text-xs text-gray-400 md:inline">{p.email}</span>
                </div>
                <div className="flex flex-wrap items-center gap-x-2 text-xs">
                  <span className="truncate text-gray-400 md:hidden">{p.email}</span>
                  {!hasAccess(p) && <span className="text-amber-700">no app access</span>}
                  {/* Бригада — только если отличается от имени человека или не найдена. */}
                  {isPlanner && current.includes('lead_carpenter') && !crew && (
                    <span className="inline-flex items-center gap-1 text-amber-700">
                      <AlertTriangle size={11} /> no crew with this email
                    </span>
                  )}
                  {isPlanner && current.includes('lead_carpenter') && crew && crew !== name && (
                    <span className="text-gray-500">crew: {crew}</span>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {slots.map((s) => {
                  const on = current.includes(s.key)
                  return (
                    <button
                      key={s.key}
                      type="button"
                      title={s.label}
                      aria-pressed={on}
                      disabled={pending}
                      onClick={() => toggle(s.key)}
                      className={cn(
                        'rounded-full border px-2.5 py-1 text-xs font-medium transition disabled:opacity-50',
                        on
                          ? 'border-brand-blue bg-brand-blue text-white'
                          : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300 hover:text-gray-700',
                      )}
                    >
                      {s.short ?? s.label}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </Card>
    </div>
  )
}

function displayName(p: Profile): string {
  return [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || p.email
}
