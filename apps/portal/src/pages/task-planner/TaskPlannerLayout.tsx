import { Navigate, Outlet } from 'react-router-dom'
import { AccessDenied } from '../../components/AccessDenied'
import { usePublishAppRoles } from '../../app/AppRoleContext'
import type { TpCapability } from '../../domain/task-planner/permissions'
import { useTaskPlannerRoles } from './useTaskPlannerRole'
import { useTpAutoSync } from './useTpAutoSync'
import { readViewAs } from '../../services/viewAs'

/**
 * Контейнер экранов Task Planner. Портальный Layout даёт голый <main>, а страницы
 * планировщика вёрстаны под ограниченную ширину с отступами (раньше это задавал
 * собственный layout апки). Держим здесь, чтобы не дублировать обёртку в каждом экране.
 *
 * Здесь же — гейт по ролям модуля (BAS-1509): без единой роли апка не показывает ничего.
 * Доступ к апке в портале (`applications`) сам по себе ролей не даёт — их назначают
 * в App Settings → Roles.
 *
 * Он же публикует роли оболочке (`usePublishAppRoles`), чтобы бургер-меню показывало
 * только доступные экраны (списки ролей у пунктов — в реестре, из матрицы прав).
 */
export function TaskPlannerLayout() {
  const { roles, loading } = useTaskPlannerRoles()
  usePublishAppRoles(loading ? null : roles)
  // Синк с Airtable при входе (не чаще раза в 10 минут) и его время в шапке портала.
  // В режиме View As синк не запускаем: просмотр ничего не меняет, даже через сервер.
  useTpAutoSync(!loading && roles.length > 0 && !readViewAs())

  if (loading) return <div className="p-10 text-gray-500">Loading…</div>
  if (!roles.length) {
    return (
      <AccessDenied reason="You have no Task Planner role yet. Ask an administrator to assign you one in the app settings (Roles)." />
    )
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] px-3 py-3 sm:px-6 sm:py-8">
      <Outlet />
    </div>
  )
}

/**
 * Гейт экрана по праву из матрицы (`domain/task-planner/permissions.ts`). Пункт меню
 * прячется отдельно (реестр), а прямая ссылка упирается сюда. Зеркало в БД — RLS 0028.
 */
export function RequireTpCapability({ cap, children }: { cap: TpCapability; children: React.ReactNode }) {
  const { can, loading } = useTaskPlannerRoles()
  if (loading) return <div className="p-10 text-gray-500">Loading…</div>
  if (!can(cap)) return <AccessDenied reason="Your Task Planner roles do not include this screen." />
  return <>{children}</>
}

/**
 * Корень апки (`/task-planner`). Карточка на «My Applications» ведёт сюда всех, отсюда —
 * на стартовый экран роли. Кто строит расписание (Schedule Manager, Admin) — Tasks.
 * PM и Lead Carpenter работают в основном со своими задачами — им My Tasks; Tasks у PM
 * остаётся в меню (Vlad 24.10.2026).
 */
export function PlannerHome() {
  const { can, roles, loading } = useTaskPlannerRoles()
  if (loading) return <div className="p-10 text-gray-500">Loading…</div>
  const buildsSchedule = roles.includes('schedule_manager') || roles.includes('admin')
  const home = can('view_own_side') && !buildsSchedule ? '/task-planner/my-tasks' : '/task-planner/tasks'
  return <Navigate to={home} replace />
}
