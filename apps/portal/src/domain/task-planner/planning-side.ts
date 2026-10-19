/**
 * Сторона планирования, вкладки по дню (BAS-1435). Planning всегда работает на завтра
 * (BAS-1433: «Planning is always tomorrow; Tracking is whatever date you pick»), поэтому:
 *  - Scheduled — утверждённое расписание на завтра, без закрытых;
 *  - Today — задачи сегодняшнего дня, ещё не закрытые PM (Uncompleted / Completed);
 *  - Closed — закрытые PM задачи за период, как на своей стороне PM.
 * Прошлые незакрытые задачи и даты дальше завтра сюда не попадают: они остаются на своём
 * дне (BAS-1430, BAS-1513) и видны в Tracking (BAS-1433).
 */
import { shiftDay } from './own-side'
import type { Task } from './types'

export type PlanningView = 'scheduled' | 'today' | 'closed'

/** День, на который работает Planning: завтра. */
export function planningDay(today: string): string {
  return shiftDay(today, 1)
}

/** В какую вкладку дня попадает утверждённая задача; null — ни в одну (другая дата). */
export function planningViewOf(t: Pick<Task, 'status' | 'execution_status' | 'scheduled_date'>, today: string): PlanningView | null {
  if (t.status !== 'scheduled') return null
  if (t.execution_status === 'closed') return 'closed'
  if (t.scheduled_date === today) return 'today'
  if (t.scheduled_date === planningDay(today)) return 'scheduled'
  return null
}

/** Задачи одной вкладки дня (для Closed период режет запрос, здесь только статус). */
export function tasksForView<T extends Pick<Task, 'status' | 'execution_status' | 'scheduled_date'>>(
  tasks: T[],
  view: PlanningView,
  today: string,
): T[] {
  return tasks.filter((t) => planningViewOf(t, today) === view)
}
