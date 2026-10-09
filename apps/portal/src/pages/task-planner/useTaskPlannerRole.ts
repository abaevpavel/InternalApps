import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../../auth/AuthProvider'
import { fetchTeamByEmail } from '../../services/task-planner/data'
import { listMyAppRoles } from '../../services/app-user-roles'
import { can, isTpRole, type TpCapability, type TpRole } from '../../domain/task-planner/permissions'

/**
 * Роли пользователя ВНУТРИ Task Planner (BAS-1509).
 *
 * Роли хранятся за пользователем (`app_user_roles`, миграция 0028) и назначаются админом
 * портала в `/settings/task-planner` → Roles. Их может быть несколько — права складываются
 * по матрице `domain/task-planner/permissions.ts`.
 *
 * Админ портала внутри модуля обходных прав не имеет: без ролей он видит Access denied,
 * как и все. Доступ к самой апке (портальная роль) роли не даёт.
 *
 * Бригада — только у Lead Carpenter: строка `tp_teams`, чей email совпал с email пользователя.
 * То же правило в БД — `tp_my_team_id()`; гейт обязан быть на обоих слоях, UI без RLS обходится.
 */
export interface TaskPlannerAccess {
  roles: TpRole[]
  /** Есть ли у пользователя право по матрице. */
  can: (cap: TpCapability) => boolean
  /** tp_teams.id своей бригады — только у Lead Carpenter, иначе null. */
  teamId: string | null
  teamName: string | null
  loading: boolean
}

const APP_CODE = 'task-planner'

export function useTaskPlannerRoles(): TaskPlannerAccess {
  const { authUser } = useAuth()
  const uid = authUser?.id ?? null
  const email = authUser?.email?.toLowerCase() ?? null

  const rolesQ = useQuery({
    queryKey: ['app-user-roles', APP_CODE, uid],
    queryFn: () => listMyAppRoles(APP_CODE, uid!),
    enabled: !!uid,
    staleTime: 5 * 60 * 1000,
  })
  const roles = (rolesQ.data ?? []).filter(isTpRole)
  const isLead = roles.includes('lead_carpenter')

  const teamQ = useQuery({
    queryKey: ['tp-my-team', email],
    queryFn: () => fetchTeamByEmail(email!),
    enabled: !!email && isLead,
    staleTime: 5 * 60 * 1000,
  })
  const team = isLead ? teamQ.data ?? null : null

  return {
    roles,
    can: (cap) => can(roles, cap),
    teamId: team?.id ?? null,
    teamName: team?.name ?? null,
    loading: !uid || rolesQ.isLoading || (isLead && teamQ.isLoading),
  }
}
