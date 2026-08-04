import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../../auth/AuthProvider'
import { fetchTeamByEmail } from '../../services/task-planner/data'
import { getAppRoleIds } from '../../services/app-settings'

/**
 * Роль пользователя ВНУТРИ Task Planner.
 *
 * Апка не держит собственный реестр ролей (правило 3 платформы) — роль складывается из
 * настройки и данных:
 *   1. админ портала                                  → `admin`     (всегда, без настройки)
 *   2. портальная роль ∈ App Settings → Roles → admin → `admin`
 *   3. email юзера совпал с tp_teams.email            → `team_lead`
 *   4. портальная роль ∈ …Roles → team_lead           → `team_lead`
 *   5. остальные                                      → `none`      (в апку не пускаем)
 *
 * Видов ровно два. Если пользователю не досталось ни одного — апка не показывает ничего
 * (`TaskPlannerGuard` → Access denied): доступ к апке в портале сам по себе вида не даёт.
 *
 * Настраивается на `/settings/task-planner` → вкладка **Roles** (маппинг «внутренняя роль
 * апки → портальные роли», лежит в `app_settings.roles_<slot>`).
 *
 * Тот же признак «моя бригада» продублирован в БД функцией `tp_my_team_id()`
 * (миграция 0006) — гейт обязан быть на обоих слоях, UI без RLS обходится.
 */
export type TaskPlannerRole = 'admin' | 'team_lead' | 'none'

export interface TaskPlannerAccess {
  role: TaskPlannerRole
  /** tp_teams.id своей бригады — только у team_lead, иначе null. */
  teamId: string | null
  teamName: string | null
  loading: boolean
}

const APP_CODE = 'task-planner'

export function useTaskPlannerRole(): TaskPlannerAccess {
  const { authUser, profile, isAdmin } = useAuth()
  const email = authUser?.email?.toLowerCase() ?? null
  const myRoleIds = (profile?.roles ?? []).map((r) => r.id)

  // Маппинг «внутренняя роль → портальные роли» из настроек апки. Админу не нужен:
  // его вид известен сразу.
  const { data: adminRoleIds = [], isLoading: loadingAdminIds } = useQuery({
    queryKey: ['app-role-ids', APP_CODE, 'admin'],
    queryFn: () => getAppRoleIds(APP_CODE, 'admin'),
    enabled: !isAdmin,
    staleTime: 5 * 60 * 1000,
  })
  const { data: leadRoleIds = [], isLoading: loadingLeadIds } = useQuery({
    queryKey: ['app-role-ids', APP_CODE, 'team_lead'],
    queryFn: () => getAppRoleIds(APP_CODE, 'team_lead'),
    enabled: !isAdmin,
    staleTime: 5 * 60 * 1000,
  })

  const byRoleAdmin = myRoleIds.some((id) => adminRoleIds.includes(id))

  // Бригаду ищем, только если юзер ещё не признан админом — иначе запрос не нужен.
  const { data: mine, isLoading: loadingTeam } = useQuery({
    queryKey: ['tp-my-team', email],
    queryFn: () => fetchTeamByEmail(email!),
    enabled: !!email && !isAdmin && !byRoleAdmin,
    staleTime: 5 * 60 * 1000,
  })

  if (isAdmin) return { role: 'admin', teamId: null, teamName: null, loading: false }

  const loading = loadingAdminIds || loadingLeadIds || loadingTeam
  if (byRoleAdmin) return { role: 'admin', teamId: null, teamName: null, loading: false }

  if (mine) return { role: 'team_lead', teamId: mine.id, teamName: mine.name, loading }
  if (myRoleIds.some((id) => leadRoleIds.includes(id))) {
    // Роль бригадира выдана, но бригады с таким email в tp_teams нет: вид урезанный,
    // привязки к бригаде нет — экраны должны это пережить (пустой список, не падение).
    return { role: 'team_lead', teamId: null, teamName: null, loading }
  }

  return { role: 'none', teamId: null, teamName: null, loading }
}
