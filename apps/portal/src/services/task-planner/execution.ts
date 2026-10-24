/**
 * Task Planner — исполнение задачи (экран My Tasks: бригада отмечает, PM закрывает).
 *
 * Ось исполнения (`tp_tasks.execution_status`) НИКОГДА не пишется отсюда напрямую:
 * все переходы идут через security-definer RPC (миграция `0007_tp_task_execution.sql`),
 * которые сами проверяют право, меняют статус и пишут строку в журнал `tp_task_events`
 * одной транзакцией. Прямой UPDATE у бригадира закрыт RLS, прямой INSERT в журнал —
 * запрещён вообще всем, поэтому ленту нельзя подделать из браузера.
 *
 * Почему так, а не «UPDATE под RLS»: RLS ограничивает строки, а не колонки, а колоночные
 * гранты вешаются на роль `authenticated` — под ней ходит и админ, так что «пусть бригадир
 * пишет только execution_status» урезало бы заодно и его. Подробности — docs/TASK-PLANNER-ROLES.md §5.
 *
 * Фото лежат в ПРИВАТНОМ бакете `tp-task-photos` и показываются по подписанным ссылкам:
 * это снимки объектов клиентов, наружу по прямому URL они уходить не должны.
 */
import { requireSupabase, supabase } from '../../lib/supabase'
import { compressPhoto } from '../../lib/photoCompression'
import type { ExecutionStatus, Task, TaskEvent, TaskPhoto } from '../../domain/task-planner/types'
import { fetchTasks } from './data'

const PHOTO_BUCKET = 'tp-task-photos'
/** Время жизни подписанной ссылки на фото — хватает на просмотр, но ссылка не расходится. */
const SIGNED_URL_TTL_SEC = 60 * 60

/* ---------------- Чтение ---------------- */

/**
 * Задачи на выбранный день. Бригадиру RLS отдаст только его бригаду — фильтра по команде
 * здесь нет намеренно, чтобы в UI не появилось второго, обходимого контура.
 * Берём только `scheduled`: пока расписание не утверждено, исполнять нечего.
 */
export function fetchTasksForDay(date: string): Promise<Task[]> {
  return fetchTasks('scheduled', { date })
}

/**
 * Задачи утверждённого расписания за период (своя сторона, BAS-1510); без границ — за всё
 * время. Скоуп — тот же RLS.
 */
export function fetchTasksInRange(from?: string, to?: string): Promise<Task[]> {
  return fetchTasks('scheduled', { dateFrom: from, dateTo: to })
}

/** Лента событий задачи, свежие сверху. `limit` — сколько показать (окно info: 3). */
export async function fetchTaskEvents(taskId: string, limit = 20): Promise<TaskEvent[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('tp_task_events')
    .select('id, task_id, actor_email, actor_role, event_type, from_value, to_value, comment, created_at')
    .eq('task_id', taskId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data ?? []) as TaskEvent[]
}

/** Фото задачи + подписанные ссылки на них (бакет приватный, публичного URL нет). */
export async function fetchTaskPhotos(taskId: string): Promise<TaskPhoto[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('tp_task_photos')
    .select('id, task_id, path, created_at')
    .eq('task_id', taskId)
    .order('created_at', { ascending: false })
  if (error) throw error
  const rows = (data ?? []) as Omit<TaskPhoto, 'url'>[]
  if (rows.length === 0) return []

  const { data: signed } = await supabase.storage
    .from(PHOTO_BUCKET)
    .createSignedUrls(rows.map((r) => r.path), SIGNED_URL_TTL_SEC)
  const urlByPath = new Map((signed ?? []).map((s) => [s.path ?? '', s.signedUrl]))
  return rows.map((r) => ({ ...r, url: urlByPath.get(r.path) ?? null }))
}

/**
 * Сколько комментариев Lead Carpenter оставил к каждой задаче (BAS-1513) — для маркера
 * в списках. Считаются события журнала с текстом от бригадира: заметки и комментарий
 * к выполнению. `team_lead` — роль старых записей журнала (до 0028).
 */
export async function fetchCrewCommentCounts(taskIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (!supabase || !taskIds.length) return counts
  const { data, error } = await supabase
    .from('tp_task_events')
    .select('task_id')
    .in('task_id', taskIds)
    .in('actor_role', ['lead_carpenter', 'team_lead'])
    .not('comment', 'is', null)
  if (error) throw error
  for (const r of data ?? []) counts.set(r.task_id as string, (counts.get(r.task_id as string) ?? 0) + 1)
  return counts
}

/** Все события с текстом по набору задач, по возрастанию времени: task_id → события. */
export async function fetchCommentsForTasks(taskIds: string[]): Promise<Map<string, TaskEvent[]>> {
  const out = new Map<string, TaskEvent[]>()
  if (!supabase || !taskIds.length) return out
  const { data, error } = await supabase
    .from('tp_task_events')
    .select('id, task_id, actor_email, actor_role, event_type, from_value, to_value, comment, created_at')
    .in('task_id', taskIds)
    .not('comment', 'is', null)
    .order('created_at', { ascending: true })
  if (error) throw error
  for (const e of (data ?? []) as TaskEvent[]) out.set(e.task_id, [...(out.get(e.task_id) ?? []), e])
  return out
}

