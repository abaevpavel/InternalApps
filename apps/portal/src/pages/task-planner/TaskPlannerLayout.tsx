import { Navigate, Outlet } from 'react-router-dom'
import { AccessDenied } from '../../components/AccessDenied'
import { usePublishAppRole } from '../../app/AppRoleContext'
import { useTaskPlannerRole } from './useTaskPlannerRole'

/**
 * Контейнер экранов Task Planner. Портальный Layout даёт голый <main>, а страницы
 * планировщика вёрстаны под ограниченную ширину с отступами (раньше это задавал
 * собственный layout апки). Держим здесь, чтобы не дублировать обёртку в каждом экране.
 *
 * Здесь же — гейт по виду апки: у планировщика ровно два вида (Planner Admin и Team Lead),
 * и если пользователю не назначен ни один, апка не показывает ничего. Доступ к апке в
 * портале (`applications`) сам по себе вида не даёт — его назначают в
 * App Settings → Roles либо совпадением email со строкой в `tp_teams`.
 *
 * Он же публикует вид оболочке (`usePublishAppRole`), чтобы бургер-меню показывало
 * бригадиру только его экраны: планировочные пункты помечены в реестре `appRoles: ['admin']`.
 */
export function TaskPlannerLayout() {
  const { role, loading } = useTaskPlannerRole()
  usePublishAppRole(loading ? null : role)

  if (loading) return <div className="p-10 text-gray-500">Loading…</div>
  if (role === 'none') {
    return (
      <AccessDenied reason="No Task Planner view is assigned to your role. Ask an administrator to grant you Planner Admin or Team Lead in the app settings." />
    )
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <Outlet />
    </div>
  )
}

/**
 * Гейт админских экранов апки. Отличается от портального `AdminOnly` тем, что смотрит на
 * ВИД ВНУТРИ АПКИ: Planner Admin может быть выдан ролью в App Settings → Roles, не будучи
 * админом портала. `AppAccessGuard` этого не закрывает — он различает апки целиком.
 * Зеркало этого условия в БД — `tp_is_planner_admin()` (миграция 0008).
 */
export function PlannerAdminOnly({ children }: { children: React.ReactNode }) {
  const { role, loading } = useTaskPlannerRole()
  if (loading) return <div className="p-10 text-gray-500">Loading…</div>
  if (role !== 'admin') {
    return <AccessDenied reason="This screen is available to Planner Admins only." />
  }
  return <>{children}</>
}

/**
 * Корень апки (`/task-planner`). Карточка на «My Applications» ведёт сюда всех, поэтому
 * бригадира отправляем на его рабочий экран, а не показываем Access denied на планировочном.
 */
export function PlannerHome({ adminScreen }: { adminScreen: React.ReactNode }) {
  const { role, loading } = useTaskPlannerRole()
  if (loading) return <div className="p-10 text-gray-500">Loading…</div>
  if (role === 'admin') return <>{adminScreen}</>
  return <Navigate to="/task-planner/my-tasks" replace />
}
