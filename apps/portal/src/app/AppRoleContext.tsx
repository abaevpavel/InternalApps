import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

/**
 * Внутренняя роль текущей апки — канал «апка → оболочка портала».
 *
 * Портальный Layout не знает и не должен знать ролевую модель конкретной апки: апка сама
 * вычисляет свой вид (напр. Task Planner — `useTaskPlannerRole()`) и публикует его сюда
 * через `usePublishAppRole()`, а Layout лишь фильтрует пункты меню по `AppNavItem.appRoles`.
 * Механизм общий — им воспользуется любая апка, у которой появятся свои виды
 * (`AppConfig.appRoles`).
 *
 * Почему публикация, а не обычный провайдер вокруг экранов апки: Layout стоит ВЫШЕ
 * роутов апки (он рендерит `<Outlet/>`), поэтому значение должно жить над ним, а
 * записывается снизу — из layout'а апки.
 *
 * Это только UI-слой (что показать в меню). Реальный контур допуска — гейты роутов + RLS.
 */
const AppRoleValue = createContext<string | null>(null)
const AppRoleSetter = createContext<(role: string | null) => void>(() => {})

export function AppRoleProvider({ children }: { children: ReactNode }) {
  const [role, setRole] = useState<string | null>(null)
  return (
    <AppRoleSetter.Provider value={setRole}>
      <AppRoleValue.Provider value={role}>{children}</AppRoleValue.Provider>
    </AppRoleSetter.Provider>
  )
}

/** Роль внутри текущей апки; `null` — мы вне апки или её вид ещё не вычислен. */
export function useCurrentAppRole(): string | null {
  return useContext(AppRoleValue)
}

/** Апка объявляет свой вид оболочке. При уходе с экранов апки значение сбрасывается. */
export function usePublishAppRole(role: string | null): void {
  const set = useContext(AppRoleSetter)
  useEffect(() => {
    set(role)
    return () => set(null)
  }, [role, set])
}
