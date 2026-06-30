/**
 * Scheduling Engine — пересчёт дня одной бригады.
 *
 * Повторяет модель старого приложения (fullTaskRecalculation, 3 шага), НО
 * исправляет её главный баг: промежуточные якоря фиксируются на anchor_time.
 *
 *  Шаг 1 — базовый travel между соседними точками (TravelProvider / Google).
 *          Первая задача: travel = 0.
 *  Шаг 2 — Additional Stops перезаписывают travel «пристёгнутой» задачи:
 *          after  → крюк (toStop + stop.duration + fromStop) идёт в travel СЛЕДУЮЩЕЙ задачи;
 *          before → крюк идёт в travel ТЕКУЩЕЙ задачи.
 *          estimated_duration самой задачи при этом НЕ меняется.
 *  Шаг 3 — scheduled times: start = prev.end + travel; end = start + duration.
 *          Первая задача — начало дня. ЯКОРЬ (anchor=true): start = anchor_time
 *          намертво; если доехать вовремя нельзя — помечаем conflict (не двигаем).
 *
 * Модуль чистый: travel приходит через TravelProvider. Время — минуты от полуночи.
 */

import type { ScheduledTask, AdditionalStop, TeamDay } from './types'
import { hhmmToMin, minToHHMM } from '../lib/time'

export interface Point {
  lat: number | null
  lng: number | null
  key?: string
}

export type TravelProvider = (from: Point, to: Point) => number

export interface RecomputeInput {
  team_id: string
  team_name: string
  date: string
  timezone: string
  home: Point
  home_address: string
  tasks: ScheduledTask[]
  pointOf: (t: ScheduledTask) => Point
  travel: TravelProvider
}

const OVERTIME_8 = 480
const OVERTIME_10 = 600

function stopPoint(s: AdditionalStop): Point {
  return { lat: s.lat ?? null, lng: s.lng ?? null, key: s.address }
}

/** Крюк через additional stop: toStop + stop.duration + fromStop. */
function hook(s: AdditionalStop, from: Point, to: Point, travel: TravelProvider): number {
  const toStop = s.travel_to_min ?? travel(from, stopPoint(s))
  const fromStop = s.travel_from_min ?? travel(stopPoint(s), to)
  return toStop + s.duration_min + fromStop
}

/** Начало дня для первой задачи: якорь → anchor_time, иначе её start_time, иначе 0. */
function firstStart(t: ScheduledTask): number {
  if (t.anchor && t.anchor_time) return hhmmToMin(t.anchor_time)
  return t.start_time ? hhmmToMin(t.start_time) : 0
}

export function recomputeTeamDay(input: RecomputeInput): TeamDay {
  const { tasks, travel, pointOf, home } = input
  const out: ScheduledTask[] = []

  let prevEnd = 0
  let prevPoint: Point = home
  let prevTask: ScheduledTask | null = null
  let totalTravel = 0
  let totalDuration = 0

  tasks.forEach((raw, idx) => {
    const t: ScheduledTask = { ...raw, conflict: null }
    const taskPoint = pointOf(t)

    // --- Шаги 1–2: travel_in (drive_minutes_from_previous) ---
    let travelIn: number
    if (idx === 0) {
      travelIn = 0
    } else if (prevTask?.additional_stop?.when === 'after') {
      travelIn = hook(prevTask.additional_stop, prevPoint, taskPoint, travel) // after предыдущей
    } else if (t.additional_stop?.when === 'before') {
      travelIn = hook(t.additional_stop, prevPoint, taskPoint, travel) // before текущей
    } else if (t.travel_overridden && typeof raw.drive_minutes_from_previous === 'number') {
      travelIn = raw.drive_minutes_from_previous // ручной override ПМ
    } else {
      travelIn = travel(prevPoint, taskPoint) // обычный travel
    }

    // --- Шаг 3: scheduled times (с фиксацией якоря) ---
    const baseStart = idx === 0 ? firstStart(t) : prevEnd + travelIn
    let start: number
    if (t.anchor && t.anchor_time) {
      start = hhmmToMin(t.anchor_time)
      if (baseStart > start) t.conflict = { overlap_min: baseStart - start }
    } else {
      start = baseStart
    }
    const end = start + t.duration_minutes

    t.scheduled_order = idx + 1
    t.drive_minutes_from_previous = travelIn
    t.start_time = minToHHMM(start)
    t.end_time = minToHHMM(end)

    out.push(t)
    if (idx > 0) totalTravel += travelIn
    totalDuration += t.duration_minutes
    prevEnd = end
    prevPoint = taskPoint
    prevTask = t
  })

  const first = out[0]
  const last = out[out.length - 1]
  const morningCommute = first ? travel(home, pointOf(first)) : 0
  const endCommute = last ? travel(pointOf(last), home) : 0

  const workingMin = totalDuration + totalTravel
  const startMin = out.length ? hhmmToMin(out[0].start_time) : 0
  const endMin = out.length ? Math.max(...out.map((t) => hhmmToMin(t.end_time))) : 0
  const category =
    workingMin <= OVERTIME_8 ? 'normal' : workingMin <= OVERTIME_10 ? 'overtime_8_to_10' : 'overtime_over_10'

  return {
    team_id: input.team_id,
    team_name: input.team_name,
    date: input.date,
    timezone: input.timezone,
    team_home_base: input.home_address,
    workday_start_time: minToHHMM(startMin),
    workday_end_time: minToHHMM(endMin),
    morning_commute_minutes: morningCommute,
    end_of_day_commute_minutes: endCommute,
    total_working_minutes: workingMin,
    day_length_category: category,
    overtime: category !== 'normal',
    tasks: out,
    summary: {
      total_tasks: out.length,
      total_travel_in_day_minutes: totalTravel,
      compliance: {
        no_overlaps: out.every((t) => !t.conflict),
        anchors_preserved: out.filter((t) => t.anchor).every((t) => t.start_time === t.anchor_time),
        all_tasks_scheduled: true,
      },
    },
  }
}
