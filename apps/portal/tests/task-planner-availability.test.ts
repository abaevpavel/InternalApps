import { describe, expect, it } from 'vitest'
import {
  availableTeamsOn, coversDate, overlappingPeriod, periodOn, splitByDate, tasksWithUnavailableTeam, teamsOffOn,
  toAvailabilityKind,
} from '../src/domain/task-planner/availability'

// BAS-1446: случай 20.10.2026 — у двух бригад периоды давно закончились, а они выпадали из AI.
const periods = [
  { id: 'p1', team_id: 'alfredo', start_date: '2025-09-20', end_date: '2025-09-27' },
  { id: 'p2', team_id: 'gheorghe', start_date: '2026-09-17', end_date: '2026-09-30' },
  { id: 'p3', team_id: 'jorge', start_date: '2026-10-21', end_date: '2026-10-23' },
]
const teams = [{ id: 'alfredo' }, { id: 'gheorghe' }, { id: 'jorge' }, { id: 'luis' }]

describe('availability by date', () => {
  it('borders are inclusive', () => {
    expect(coversDate(periods[2], '2026-10-21')).toBe(true)
    expect(coversDate(periods[2], '2026-10-23')).toBe(true)
    expect(coversDate(periods[2], '2026-10-24')).toBe(false)
  })

  it('past periods do not exclude a crew', () => {
    expect([...teamsOffOn(periods, '2026-10-21')]).toEqual(['jorge'])
    expect(availableTeamsOn(teams, periods, '2026-10-21').map((t) => t.id)).toEqual(['alfredo', 'gheorghe', 'luis'])
    expect(availableTeamsOn(teams, periods, '2026-10-24').map((t) => t.id)).toEqual(['alfredo', 'gheorghe', 'jorge', 'luis'])
  })

  it('finds tasks assigned to a crew that is off on the task day', () => {
    const tasks = [
      { id: 'a', assigned_team_id: 'jorge', scheduled_date: '2026-10-22' },
      { id: 'b', assigned_team_id: 'jorge', scheduled_date: '2026-10-24' },
      { id: 'c', assigned_team_id: null, scheduled_date: '2026-10-22' },
      { id: 'd', assigned_team_id: 'gheorghe', scheduled_date: '2026-10-22' },
    ]
    expect(tasksWithUnavailableTeam(tasks, periods).map((t) => t.id)).toEqual(['a'])
    expect(periodOn(periods, null, '2026-10-22')).toBeUndefined()
  })
})

describe('overlaps and lists', () => {
  it('overlap of the same crew only, editing period excluded', () => {
    expect(overlappingPeriod(periods, 'jorge', '2026-10-23', '2026-10-25')?.id).toBe('p3')
    expect(overlappingPeriod(periods, 'jorge', '2026-10-24', '2026-10-25')).toBeUndefined()
    expect(overlappingPeriod(periods, 'luis', '2026-10-21', '2026-10-23')).toBeUndefined()
    expect(overlappingPeriod(periods, 'jorge', '2026-10-20', '2026-10-22', 'p3')).toBeUndefined()
  })

  it('splits current and upcoming from past', () => {
    const { upcoming, past } = splitByDate(periods, '2026-10-22')
    expect(upcoming.map((p) => p.id)).toEqual(['p3'])
    expect(past.map((p) => p.id)).toEqual(['p2', 'p1'])
  })

  it('unknown kind becomes other', () => {
    expect(toAvailabilityKind('sick_leave')).toBe('sick_leave')
    expect(toAvailabilityKind('holiday')).toBe('other')
  })
})
