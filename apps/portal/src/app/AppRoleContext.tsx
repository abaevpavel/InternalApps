import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

/**
 * Внутренние роли текущей апки — канал «апка → оболочка портала».
 *
 * Портальный Layout не знает и не должен знать ролевую модель конкретной апки: апка сама
 * вычисляет роли пользователя (напр. Task Planner — `useTaskPlannerRoles()`) и публикует их
 * сюда через `usePublishAppRoles()`, а Layout лишь фильтрует пункты меню по `AppNavItem.appRoles`.
 * Ролей у человека может быть несколько (BAS-1509) — пункт виден, если совпала хоть одна.
 * Механизм общий — им воспользуется любая апка, у которой появятся свои виды
 * (`AppConfig.appRoles`).
 *
 * Почему публикация, а не обычный провайдер вокруг экранов апки: Layout стоит ВЫШЕ
 * роутов апки (он рендерит `<Outlet/>`), поэтому значение должно жить над ним, а
 * записывается снизу — из layout'а апки.
 *
 * Это только UI-слой (что показать в меню). Реальный контур допуска — гейты роутов + RLS.
 */
const AppRoleValue = createContext<string[] | null>(null)
const AppRoleSetter = createContext<(roles: string[] | null) => void>(() => {})

export function AppRoleProvider({ children }: { children: ReactNode }) {
  const [roles, setRoles] = useState<string[] | null>(null)
  return (
    <AppRoleSetter.Provider value={setRoles}>
      <AppRoleValue.Provider value={roles}>{children}</AppRoleValue.Provider>
    </AppRoleSetter.Provider>
  )
}

/** Роли внутри текущей апки; `null` — мы вне апки или роли ещё не вычислены. */
export function useCurrentAppRoles(): string[] | null {
  return useContext(AppRoleValue)
}

/** Апка объявляет свои роли оболочке. При уходе с экранов апки значение сбрасывается. */
export function usePublishAppRoles(roles: string[] | null): void {
  const set = useContext(AppRoleSetter)
  // Ключ по содержимому: новый массив с теми же ролями не должен дёргать оболочку.
  const key = roles ? roles.join(',') : null
  useEffect(() => {
    set(key === null ? null : key ? key.split(',') : [])
    return () => set(null)
  }, [key, set])
}
