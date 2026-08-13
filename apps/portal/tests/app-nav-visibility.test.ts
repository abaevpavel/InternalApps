import { describe, expect, it } from 'vitest'
import { APPS, visibleNavItems } from '../src/app/appRegistry'

/**
 * Видимость пунктов меню по виду внутри апки (правило 3 платформы — гейт на UI; в БД ему
 * зеркалит RLS + tp_is_planner_admin()). Проверяем на Task Planner: у бригадира не должно
 * быть планировочных экранов, у планировщика — полный набор.
 */
const taskPlanner = APPS.find((a) => a.code === 'task-planner')!
const labels = (opts: { isAdmin: boolean; appRole: string | null }) =>
  visibleNavItems(taskPlanner, opts).map((i) => i.label)

describe('visibleNavItems — Task Planner', () => {
  it('team lead sees only their own screens', () => {
    expect(labels({ isAdmin: false, appRole: 'team_lead' })).toEqual(['My Tasks', 'Teams Availability'])
  })

  it('planner admin (not a portal admin) sees planning screens but not portal-only Directories', () => {
    const seen = labels({ isAdmin: false, appRole: 'admin' })
    expect(seen).toContain('Tasks')
    expect(seen).toContain('Create Task')
    expect(seen).toContain('Approvals')
    expect(seen).not.toContain('Directories')
  })

  it('portal admin sees everything, Directories included', () => {
    expect(labels({ isAdmin: true, appRole: 'admin' })).toContain('Directories')
  })

  it('hides role-scoped items while the view is still being resolved', () => {
    // appRole = null — вид ещё не вычислен: планировочные пункты не мигают у бригадира.
    expect(labels({ isAdmin: false, appRole: null })).toEqual(['My Tasks', 'Teams Availability'])
  })
})
