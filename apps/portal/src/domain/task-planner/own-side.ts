/**
 * «Своя сторона» Task Planner (BAS-1510): свои задачи по спискам Uncompleted / Completed /
 * Closed, сгруппированные по дням.
 *
 * Чьи задачи:
 *  - PM — где он PM задачи (`pm_email`: проектная — PM проекта, Other — автор, или выбран
 *    вручную, решение 13.10.2026). У задач без pm_email — по автору (`created_by`); старые
 *    задачи без автора и без PM показываются всем PM с пометкой «no author»;
 *  - Lead Carpenter — задачи его бригады (скоуп держит RLS, здесь фильтра нет), по одному
 *    дню: календарь, по умолчанию завтра (BAS-1511).
 *
 * Списки по оси исполнения: Uncompleted = pending, Completed = completed, Closed = closed
 * (BAS-1431).
 */
import type { ExecutionStatus, Task } from './types'

export type OwnList = 'uncompleted' | 'completed' | 'closed'
export type OwnMode = 'pm' | 'crew'

export const OWN_LISTS: { key: OwnList; label: string }[] = [
  { key: 'uncompleted', label: 'Uncompleted' },
  { key: 'completed', label: 'Completed' },
  { key: 'closed', label: 'Closed' },
]

const LIST_BY_STATUS: Record<ExecutionStatus, OwnList> = {
  pending: 'uncompleted',
  completed: 'completed',
  closed: 'closed',
}

export function ownListOf(t: Task): OwnList {
  return LIST_BY_STATUS[t.execution_status] ?? 'uncompleted'
}

/** Задача без автора — показывается PM с пометкой. */
export function hasNoAuthor(t: Task): boolean {
  return !t.created_by
}

/** Свои задачи для режима. PM: по pm_email, иначе по автору, плюс старые без автора; бригада: всё, что отдал RLS. */
export function ownTasks(tasks: Task[], mode: OwnMode, userId: string | null, userEmail: string | null = null): Task[] {
  if (mode === 'crew') return tasks
  const email = userEmail?.toLowerCase() ?? null
  return tasks.filter((t) => {
    if (t.pm_email) return !!email && t.pm_email.toLowerCase() === email
    return hasNoAuthor(t) || (!!userId && t.created_by === userId)
  })
}

/** Группировка по дням: дни по возрастанию, внутри дня — по времени начала, затем по порядку. */
export function groupByDay(tasks: Task[]): { date: string; tasks: Task[] }[] {
  const byDay = new Map<string, Task[]>()
  for (const t of tasks) {
    const d = t.scheduled_date || ''
    byDay.set(d, [...(byDay.get(d) ?? []), t])
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => ({
      date,
      tasks: [...list].sort(
        (a, b) => (a.sched_start ?? '').localeCompare(b.sched_start ?? '') || (a.stop_number ?? 0) - (b.stop_number ?? 0),
      ),
    }))
}

/* ---------------- Диапазон дат ---------------- */

export type RangePreset = 'this_week' | 'next_week' | 'this_month'

export const RANGE_PRESETS: { key: RangePreset; label: string }[] = [
  { key: 'this_week', label: 'This week' },
  { key: 'next_week', label: 'Next week' },
  { key: 'this_month', label: 'This month' },
]

/** Сдвиг ISO-даты на N дней. */
export function shiftDay(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00`) // полдень: сдвиг не срывается на переходе DST
  d.setDate(d.getDate() + days)
  return new Intl.DateTimeFormat('en-CA').format(d)
}

/** Границы периода от «сегодня» (ISO, в таймзоне компании). Неделя — с понедельника. */
export function presetRange(preset: RangePreset, today: string): { from: string; to: string } {
  const dow = new Date(`${today}T12:00:00`).getDay() // 0 = вс
  const monday = shiftDay(today, dow === 0 ? -6 : 1 - dow)
  if (preset === 'this_week') return { from: monday, to: shiftDay(monday, 6) }
  if (preset === 'next_week') return { from: shiftDay(monday, 7), to: shiftDay(monday, 13) }
  const [y, m] = today.split('-').map(Number)
  const last = new Date(y, m, 0).getDate()
  const mm = String(m).padStart(2, '0')
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, '0')}` }
}

/* ---------------- День бригады (BAS-1511) ---------------- */

/** День, который Lead Carpenter видит при открытии: завтра — смотрит, что предстоит. */
export function defaultCrewDay(today: string): string {
  return shiftDay(today, 1)
}
