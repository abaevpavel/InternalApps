import { describe, expect, it } from 'vitest'
import { planningDay, planningViewOf, tasksForView } from '../src/domain/task-planner/planning-side'
import type { Task } from '../src/domain/task-planner/types'

/** Сторона планирования (BAS-1435): Scheduled — завтра, Today — сегодня, Closed — закрытые. */
const today = '2026-10-19'
const task = (p: Partial<Task>): Task =>
  ({ id: p.id ?? 'x', status: 'scheduled', execution_status: 'pending', scheduled_date: today, ...p }) as Task

describe('planningDay', () => {
  it('is tomorrow', () => {
    expect(planningDay(today)).toBe('2026-10-20')
  })

  it('skips the weekend: Friday, Saturday and Sunday plan for Monday', () => {
    expect(planningDay('2026-10-23')).toBe('2026-10-26')
    expect(planningDay('2026-10-24')).toBe('2026-10-26')
    expect(planningDay('2026-10-25')).toBe('2026-10-26')
  })
})

describe('planningViewOf', () => {
  it('tomorrow, not closed → Scheduled', () => {
    expect(planningViewOf(task({ scheduled_date: '2026-10-20' }), today)).toBe('scheduled')
  })

  it('today, Uncompleted or Completed → Today', () => {
    expect(planningViewOf(task({ execution_status: 'pending' }), today)).toBe('today')
    expect(planningViewOf(task({ execution_status: 'completed' }), today)).toBe('today')
  })

  it('closed by the PM → Closed, whatever the date', () => {
    expect(planningViewOf(task({ execution_status: 'closed' }), today)).toBe('closed')
    expect(planningViewOf(task({ execution_status: 'closed', scheduled_date: '2026-10-20' }), today)).toBe('closed')
    expect(planningViewOf(task({ execution_status: 'closed', scheduled_date: '2026-10-01' }), today)).toBe('closed')
  })

  it('past day not closed stays on its day (BAS-1513) — no planning tab', () => {
    expect(planningViewOf(task({ scheduled_date: '2026-10-18' }), today)).toBeNull()
  })

  it('later than tomorrow — Tracking only (BAS-1433)', () => {
    expect(planningViewOf(task({ scheduled_date: '2026-10-21' }), today)).toBeNull()
  })

  it('not an approved task → none', () => {
    expect(planningViewOf(task({ status: 'proposed', scheduled_date: '2026-10-20' }), today)).toBeNull()
  })
})

describe('tasksForView', () => {
  it('splits a mixed list', () => {
    const list = [
      task({ id: 'tomorrow', scheduled_date: '2026-10-20' }),
      task({ id: 'today' }),
      task({ id: 'closed', execution_status: 'closed' }),
      task({ id: 'past', scheduled_date: '2026-10-18' }),
    ]
    expect(tasksForView(list, 'scheduled', today).map((t) => t.id)).toEqual(['tomorrow'])
    expect(tasksForView(list, 'today', today).map((t) => t.id)).toEqual(['today'])
    expect(tasksForView(list, 'closed', today).map((t) => t.id)).toEqual(['closed'])
  })
})