/** Подпись роли автора события. */
export function actorRoleLabel(role: string | null | undefined): string {
  switch (role) {
    case 'lead_carpenter':
    case 'team_lead':
      return 'Lead Carpenter'
    case 'pm':
      return 'PM'
    case 'schedule_manager':
      return 'Schedule Manager'
    case 'admin':
      return 'Admin'
    default:
      return role ?? ''
  }
}

/* ---------------- Действия ---------------- */

/** Бригадир (или админ) отмечает задачу выполненной. Комментарий необязателен. */
export async function completeTask(taskId: string, comment?: string): Promise<void> {
  const sb = requireSupabase()
  const { error } = await sb.rpc('tp_complete_task', { p_task_id: taskId, p_comment: comment ?? null })
  if (error) throw error
}

/**
 * PM закрывает задачу (BAS-1431) — из Completed или из Uncompleted. `accepted` — отметка
 * Task Accepted, комментарий необязателен. Закрытая задача — финал: назад не возвращается.
 */
export async function closeTask(taskId: string, accepted: boolean, comment?: string): Promise<void> {
  const sb = requireSupabase()
  const { error } = await sb.rpc('tp_close_task', { p_task_id: taskId, p_accepted: accepted, p_comment: comment ?? null })
  if (error) throw error
}

/** Комментарий PM к задаче без смены статуса; Lead Carpenter видит его в карточке. */
export async function addReviewComment(taskId: string, comment: string): Promise<void> {
  const sb = requireSupabase()
  const { error } = await sb.rpc('tp_add_review_comment', { p_task_id: taskId, p_comment: comment })
  if (error) throw error
}

/** Заметка к задаче (Notes → Add Note). Статус не меняет, ложится в ту же ленту. */
export async function addTaskNote(taskId: string, comment: string): Promise<void> {
  const sb = requireSupabase()
  const { error } = await sb.rpc('tp_add_task_note', { p_task_id: taskId, p_comment: comment })
  if (error) throw error
}

/**
 * Загрузка фото: перед загрузкой каждое фото сжимается в JPEG — длинная сторона до 1600 px,
 * размер до ~400 КБ (бригадиры снимают с телефона, исходники по 3–8 МБ; BAS-1442 — библиотекой,
 * HEIC с iPhone конвертируется). Затем файл кладётся в приватный бакет (лимит 2 МБ, 0044),
 * а путь регистрируется через RPC (она же пишет событие в журнал).
 */
export async function uploadTaskPhoto(taskId: string, file: File): Promise<void> {
  const sb = requireSupabase()
  const body = await compressPhoto(file, { maxKB: 400, maxDimension: 1600 })
  const path = `${taskId}/${crypto.randomUUID()}.jpg`
  const { error: upErr } = await sb.storage
    .from(PHOTO_BUCKET)
    .upload(path, body, { upsert: false, contentType: 'image/jpeg' })
  if (upErr) throw upErr

  const { error } = await sb.rpc('tp_add_task_photo', { p_task_id: taskId, p_path: path })
  if (error) throw error
}

/**
 * Удалить фото с задачи: функция в БД проверяет права, убирает запись и пишет событие
 * photo_removed в журнал; затем удаляем сам файл из бакета (миграция 0031).
 */
export async function removeTaskPhoto(photoId: string): Promise<void> {
  const sb = requireSupabase()
  const { data: path, error } = await sb.rpc('tp_remove_task_photo', { p_photo_id: photoId })
  if (error) throw error
  if (typeof path === 'string' && path) {
    // Запись уже удалена; если файл не удалился, он просто останется в бакете невидимым.
    await sb.storage.from(PHOTO_BUCKET).remove([path])
  }
}

/* ---------------- Представление ---------------- */

// «Open», а не «In progress»: статуса «в работе» у нас нет намеренно (кнопки Start у
// бригадира нет, такой статус врал бы) — см. решение Р-6 в docs/TASK-PLANNER-ROLES.md.
export const EXECUTION_LABEL: Record<ExecutionStatus, string> = {
  pending: 'Open',
  completed: 'Completed',
  closed: 'Closed',
}

export const EXECUTION_TONE: Record<ExecutionStatus, 'neutral' | 'warning' | 'success' | 'danger'> = {
  pending: 'neutral',
  completed: 'warning',
  closed: 'success',
}

/** Статус задачи для бейджа: у закрытой — ещё и результат проверки (Task Accepted). */
export function executionBadge(t: Pick<Task, 'execution_status' | 'task_accepted'>): {
  label: string
  tone: 'neutral' | 'warning' | 'success' | 'danger'
} {
  if (t.execution_status === 'closed') {
    return t.task_accepted === false
      ? { label: 'Closed · Not accepted', tone: 'danger' }
      : { label: 'Closed · Accepted', tone: 'success' }
  }
  return { label: EXECUTION_LABEL[t.execution_status], tone: EXECUTION_TONE[t.execution_status] }
}

/** Человеческая строка события для ленты истории. */
export function describeTaskEvent(e: TaskEvent): string {
  switch (e.event_type) {
    case 'completed':
      return 'Marked as complete'
    case 'closed':
      return 'Closed'
    case 'comment':
    case 'note':
      return 'Comment added'
    // Старые события до BAS-1431.
    case 'approved':
      return 'Approved'
    case 'rework':
      return 'Sent back for rework'
    case 'photo_removed':
      return 'Photo removed'
    case 'photo':
      return 'Photo uploaded'
    default:
      return e.event_type
  }
}
