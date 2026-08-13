/**
 * Task Planner — исполнение задачи (экран My Tasks у бригадира + апрув у админа).
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
import { compressToJpeg } from '../../lib/imageCompression'
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

/** Очередь апрува: выполненные бригадирами задачи, ждущие подтверждения. */
export function fetchTasksAwaitingApproval(): Promise<Task[]> {
  return fetchTasks('scheduled', { executionStatus: 'completed' })
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

/* ---------------- Действия ---------------- */

/** Бригадир (или админ) отмечает задачу выполненной. Комментарий необязателен. */
export async function completeTask(taskId: string, comment?: string): Promise<void> {
  const sb = requireSupabase()
  const { error } = await sb.rpc('tp_complete_task', { p_task_id: taskId, p_comment: comment ?? null })
  if (error) throw error
}

/** Апрувер подтверждает выполнение — задача закрыта. */
export async function approveTask(taskId: string, comment?: string): Promise<void> {
  const sb = requireSupabase()
  const { error } = await sb.rpc('tp_approve_task', { p_task_id: taskId, p_comment: comment ?? null })
  if (error) throw error
}

/** Возврат на доработку. Комментарий обязателен — иначе бригадир не поймёт, что переделывать. */
export async function reworkTask(taskId: string, comment: string): Promise<void> {
  const sb = requireSupabase()
  const { error } = await sb.rpc('tp_rework_task', { p_task_id: taskId, p_comment: comment })
  if (error) throw error
}

/** Заметка к задаче (Notes → Add Note). Статус не меняет, ложится в ту же ленту. */
export async function addTaskNote(taskId: string, comment: string): Promise<void> {
  const sb = requireSupabase()
  const { error } = await sb.rpc('tp_add_task_note', { p_task_id: taskId, p_comment: comment })
  if (error) throw error
}

/**
 * Загрузка фото: жмём в JPEG (бригадиры снимают с телефона — исходники по 5 МБ),
 * кладём в приватный бакет, затем регистрируем путь через RPC (она же пишет событие).
 */
export async function uploadTaskPhoto(taskId: string, file: File): Promise<void> {
  const sb = requireSupabase()
  const body = await compressToJpeg(file, 600, 2000)
  const path = `${taskId}/${crypto.randomUUID()}.jpg`
  const { error: upErr } = await sb.storage
    .from(PHOTO_BUCKET)
    .upload(path, body, { upsert: false, contentType: 'image/jpeg' })
  if (upErr) throw upErr

  const { error } = await sb.rpc('tp_add_task_photo', { p_task_id: taskId, p_path: path })
  if (error) throw error
}

/* ---------------- Представление ---------------- */

// «Open», а не «In progress»: статуса «в работе» у нас нет намеренно (кнопки Start у
// бригадира нет, такой статус врал бы) — см. решение Р-6 в docs/TASK-PLANNER-ROLES.md.
export const EXECUTION_LABEL: Record<ExecutionStatus, string> = {
  pending: 'Open',
  completed: 'Awaiting approval',
  approved: 'Approved',
  rework: 'Needs rework',
}

export const EXECUTION_TONE: Record<ExecutionStatus, 'neutral' | 'warning' | 'success' | 'danger'> = {
  pending: 'neutral',
  completed: 'warning',
  approved: 'success',
  rework: 'danger',
}

/** Человеческая строка события для ленты истории. */
export function describeTaskEvent(e: TaskEvent): string {
  switch (e.event_type) {
    case 'completed':
      return 'Marked as complete'
    case 'approved':
      return 'Approved'
    case 'rework':
      return 'Sent back for rework'
    case 'note':
      return 'Note added'
    case 'photo':
      return 'Photo uploaded'
    default:
      return e.event_type
  }
}
