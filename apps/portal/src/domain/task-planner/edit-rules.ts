/**
 * Правила правки и удаления задачи по статусу (BAS-1514):
 *  - Requested, Proposed, Scheduled — правка есть; Completed и Closed — нет (ось исполнения);
 *  - удаление — только в Requested; дальше задачу переносят на другой день (BAS-1437), не удаляют;
 *  - правка в Proposed и Scheduled не меняет план: тайминги не пересчитываются, в Slack не уходит.
 *    Поэтому длительность там не правится (её меняет Schedule Manager на доске Proposed),
 *    а дата не правится нигде — перенос делает BAS-1437.
 * Пока задачи ждут ответа AI, их не трогают (решение Vlad 19.10.2026).
 * Те же запреты для Completed и Closed держит база (миграция 0040), не только интерфейс.
 */
import type { Task } from './types'

export type EditableField = 'title' | 'description' | 'duration' | 'priority' | 'address'

/** Сколько ждём ответа AI, после этого пометка «отправлено в AI» перестаёт действовать (как поллинг). */
export const AI_WAIT_MS = 10 * 60 * 1000

type RuleTask = Pick<Task, 'status' | 'execution_status'> & Partial<Pick<Task, 'ai_request_id' | 'ai_sent_at'>>

/** Задача отправлена в AI и ответ ещё ждут. */
export function isWaitingForAi(t: Partial<Pick<Task, 'ai_request_id' | 'ai_sent_at'>>, now = Date.now()): boolean {
  if (!t.ai_request_id || !t.ai_sent_at) return false
  const sent = Date.parse(t.ai_sent_at)
  return Number.isFinite(sent) && now - sent < AI_WAIT_MS
}

/** Можно ли править задачу: статус до исполнения и бригада её ещё не отметила. */
export function canEditTask(t: RuleTask, now = Date.now()): boolean {
  if (t.execution_status !== 'pending') return false
  if (isWaitingForAi(t, now)) return false
  return t.status === 'requested' || t.status === 'proposed' || t.status === 'scheduled'
}

/** Можно ли удалить задачу: только Requested. */
export function canDeleteTask(t: RuleTask, now = Date.now()): boolean {
  return t.status === 'requested' && t.execution_status === 'pending' && !isWaitingForAi(t, now)
}

/** Какие поля правятся в этом статусе. */
export function editableFields(t: RuleTask): EditableField[] {
  return t.status === 'requested'
    ? ['title', 'description', 'duration', 'priority', 'address']
    : ['title', 'description', 'priority', 'address']
}
