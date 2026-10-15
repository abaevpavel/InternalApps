/**
 * Приоритет задачи (BAS-1434): High / Medium / Low, обязательный, по умолчанию Medium.
 * Чем выше приоритет, тем раньше задача стоит в дне своей бригады — это правило AI
 * получает из Persistent Prompt (см. PRIORITY_RULE), правок сценария n8n не нужно.
 */
export type TaskPriority = 'high' | 'medium' | 'low'

export const DEFAULT_PRIORITY: TaskPriority = 'medium'

export const PRIORITY_OPTIONS: { value: TaskPriority; label: string }[] = [
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
]

export function isTaskPriority(v: unknown): v is TaskPriority {
  return v === 'high' || v === 'medium' || v === 'low'
}

/** Значение из базы → приоритет; старое число (1–10) — по прежним границам бейджа. */
export function toPriority(v: unknown): TaskPriority {
  if (isTaskPriority(v)) return v
  if (typeof v === 'number') return v <= 3 ? 'high' : v >= 7 ? 'low' : 'medium'
  return DEFAULT_PRIORITY
}

export function priorityLabel(p: TaskPriority): string {
  return PRIORITY_OPTIONS.find((o) => o.value === p)?.label ?? 'Medium'
}

/**
 * Число для сценария n8n: «больше — важнее». Так приоритет уже читают формула второго
 * агента (`- 2 * priority`, меньше балл — лучше) и сортировка в ноде
 * `filter unassigned tasks` (большее вперёд). 1 = High отправлять нельзя — сработает наоборот.
 */
export const PRIORITY_RANK: Record<TaskPriority, number> = { high: 3, medium: 2, low: 1 }

/**
 * Правило для обоих агентов планировщика. Уходит полем `Persistent Prompt`: сценарий кладёт
 * его в блок FRONTEND_OVERRIDES, который по правилам промптов важнее стандартных правил
 * (уступает только якорям и запрету наложений). Переопределяется настройкой
 * `planner_priority_rule` приложения task-planner (app_settings).
 */
export const PRIORITY_RULE = [
  'TASK PRIORITY: each task has priority 3 = High, 2 = Medium, 1 = Low (priority_label repeats it as text).',
  "Within each crew's day, after anchors (exact time) and time windows are respected,",
  'place High tasks before Medium tasks, and Medium before Low.',
  'Within the same priority, minimize travel time.',
  'Priority outweighs travel time: a High task goes earlier in the day even if it adds driving.',
  'When inserting, shifting or reassigning tasks, keep this order.',
].join(' ')
