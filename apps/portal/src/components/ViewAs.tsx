import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Eye, Loader2, LogOut, Search } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { listMyAppRoles } from '../services/app-user-roles'
import { appRoleLabel, endViewAs, listViewAsUsers, readViewAs, startViewAs, type ViewAsState, type ViewAsUser } from '../services/viewAs'
import { cn, errMsg } from '../lib/utils'

/** Сейчас портал открыт «как другой пользователь» (журнал в этом браузере + чужая сессия). */
export function useViewAs() {
  const { authUser } = useAuth()
  const state = readViewAs()
  const active = !!state && !!authUser && authUser.id === state.target.user_id
  return { active, state: active ? state : null }
}

function isDeveloper(roles: { name: string }[] | undefined) {
  return (roles ?? []).some((r) => r.name === 'Developer')
}

/**
 * Кнопка в шапке с выпадающим списком — у роли Developer. В режиме просмотра остаётся на месте
 * (сессия там чужая, поэтому смотрим на журнал): показывает, кого смотрим, даёт сменить
 * пользователя или выйти.
 */
export function ViewAsButton() {
  const { profile } = useAuth()
  const { active, state } = useViewAs()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!active && !isDeveloper(profile?.roles)) return null
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="View the portal as another user"
        aria-expanded={open}
        className={cn(
          'flex max-w-[14rem] items-center gap-1.5 rounded-md border px-2.5 py-2 text-xs font-medium',
          active ? 'border-amber-400 bg-amber-400 text-amber-950 hover:bg-amber-300' : 'border-white/30 hover:bg-white/10',
          open && !active && 'bg-white/10',
        )}
      >
        <Eye size={16} className="shrink-0" />
        <span className="hidden truncate sm:inline">{state ? state.target.name : 'View As'}</span>
        <ChevronDown size={14} className={cn('hidden transition sm:block', open && 'rotate-180')} />
      </button>
      {open && <ViewAsDropdown current={state} />}
    </div>
  )
}

function ViewAsDropdown({ current }: { current: ViewAsState | null }) {
  const users = useQuery({ queryKey: ['view-as-users'], queryFn: listViewAsUsers, staleTime: 60_000 })
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    const all = (users.data ?? []).filter((u) => u.user_id !== current?.target.user_id)
    if (!s) return all
    return all.filter((u) =>
      [u.name, u.email, ...u.portal_roles, ...u.app_roles.map((a) => appRoleLabel(a.app, a.role))]
        .some((x) => x.toLowerCase().includes(s)))
  }, [users.data, q])

  async function pick(u: ViewAsUser) {
    if (u.is_me && !current) return // это уже ты
    setBusy(u.user_id)
    setError(null)
    try {
      if (u.is_me) await endViewAs()
      else await startViewAs(u.user_id, u.name)
    } catch (e) {
      setError(errMsg(e))
      setBusy(null)
    }
  }

  return (
    // На телефоне — во всю ширину под шапкой, с sm — под кнопкой справа.
    <div className="fixed inset-x-3 top-16 z-40 overflow-hidden rounded-lg border border-gray-200 bg-white text-gray-800 shadow-xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-96">
      {current && <ExitRow current={current} />}
      <div className="border-b border-gray-100 p-2">
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && shown.length === 1) void pick(shown[0]) }}
            placeholder={current ? 'Switch to… name, email or role' : 'View as… name, email or role'}
            className="w-full rounded-md border border-gray-200 py-2 pl-9 pr-3 text-sm outline-none focus:border-brand-blue"
          />
        </div>
        <p className="mt-1.5 px-1 text-[11px] text-gray-400">The portal opens exactly as this user sees it. Read-only.</p>
      </div>
      {error && <p className="border-b border-gray-100 px-3 py-2 text-sm text-red-600">⚠ {error}</p>}
      <div className="max-h-[60vh] overflow-y-auto py-1">
        {users.isLoading && <p className="py-6 text-center text-sm text-gray-400">Loading users…</p>}
        {users.isError && <p className="px-3 py-2 text-sm text-red-600">⚠ {errMsg(users.error)}</p>}
        {shown.map((u) => (
          <button
            key={u.user_id}
            disabled={!!busy}
            // Роли — только подсказкой при наведении, в списке имя и почта.
            title={rolesText(u) || 'No roles'}
            onClick={() => pick(u)}
            className={cn(
              'flex w-full items-start gap-3 px-3 py-2 text-left transition hover:bg-gray-50 disabled:opacity-60',
              busy === u.user_id && 'bg-blue-50',
              u.is_me && 'border-b border-gray-100',
              u.is_me && !current && 'cursor-default hover:bg-transparent',
            )}
          >
            <span className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
              u.is_me ? 'bg-brand-blue text-white' : 'bg-gray-100 text-gray-600',
            )}>
              {initials(u.name)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium text-gray-900">{u.name}</span>
                {u.is_me && (
                  <span className="shrink-0 rounded bg-brand-blue/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-blue">
                    {current ? 'You · back to me' : 'You · current'}
                  </span>
                )}
              </span>
              <span className="block truncate text-xs text-gray-500">{u.email}</span>
            </span>
            {busy === u.user_id && <Loader2 size={16} className="mt-1 shrink-0 animate-spin text-brand-blue" />}
          </button>
        ))}
        {!users.isLoading && !users.isError && !shown.length && <p className="py-6 text-center text-sm text-gray-400">No users found.</p>}
      </div>
    </div>
  )
}

function ExitRow({ current }: { current: ViewAsState }) {
  const [leaving, setLeaving] = useState(false)
  return (
    <div className="flex items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-wide text-amber-700">Viewing as</div>
        <div className="truncate text-sm font-semibold text-amber-950">{current.target.name}</div>
        <div className="truncate text-xs text-amber-800/80">{current.target.email}</div>
      </div>
      <button
        disabled={leaving}
        onClick={() => { setLeaving(true); void endViewAs() }}
        title={`Back to ${current.developerEmail || 'my account'}`}
        className="flex shrink-0 items-center gap-1.5 rounded-md bg-amber-950 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-900 disabled:opacity-60"
      >
        {leaving ? <Loader2 size={14} className="animate-spin" /> : <LogOut size={14} />}
        Exit
      </button>
    </div>
  )
}

/** Полоса под шапкой на всех экранах, пока открыт просмотр. Выход и смена — в выпадающем списке View As. */
export function ViewAsBar() {
  const { profile, authUser } = useAuth()
  const { state } = useViewAs()
  const tpRoles = useQuery({
    queryKey: ['view-as-tp-roles', authUser?.id ?? null],
    queryFn: () => listMyAppRoles('task-planner', authUser!.id),
    enabled: !!state && !!authUser,
  })
  if (!state) return null
  const roles = [
    ...(profile?.roles ?? []).map((r) => r.name),
    ...(tpRoles.data ?? []).map((r) => appRoleLabel('task-planner', r)),
  ]
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 bg-amber-400 px-4 py-2 text-sm text-amber-950 sm:px-6">
      <Eye size={16} className="shrink-0" />
      <span>Viewing as <b>{state.target.name}</b></span>
      <span className="truncate text-amber-900/80">{state.target.email}</span>
      {roles.length > 0 && <span className="text-amber-900/80">· {roles.join(', ')}</span>}
      <span className="rounded bg-amber-950/10 px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide">Read-only</span>
    </div>
  )
}

function rolesText(u: ViewAsUser) {
  return [...u.portal_roles, ...u.app_roles.map((a) => appRoleLabel(a.app, a.role))].join(' · ')
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?'
}
