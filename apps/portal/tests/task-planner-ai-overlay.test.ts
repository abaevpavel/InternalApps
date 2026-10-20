import { describe, expect, it } from 'vitest'
import { buildAiApplyItems } from '../src/domain/task-planner/ai-overlay'
import type { ScheduledTask, Task, TeamDay } from '../src/domain/task-planner/types'

/** Ответ AI ложится на наши задачи только полями расписания (TP-1.1). */
const DATE = '2026-10-21'
const task = (p: Partial<Task>): Task =>
  ({ id: 't1', status: 'requested', execution_status: 'pending', estimated_duration_min: 120, time_type: null, exact_time: null,
     assigned_team_id: null, project_id: 'p1', ...p }) as Task
const st = (p: Partial<ScheduledTask>): ScheduledTask =>
  ({ scheduled_order: 1, task_id: 't1', project_id: 'p1', start_time: '08:00', end_time: '10:00', duration_minutes: 120,
     drive_minutes_from_previous: 0, anchor: false, anchor_time: '', ...p }) as ScheduledTask
const day = (team_id: string, tasks: ScheduledTask[], date = DATE): TeamDay =>
  ({ team_id, team_name: team_id.toUpperCase(), date, tasks }) as TeamDay
const teams = [{ id: 'A', name: 'Crew A' }, { id: 'B', name: 'Crew B' }]
const codes = (w: { code: string }[]) => w.map((x) => x.code)

describe('buildAiApplyItems', () => {
  it('clean placement — schedule fields only, no warnings', () => {
    const [it0] = buildAiApplyItems({ sent: [task({})], schedule: [day('A', [st({ drive_minutes_from_previous: 15 })])], teams, unavailable: [], date: DATE })
    expect(it0).toMatchObject({ task_id: 't1', team_id: 'A', stop_number: 1, start: '08:00', end: '10:00', travel: 15 })
    expect(it0.warnings).toEqual([])
  })

  it('every sent task gets exactly one item, missing ones are flagged', () => {
    const items = buildAiApplyItems({
      sent: [task({}), task({ id: 't2' }), task({ id: 't3' })],
      schedule: [day('A', [st({})])],
      unscheduled: [{ task_id: 't2', reason: 'no_eligible_team' }],
      teams, unavailable: [], date: DATE,
    })
    expect(items.map((i) => i.task_id)).toEqual(['t1', 't2', 't3'])
    expect(codes(items[1].warnings)).toEqual(['not_placed'])
    expect(items[1].warnings[0].message).toContain('no_eligible_team')
    expect(codes(items[2].warnings)).toEqual(['not_returned'])
    expect(items[2]).toMatchObject({ team_id: null, start: null })
  })

  it('AI duration differs — warned, never applied', () => {
    const [it0] = buildAiApplyItems({ sent: [task({})], schedule: [day('A', [st({ duration_minutes: 180 })])], teams, unavailable: [], date: DATE })
    expect(codes(it0.warnings)).toContain('duration_changed')
    expect(it0).not.toHaveProperty('duration')
  })

  it('task returned twice — first placement wins', () => {
    const [it0] = buildAiApplyItems({ sent: [task({})], schedule: [day('A', [st({})]), day('B', [st({ start_time: '12:00', end_time: '14:00' })])], teams, unavailable: [], date: DATE })
    expect(it0.team_id).toBe('A')
    expect(codes(it0.warnings)).toContain('returned_twice')
  })

  it('anchor moved, unknown crew, unavailable crew, manual crew changed, wrong date', () => {
    const anchored = buildAiApplyItems({ sent: [task({ time_type: 'exact', exact_time: '09:00' })], schedule: [day('A', [st({})])], teams, unavailable: [], date: DATE })[0]
    expect(codes(anchored.warnings)).toContain('anchor_moved')

    const unknown = buildAiApplyItems({ sent: [task({})], schedule: [day('Z', [st({})])], teams, unavailable: [], date: DATE })[0]
    expect(unknown.team_id).toBeNull()
    expect(codes(unknown.warnings)).toContain('unknown_team')

    const off = buildAiApplyItems({ sent: [task({})], schedule: [day('A', [st({})])], teams, unavailable: [{ team_id: 'A', start_date: DATE, end_date: DATE }], date: DATE })[0]
    expect(codes(off.warnings)).toContain('team_unavailable')

    const manual = buildAiApplyItems({ sent: [task({ assigned_team_id: 'B' })], schedule: [day('A', [st({})])], teams, unavailable: [], date: DATE })[0]
    expect(codes(manual.warnings)).toContain('crew_changed')

    const wrong = buildAiApplyItems({ sent: [task({})], schedule: [day('A', [st({})], '2026-10-22')], teams, unavailable: [], date: DATE })[0]
    expect(codes(wrong.warnings)).toContain('wrong_date')
  })

  it('overlapping tasks of one crew are both flagged', () => {
    const items = buildAiApplyItems({
      sent: [task({}), task({ id: 't2' })],
      schedule: [day('A', [st({}), st({ task_id: 't2', scheduled_order: 2, start_time: '09:30', end_time: '11:30' })])],
      teams, unavailable: [], date: DATE,
    })
    expect(items.every((i) => codes(i.warnings).includes('overlap'))).toBe(true)
  })
})
