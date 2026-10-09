import { describe, expect, it } from 'vitest'
import { APPS, visibleNavItems } from '../src/app/appRegistry'
import { can, type TpRole } from '../src/domain/task-planner/permissions'

/**
 * Видимость пунктов меню по ролям модуля (BAS-1509). Гейт на UI; в БД ему зеркалит RLS
 * миграции 0028. Ролей у человека может быть несколько — права складываются; админ
 * портала без ролей модуля обходных прав не имеет.
 */
const taskPlanner = APPS.find((a) => a.code === 'task-planner')!
const labels = (opts: { isAdmin: boolean; appRoles: string[] | null }) =>
  visibleNavItems(taskPlanner, opts).map((i) => i.label)

describe('visibleNavItems — Task Planner', () => {
  it('lead carpenter sees only their own screen', () => {
    expect(labels({ isAdmin: false, appRoles: ['lead_carpenter'] })).toEqual(['My Tasks'])
  })

  it('project manager: schedule, task creation, review, availability', () => {
    expect(labels({ isAdmin: false, appRoles: ['pm'] })).toEqual([
      'Tasks', 'Create Task', 'Approvals', 'Teams Availability',
    ])
  })

  it('schedule manager: schedule and availability, no task creation', () => {
    expect(labels({ isAdmin: false, appRoles: ['schedule_manager'] })).toEqual(['Tasks', 'Teams Availability'])
  })

  it('module admin gets Directories without being a portal admin', () => {
    expect(labels({ isAdmin: false, appRoles: ['admin'] })).toEqual(['Tasks', 'Teams Availability', 'Directories'])
  })

  it('several roles add up', () => {
    expect(labels({ isAdmin: false, appRoles: ['pm', 'schedule_manager', 'lead_carpenter'] })).toEqual([
      'Tasks', 'My Tasks', 'Create Task', 'Approvals', 'Teams Availability',
    ])
  })

  it('portal admin without module roles sees nothing role-scoped', () => {
    expect(labels({ isAdmin: true, appRoles: [] })).toEqual([])
  })

  it('hides role-scoped items while roles are still being resolved', () => {
    expect(labels({ isAdmin: false, appRoles: null })).toEqual([])
  })
})

describe('permissions matrix — Task Planner', () => {
  const only = (role: TpRole) => [role]

  it('schedule actions belong to the schedule manager only', () => {
    for (const cap of ['send_to_ai', 'rearrange_proposed', 'approve_schedule', 'send_tasks'] as const) {
      expect(can(only('schedule_manager'), cap)).toBe(true)
      expect(can(only('pm'), cap)).toBe(false)
      expect(can(only('admin'), cap)).toBe(false)
    }
  })

  it('task editing belongs to the PM; date change also to the schedule manager', () => {
    expect(can(only('pm'), 'edit_task')).toBe(true)
    expect(can(only('schedule_manager'), 'edit_task')).toBe(false)
    expect(can(only('schedule_manager'), 'change_task_date')).toBe(true)
  })

  it('execution belongs to the lead carpenter', () => {
    expect(can(only('lead_carpenter'), 'complete_task')).toBe(true)
    expect(can(only('pm'), 'complete_task')).toBe(false)
  })
})
