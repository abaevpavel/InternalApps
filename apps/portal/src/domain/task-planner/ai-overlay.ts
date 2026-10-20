/**
 * Ответ AI → наложение на наши задачи (TP-1.1, решение Vlad 20.10.2026).
 *
 * Ответ AI — не задача, а предложение по расписанию. С задачи берём всё своё, из ответа — только
 * место в дне: бригаду, порядок, начало и конец, время в пути. Длительность, якорь, окно времени,
 * название, адрес, проект AI не меняет; если он вернул в них другое — это пометка, а не правка.
 *
 * Каждая отправленная задача получает ровно один элемент — с расписанием или без, но с пометкой,
 * почему так. В Proposed переходят все; вопросы к задаче — оранжевый треугольник с подсказкой.
 * Применяет элементы функция БД `tp_ai_apply` (миграция 0041) одной транзакцией.
 */
import { hhmmToMin } from '../../lib/task-planner-time'
import type { Task, Team, TeamAvailability, TeamDay, ScheduledTask } from './types'

export type AiWarningCode =
  | 'not_placed'
  | 'not_returned'
  | 'returned_twice'
  | 'unknown_team'
  | 'team_unavailable'
  | 'crew_changed'
  | 'wrong_date'
  | 'anchor_moved'
  | 'duration_changed'
  | 'project_changed'
  | 'overlap'
  | 'edited_after_send'

export interface AiWarning {
  code: AiWarningCode
  message: string
}

/** Элемент для `tp_ai_apply`: только поля расписания + пометки + сырой ответ для журнала. */
export interface AiApplyItem {
  task_id: string
  team_id: string | null
  stop_number: number | null
  start: string | null
  end: string | null
  travel: number | null
  warnings: AiWarning[]
  received: unknown
}

export interface AiUnscheduled {
  task_id?: string
  reason?: string
  notes?: string
}

export interface BuildAiApplyInput {
  /** Задачи, которые ждут этот запрос (как они лежат в базе сейчас). */
  sent: Task[]
  schedule: TeamDay[]
  unscheduled?: AiUnscheduled[]
  teams: Pick<Team, 'id' | 'name'>[]
  unavailable: Pick<TeamAvailability, 'team_id' | 'start_date' | 'end_date'>[]
  /** День батча (YYYY-MM-DD). */
  date: string
}

const hours = (min: number) => `${Math.round((min / 60) * 100) / 100}h`

export function buildAiApplyItems(input: BuildAiApplyInput): AiApplyItem[] {
  const teamById = new Map(input.teams.map((t) => [t.id, t]))
  const unscheduledById = new Map(
    (input.unscheduled ?? []).filter((u) => u?.task_id).map((u) => [String(u.task_id), u]),
  )

  // где AI поставил каждую задачу; повторы запоминаем
  const placed = new Map<string, { day: TeamDay; t: ScheduledTask }>()
  const seenTwice = new Set<string>()
  for (const day of input.schedule ?? []) {
    for (const t of day.tasks ?? []) {
      if (!t?.task_id) continue
      if (placed.has(t.task_id)) seenTwice.add(t.task_id)
      else placed.set(t.task_id, { day, t })
    }
  }

  const items: AiApplyItem[] = input.sent.map((task) => {
    const warnings: AiWarning[] = []
    const hit = placed.get(task.id)

    if (!hit) {
      const u = unscheduledById.get(task.id)
      warnings.push(
        u
          ? { code: 'not_placed', message: `AI could not place this task: ${u.reason || 'no reason given'}${u.notes ? ` (${u.notes})` : ''}` }
          : { code: 'not_returned', message: 'AI did not return this task at all' },
      )
      return {
        task_id: task.id, team_id: null, stop_number: null, start: null, end: null, travel: null,
        warnings, received: u ?? null,
      }
    }

    const { day, t } = hit
    if (seenTwice.has(task.id)) {
      warnings.push({ code: 'returned_twice', message: 'AI returned this task more than once — the first placement is used' })
    }

    let teamId: string | null = day.team_id && day.team_id !== 'unassigned' ? day.team_id : null
    if (teamId && !teamById.has(teamId)) {
      warnings.push({ code: 'unknown_team', message: `AI assigned a crew that does not exist (${day.team_name || teamId})` })
      teamId = null
    }
    if (!teamId) {
      warnings.push({ code: 'not_placed', message: 'AI did not assign a crew' })
    } else {
      const off = input.unavailable.some((u) => u.team_id === teamId && u.start_date <= input.date && input.date <= u.end_date)
      if (off) warnings.push({ code: 'team_unavailable', message: `${teamById.get(teamId)?.name ?? 'The crew'} is unavailable on ${input.date}` })
    }
    if (task.assigned_team_id && teamId && task.assigned_team_id !== teamId) {
      warnings.push({
        code: 'crew_changed',
        message: `The crew was set in the request (${task.assigned_team_name ?? task.assigned_team_id}), AI moved it to ${teamById.get(teamId)?.name ?? teamId}`,
      })
    }
    if (day.date && day.date !== input.date) {
      warnings.push({ code: 'wrong_date', message: `AI planned it for ${day.date}, the batch is for ${input.date}` })
    }
    if (task.time_type === 'exact' && task.exact_time && t.start_time && hhmmToMin(t.start_time) !== hhmmToMin(task.exact_time)) {
      warnings.push({ code: 'anchor_moved', message: `Exact time is ${task.exact_time}, AI starts it at ${t.start_time}` })
    }
    if (Number.isFinite(t.duration_minutes) && t.duration_minutes !== task.estimated_duration_min) {
      warnings.push({
        code: 'duration_changed',
        message: `AI planned ${hours(t.duration_minutes)}, the task says ${hours(task.estimated_duration_min)} — the task's duration is kept`,
      })
    }
    if (t.project_id && task.project_id && t.project_id !== task.project_id) {
      warnings.push({ code: 'project_changed', message: 'AI returned a different project for this task — ignored' })
    }

    return {
      task_id: task.id,
      team_id: teamId,
      stop_number: Number.isFinite(t.scheduled_order) ? t.scheduled_order : null,
      start: t.start_time || null,
      end: t.end_time || null,
      travel: Number.isFinite(t.drive_minutes_from_previous) ? t.drive_minutes_from_previous : null,
      warnings,
      received: { team_id: day.team_id, team_name: day.team_name, date: day.date, ...t },
    }
  })

  // пересечения по времени внутри бригады
  const byTeam = new Map<string, AiApplyItem[]>()
  for (const it of items) {
    if (!it.team_id || !it.start || !it.end) continue
    if (!byTeam.has(it.team_id)) byTeam.set(it.team_id, [])
    byTeam.get(it.team_id)!.push(it)
  }
  for (const list of byTeam.values()) {
    list.sort((a, b) => hhmmToMin(a.start!) - hhmmToMin(b.start!))
    for (let i = 1; i < list.length; i++) {
      if (hhmmToMin(list[i].start!) < hhmmToMin(list[i - 1].end!)) {
        const msg = { code: 'overlap' as const, message: 'Overlaps in time with another task of the same crew' }
        if (!list[i].warnings.some((w) => w.code === 'overlap')) list[i].warnings.push(msg)
        if (!list[i - 1].warnings.some((w) => w.code === 'overlap')) list[i - 1].warnings.push(msg)
      }
    }
  }
  return items
}
