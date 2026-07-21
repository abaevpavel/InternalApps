import { describe, it, expect } from 'vitest'
import { recomputeTeamDay, type Point } from '../src/domain/task-planner/scheduling-engine'
import type { ScheduledTask } from '../src/domain/task-planner/types'

// Простой travel-провайдер: фиксированные значения по ключу точки.
function makeTravel(map: Record<string, number>) {
  return (from: Point, to: Point) => {
    const key = `${from.key ?? ''}->${to.key ?? ''}`
    return map[key] ?? 0
  }
}

function task(p: Partial<ScheduledTask> & { task_id: string; duration_minutes: number }): ScheduledTask {
  return {
    scheduled_order: 0,
    project_id: '',
    project_name: '',
    project_address: '',
    description: '',
    anchor: false,
    anchor_time: '',
    start_time: '',
    end_time: '',
    drive_minutes_from_previous: 0,
    ...p,
  }
}

const home: Point = { lat: null, lng: null, key: 'home' }

describe('scheduling-engine: anchors', () => {
  it('держит якорь 12:00 намертво (кейс Javier из прогона 187122)', () => {
    // Wet Bar 09:00 (90m) → Closet ЯКОРЬ 12:00 (240m, drive 55) → Drop Ceiling (150m, drive 55)
    const tasks = [
      task({ task_id: 'wetbar', duration_minutes: 90, start_time: '09:00' }),
      task({ task_id: 'closet', duration_minutes: 240, anchor: true, anchor_time: '12:00' }),
      task({ task_id: 'drop', duration_minutes: 150 }),
    ]
    const travel = makeTravel({
      'home->wetbar': 0,
      'wetbar->closet': 55,
      'closet->drop': 55,
      'drop->home': 45,
      'home->': 0,
    })
    const pointOf = (t: ScheduledTask): Point => ({ lat: null, lng: null, key: t.task_id })

    const day = recomputeTeamDay({
      team_id: 'javier', team_name: 'Javier', date: '2025-10-29', timezone: 'America/New_York',
      home, home_address: 'home', tasks, pointOf, travel,
    })

    // Wet Bar заканчивается 10:30, +55 drive = 11:25 — но якорь ДОЛЖЕН остаться 12:00
    const closet = day.tasks.find((t) => t.task_id === 'closet')!
    expect(closet.start_time).toBe('12:00') // НЕ 11:25
    expect(closet.end_time).toBe('16:00')
    expect(day.summary?.compliance?.anchors_preserved).toBe(true)
  })

  it('помечает conflict, если к якорю не успеть доехать', () => {
    const tasks = [
      task({ task_id: 'a', duration_minutes: 180, start_time: '09:00' }), // 09:00–12:00
      task({ task_id: 'b', duration_minutes: 60, anchor: true, anchor_time: '12:30' }),
    ]
    const travel = makeTravel({ 'home->a': 0, 'a->b': 60, 'b->home': 0 }) // 12:00+60=13:00 > 12:30
    const pointOf = (t: ScheduledTask): Point => ({ lat: null, lng: null, key: t.task_id })

    const day = recomputeTeamDay({
      team_id: 't', team_name: 'T', date: '2025-10-29', timezone: 'America/New_York',
      home, home_address: 'home', tasks, pointOf, travel,
    })

    const b = day.tasks.find((t) => t.task_id === 'b')!
    expect(b.start_time).toBe('12:30') // якорь всё равно фиксирован
    expect(b.conflict?.overlap_min).toBe(30) // но конфликт зафиксирован
  })

  it('additional stop AFTER сдвигает выезд к следующей задаче, но не якорь', () => {
    const tasks = [
      task({
        task_id: 'a', duration_minutes: 120, start_time: '08:00',
        additional_stop: { when: 'after', address: 'HomeDepot', lat: null, lng: null, duration_min: 30 },
      }),
      task({ task_id: 'b', duration_minutes: 60 }),
    ]
    const travel = makeTravel({
      'home->a': 0, 'a->HomeDepot': 20, 'HomeDepot->b': 25, 'b->home': 0,
    })
    const pointOf = (t: ScheduledTask): Point => ({ lat: null, lng: null, key: t.task_id })

    const day = recomputeTeamDay({
      team_id: 't', team_name: 'T', date: '2025-10-29', timezone: 'America/New_York',
      home, home_address: 'home', tasks, pointOf, travel,
    })

    // a: 08:00–10:00; крюк через HomeDepot перезаписывает travel задачи b:
    // 20 (a→стоп) + 30 (стоп) + 25 (стоп→b) = 75 → b.travel=75, старт 10:00+75=11:15
    const b = day.tasks.find((t) => t.task_id === 'b')!
    expect(b.start_time).toBe('11:15')
    expect(b.drive_minutes_from_previous).toBe(75) // крюк виден в travel следующей задачи
  })
})
