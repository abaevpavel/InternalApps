/**
 * Роли модуля Task Planner и что каждая из них может (BAS-1509).
 *
 * Роли назначаются пользователю в App Settings → Roles (таблица `app_user_roles`,
 * миграция 0028), у одного человека их может быть несколько — права складываются.
 * Админ портала внутри модуля обходных прав не имеет: нужна роль — её назначают.
 *
 * Зеркало в БД — функции `tp_has_module_role()` / `tp_sees_all_tasks()` и RLS из 0028.
 * Это UI-слой: что показать и какие кнопки дать. Настоящий запрет — в RLS.
 */

export type TpRole = 'admin' | 'pm' | 'schedule_manager' | 'lead_carpenter'

export const TP_ROLES: { key: TpRole; label: string; short: string; hint: string }[] = [
  { key: 'admin', label: 'Admin', short: 'Admin', hint: 'Module settings and directories, full visibility of the module.' },
  { key: 'pm', label: 'Project Manager', short: 'PM', hint: 'Creates, edits and deletes tasks; reviews completed work.' },
  {
    key: 'schedule_manager',
    label: 'Schedule Manager',
    short: 'Schedule',
    hint: 'Sends tasks to the AI, rearranges and approves the schedule, sends tasks to Slack.',
  },
  {
    key: 'lead_carpenter',
    label: 'Lead Carpenter',
    short: 'Lead Carpenter',
    hint: 'Crew lead: sees own crew tasks, marks them completed, attaches photos and comments. The crew is matched by email.',
  },
]

export function isTpRole(v: string): v is TpRole {
  return TP_ROLES.some((r) => r.key === v)
}

export type TpCapability =
  | 'view_schedule' // Schedule screen: задачи всех PM
  | 'view_own_side' // своя сторона: свои задачи по статусам
  | 'create_task'
  | 'edit_task'
  | 'delete_task'
  | 'change_task_date'
  | 'send_to_ai'
  | 'rearrange_proposed'
  | 'approve_schedule'
  | 'send_tasks'
  | 'complete_task'
  | 'attach_photos'
  | 'comment_task'
  | 'review_task'
  | 'manage_availability'
  | 'manage_overtime'
  | 'manage_directories'

/** Матрица BAS-1509: кому доступна каждая возможность. */
const MATRIX: Record<TpCapability, TpRole[]> = {
  view_schedule: ['admin', 'pm', 'schedule_manager'],
  view_own_side: ['pm', 'lead_carpenter'],
  create_task: ['pm'],
  edit_task: ['pm'],
  delete_task: ['pm'],
  change_task_date: ['pm', 'schedule_manager'],
  send_to_ai: ['schedule_manager'],
  rearrange_proposed: ['schedule_manager'],
  approve_schedule: ['schedule_manager'],
  send_tasks: ['schedule_manager'],
  complete_task: ['lead_carpenter'],
  attach_photos: ['lead_carpenter'],
  comment_task: ['lead_carpenter'],
  review_task: ['pm'],
  manage_availability: ['admin', 'pm', 'schedule_manager'],
  manage_overtime: ['admin', 'pm', 'schedule_manager'],
  manage_directories: ['admin'],
}

export function rolesFor(cap: TpCapability): TpRole[] {
  return MATRIX[cap]
}

export function can(roles: readonly TpRole[], cap: TpCapability): boolean {
  return MATRIX[cap].some((r) => roles.includes(r))
}
