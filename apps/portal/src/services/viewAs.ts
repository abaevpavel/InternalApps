import { createClient } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

/**
 * View As (роль Developer, Vlad 24.10.2026): портал на время переключается на сессию
 * выбранного пользователя — меню, приложения, роли и данные ровно как у него. Сессию открывает
 * edge `view-as` и записывает в журнал, по которому база запрещает из неё любую запись
 * (миграция 0046). Своя сессия разработчика ждёт в этом браузере и возвращается по Exit.
 */
export interface ViewAsUser {
  /** Сам разработчик — первая строка списка, клик возвращает к себе. */
  is_me: boolean
  user_id: string
  email: string
  name: string
  portal_roles: string[]
  app_roles: { app: string; role: string }[]
}

export interface ViewAsState {
  target: { user_id: string; email: string; name: string }
  developerEmail: string
  /** Своя сессия разработчика — вернуть по Exit. */
  back: { access_token: string; refresh_token: string }
}

const KEY = 'portal.viewAs'

export function readViewAs(): ViewAsState | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as ViewAsState) : null
  } catch {
    return null
  }
}

function writeViewAs(s: ViewAsState | null) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s))
    else localStorage.removeItem(KEY)
  } catch { /* без localStorage вернуться можно только перелогином */ }
}

/** Отдельный клиент без сохранения: работа с чужой/своей сессией, не трогая сессию портала. */
function sideClient() {
  const url = import.meta.env.VITE_SUPABASE_URL as string
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string
  return createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
}

/**
 * Закрыть сессию просмотра только в этом браузере — в стороне, отдельным клиентом. Портал при
 * этом не остаётся без пользователя ни на миг (иначе на полсекунды мелькал бы экран входа).
 */
async function revokeSession(tokens: { access_token: string; refresh_token: string } | null) {
  if (!tokens) return
  try {
    const side = sideClient()
    const { error } = await side.auth.setSession(tokens)
    if (!error) await side.auth.signOut({ scope: 'local' })
  } catch { /* сессия уже недействительна — закрывать нечего */ }
}

async function currentTokens(): Promise<{ access_token: string; refresh_token: string } | null> {
  const { data } = await supabase!.auth.getSession()
  return data.session ? { access_token: data.session.access_token, refresh_token: data.session.refresh_token } : null
}

