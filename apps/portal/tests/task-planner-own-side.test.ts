import { describe, expect, it } from 'vitest'
import { defaultCrewDay, groupByDay, ownListOf, ownTasks, presetRange, shiftDay } from '../src/domain/task-planner/own-side'
import type { Task } from '../src/domain/task-planner/types'

/** Своя сторона (BAS-1510): чьи задачи, в каком списке, по каким дням. */
const task = (p: Partial<Task>): Task =>
  ({ id: p.id ?? 'x', status: 'scheduled', execution_status: 'pending', scheduled_date: '2026-10-12', ...p }) as Task

describe('ownTasks', () => {
  const list = [
    task({ id: 'mine', created_by: 'u1' }),
    task({ id: 'other', created_by: 'u2' }),
    task({ id: 'noauthor', created_by: null }),
  ]

  it('PM sees own tasks and tasks without an author', () => {
    expect(ownTasks(list, 'pm', 'u1').map((t) => t.id)).toEqual(['mine', 'noauthor'])
  })

  it('PM by pm_email: assigned PM sees the task, the author does not', () => {
    const withPm = [
      task({ id: 'assigned', created_by: 'u2', pm_email: 'me@x.com' }),
      task({ id: 'authoredByMe', created_by: 'u1', pm_email: 'other@x.com' }),
    ]
    expect(ownTasks(withPm, 'pm', 'u1', 'Me@X.com').map((t) => t.id)).toEqual(['assigned'])
  })

  it('crew mode keeps everything the database returned (scope is RLS)', () => {
    expect(ownTasks(list, 'crew', 'u1')).toHaveLength(3)
  })
})

describe('ownListOf', () => {
  it('maps execution status to the three lists', () => {
    expect(ownListOf(task({ execution_status: 'pending' }))).toBe('uncompleted')
    expect(ownListOf(task({ execution_status: 'completed' }))).toBe('completed')
    expect(ownListOf(task({ execution_status: 'closed' }))).toBe('closed')
  })
})

describe('groupByDay', () => {
  it('orders days ascending and tasks by start time within a day', () => {
    const days = groupByDay([
      task({ id: 'b', scheduled_date: '2026-10-13', sched_start: '10:00' }),
      task({ id: 'a', scheduled_date: '2026-10-12', sched_start: '09:00' }),
      task({ id: 'c', scheduled_date: '2026-10-13', sched_start: '08:00' }),
    ])
    expect(days.map((d) => d.date)).toEqual(['2026-10-12', '2026-10-13'])
    expect(days[1].tasks.map((t) => t.id)).toEqual(['c', 'b'])
  })
})

describe('presetRange', () => {
  it('week starts on Monday, Sunday belongs to the week before', () => {
    expect(presetRange('this_week', '2026-10-12')).toEqual({ from: '2026-10-12', to: '2026-10-18' }) // пн
    expect(presetRange('this_week', '2026-10-18')).toEqual({ from: '2026-10-12', to: '2026-10-18' }) // вс
    expect(presetRange('next_week', '2026-10-14')).toEqual({ from: '2026-10-19', to: '2026-10-25' })
  })

  it('month covers the whole calendar month', () => {
    expect(presetRange('this_month', '2026-02-10')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
  })
})

/** LC View (BAS-1511): бригада смотрит один день, по умолчанию завтра. */
describe('crew day', () => {
  it('defaults to tomorrow, across month and year ends', () => {
    expect(defaultCrewDay('2026-10-16')).toBe('2026-10-17')
    expect(defaultCrewDay('2026-10-31')).toBe('2026-11-01')
    expect(defaultCrewDay('2026-12-31')).toBe('2027-01-01')
  })

  it('shifts across the DST change', () => {
    expect(shiftDay('2026-11-01', 1)).toBe('2026-11-02')
    expect(shiftDay('2026-03-09', -1)).toBe('2026-03-08')
  })
})
