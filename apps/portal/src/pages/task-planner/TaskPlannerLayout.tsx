import { Navigate, Outlet } from 'react-router-dom'
import { AccessDenied } from '../../components/AccessDenied'
import { usePublishAppRoles } from '../../app/AppRoleContext'
import type { TpCapability } from '../../domain/task-planner/permissions'
import { useTaskPlannerRoles } from './useTaskPlannerRole'

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

  if (loading) return <div className="p-10 text-gray-500">Loading…</div>
  if (!roles.length) {
    return (
      <AccessDenied reason="You have no Task Planner role yet. Ask an administrator to assign you one in the app settings (Roles)." />
    )
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-6 sm:py-8">
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
 * Корень апки (`/task-planner`). Карточка на «My Applications» ведёт сюда всех: кто видит
 * общее расписание — получает Tasks, Lead Carpenter без других ролей — свой My Tasks.
 */
export function PlannerHome({ scheduleScreen }: { scheduleScreen: React.ReactNode }) {
  const { can, loading } = useTaskPlannerRoles()
  if (loading) return <div className="p-10 text-gray-500">Loading…</div>
  if (can('view_schedule')) return <>{scheduleScreen}</>
  return <Navigate to="/task-planner/my-tasks" replace />
}