/** Заставка на время переключения — до перезагрузки страницы. */
function showSwitching(text: string) {
  const el = document.createElement('div')
  el.setAttribute('style', 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(17,24,39,.55);backdrop-filter:blur(2px);font:600 15px system-ui,sans-serif;color:#fff')
  el.textContent = text
  document.body.appendChild(el)
  return () => el.remove()
}

/**
 * Токен для edge: в режиме просмотра список и смену пользователя может запросить только сам
 * разработчик — берём его сохранённую сессию (отдельным клиентом, портал не переключается)
 * и, если её успели обновить, кладём свежие токены обратно.
 */
async function developerToken(): Promise<string> {
  const state = readViewAs()
  if (!state) {
    const { data } = await supabase!.auth.getSession()
    return data.session?.access_token ?? ''
  }
  const { data, error } = await sideClient().auth.setSession(state.back)
  if (error || !data.session) throw new Error('Your own session has expired — Exit and sign in again')
  writeViewAs({ ...state, back: { access_token: data.session.access_token, refresh_token: data.session.refresh_token } })
  return data.session.access_token
}

async function call<T>(body: Record<string, unknown>, token?: string): Promise<T> {
  if (!supabase) throw new Error('Supabase is not configured')
  const { data, error } = await supabase.functions.invoke('view-as', {
    body: { ...body, access_token: token ?? (await developerToken()) },
  })
  if (error) {
    // FunctionsHttpError прячет тело ответа в `context`
    const ctx = (error as { context?: Response }).context
    const detail = ctx && typeof ctx.json === 'function' ? await ctx.json().catch(() => null) : null
    throw new Error(detail?.error || error.message)
  }
  if (data?.error) throw new Error(data.error)
  return data as T
}

export async function listViewAsUsers(): Promise<ViewAsUser[]> {
  return (await call<{ users: ViewAsUser[] }>({ action: 'list' })).users
}

/** Начать просмотр; если он уже идёт — сразу переключиться на другого пользователя. */
export async function startViewAs(userId: string, targetName?: string): Promise<void> {
  if (!supabase) return
  const current = readViewAs()
  let developerEmail: string
  if (current) {
    developerEmail = current.developerEmail
  } else {
    const { data: own } = await supabase.auth.getSession()
    if (!own.session) throw new Error('Sign in first')
    developerEmail = own.session.user.email ?? ''
  }
  const hide = showSwitching(`Switching to ${targetName ?? 'user'}…`)
  try {
    const res = await call<{ access_token: string; refresh_token: string; target: ViewAsState['target'] }>({ action: 'start', user_id: userId })
    const previous = current ? await currentTokens() : null
    if (previous) await call({ action: 'end' }, previous.access_token).catch(() => {})
    // Своя сессия: при первом входе в просмотр — текущая; при смене — сохранённая (её мог обновить developerToken).
    const back = readViewAs()?.back ?? (await currentTokens())!
    writeViewAs({ target: res.target, developerEmail, back })
    const { error } = await supabase.auth.setSession({ access_token: res.access_token, refresh_token: res.refresh_token })
    if (error) {
      writeViewAs(current)
      throw error
    }
    await revokeSession(previous)
  } catch (e) {
    hide()
    throw e
  }
  // С чистого листа: кэш запросов и экраны — уже от имени выбранного пользователя.
  window.location.assign('/')
}

export async function endViewAs(): Promise<void> {
  const state = readViewAs()
  if (!supabase) return
  showSwitching(`Back to ${state?.developerEmail || 'your account'}…`)
  const viewing = await currentTokens()
  if (viewing) {
    // журнал не закрылся — сессия всё равно закрывается ниже и остаётся «только чтение»
    await call({ action: 'end' }, viewing.access_token).catch(() => {})
  }
  writeViewAs(null)
  const { error } = state?.back ? await supabase.auth.setSession(state.back) : { error: new Error('no session') }
  await revokeSession(viewing)
  window.location.assign(error ? '/login' : '/')
}

/** Роль модуля → подпись для людей. */
export function appRoleLabel(app: string, role: string): string {
  const roles: Record<string, string> = {
    pm: 'PM', schedule_manager: 'Schedule Manager', lead_carpenter: 'Lead Carpenter', admin: 'Admin',
  }
  const apps: Record<string, string> = { 'task-planner': 'Task Planner' }
  return `${apps[app] ?? app}: ${roles[role] ?? role}`
}

/* ---------------- Защита в браузере ---------------- */

/** Серверные функции, которые только читают, — в режиме просмотра их звать можно. */
const READ_ONLY_FUNCTIONS = new Set(['view-as', 'list-schedule-projects'])
export const VIEW_AS_BLOCKED_EVENT = 'portal:view-as-blocked'

/**
 * В режиме View As не выпускаем из браузера ничего, что меняет данные вне базы: вызовы
 * edge-функций (кроме читающих) и не-GET запросы во внешние сервисы (n8n, Make, Slack…).
 * Запись в саму базу и хранилище отклоняет база (миграция 0046), запросы к ним пропускаем.
 * Ставится один раз при старте; без режима просмотра ничего не меняет.
 */
export function installViewAsGuard() {
  if (!readViewAs()) return
  const base = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '') ?? ''
  const original = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (!readViewAs()) return original(input, init)
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    let blocked = false
    if (base && url.startsWith(base)) {
      const fn = /\/functions\/v1\/([^/?#]+)/.exec(url)?.[1]
      blocked = !!fn && !READ_ONLY_FUNCTIONS.has(fn)
    } else if (/^https?:/i.test(url) && new URL(url).origin !== window.location.origin) {
      blocked = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'
    }
    if (!blocked) {
      const res = original(input, init)
      // Запись в базу/хранилище отклонила база — то же уведомление на плашке.
      if (method !== 'GET' && method !== 'HEAD' && base && url.startsWith(base)) {
        void res.then((r) => {
          if (r.ok) return
          void r.clone().text().then((t) => {
            if (t.includes('View As is read-only')) window.dispatchEvent(new CustomEvent(VIEW_AS_BLOCKED_EVENT))
          }).catch(() => {})
        }).catch(() => {})
      }
      return res
    }
    window.dispatchEvent(new CustomEvent(VIEW_AS_BLOCKED_EVENT))
    return Promise.resolve(new Response(
      JSON.stringify({ error: 'View As is read-only: this action is not available while viewing as another user' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    ))
  }
}
