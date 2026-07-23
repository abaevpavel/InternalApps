import { useCallback, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from './AuthProvider'
import { listUserApplications } from '../services/data'
import { APPS, appForPath } from '../app/appRegistry'
import type { Application } from '../domain/types'

/**
 * Per-app route-gate (правило 3 из README): доступ к роуту апки = у юзера есть
 * `applications`-строка, ведущая на эту апку. Карточки на главной уже фильтруются
 * этим же списком — тут та же выборка (тот же react-query ключ → без лишнего запроса),
 * применённая к роутам. Admin-bypass решается на уровне обёртки (`AppAccessGuard`).
 */

/** Строка `applications` → код апки из appRegistry. */
export function codeForApplication(app: Application): string | null {
  // 1) по url. Внутренние апки — относительный путь ('/checklists'); внешние
  //    (Task Planner) — абсолютный URL, из него берём pathname.
  if (app.url) {
    let path = app.url
    if (!path.startsWith('/')) {
      try {
        path = new URL(app.url).pathname
      } catch {
        path = ''
      }
    }
    const byPath = path ? appForPath(path) : null
    if (byPath) return byPath.code
  }
  // 2) фолбэк по имени ↔ label реестра (напр. «01-Task Planner (Daly Schedule)»,
  //    когда у внешней апки url без узнаваемого pathname).
  if (app.name) {
    const byName = APPS.find((a) => a.label === app.name)
    if (byName) return byName.code
  }
  return null
}

export function useAppAccess() {
  const { profile } = useAuth()
  const userId = profile?.user_id ?? null

  const { data: apps = [], isLoading } = useQuery({
    queryKey: ['user-applications', userId],
    queryFn: () => listUserApplications(userId!),
    enabled: !!userId,
  })

  const codes = useMemo(
    () => new Set(apps.map(codeForApplication).filter((c): c is string => !!c)),
    [apps],
  )

  /**
   * Пускать ли на путь. Портальные страницы (`/`, `/account`, `/users`, `/settings/*`)
   * не принадлежат ни одной апке (`appForPath` → null) → всегда true; их доступ
   * решают отдельные гейты (Protected/AdminOnly). App-роут доступен, только если код
   * его апки есть в наборе доступных.
   */
  const canAccessPath = useCallback(
    (pathname: string) => {
      const cfg = appForPath(pathname)
      if (!cfg) return true
      return codes.has(cfg.code)
    },
    [codes],
  )

  return { loading: isLoading && !!userId, canAccessPath, apps }
}
