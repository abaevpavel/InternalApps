/**
 * Data-layer: единый доступ к задачам/справочникам. Если Supabase is not configured —
 * отдаёт mock-данные (каркас работает офлайн). Реальные запросы добавляются
 * позже без изменения UI (фаза 2).
 */
import { supabase } from '../../lib/supabase'
import { unescapeNewlines } from '../../lib/utils'
import { DEFAULT_OVERTIME_LIMIT_MIN } from '../../domain/task-planner/overtime'
import { TP_ROLES } from '../../domain/task-planner/permissions'
import { toAvailabilityKind, type AvailabilityKind } from '../../domain/task-planner/availability'
import type { ExecutionStatus, Project, ScheduleRun, Skill, Task, Team, TeamAvailability, TeamSkill } from '../../domain/task-planner/types'
import { DEFAULT_PRIORITY, toPriority, type TaskPriority } from '../../domain/task-planner/priority'
import { buildAiApplyItems, type AiUnscheduled, type AiWarning } from '../../domain/task-planner/ai-overlay'

export async function fetchTasks(
  status?: Task['status'],
  opts?: { date?: string; dateFrom?: string; dateTo?: string; executionStatus?: ExecutionStatus | ExecutionStatus[] },
): Promise<Task[]> {
  if (!supabase) return []
  // ВАЖНО: FK tasks→teams в схеме нет, поэтому embed teams(...) даёт 400.
  // Имя бригады подтягиваем отдельным запросом и резолвим по team_id на клиенте.
  let q = supabase
    .from('tp_tasks')
    // алиас projects: → таблица переименована в tp_projects, ключ в ответе оставляем прежним
    .select('*, projects:tp_projects(name,address,project_manager,latitude,longitude)')
    .order('stop_number', { ascending: true })
  if (status) q = q.eq('status', status)
  // Скоуп «своя бригада» тут НЕ ставим: его держит RLS (миграция 0007), одинаково для
  // любого запроса — фильтр в UI не обходится прямым запросом с anon-ключом.
  if (opts?.date) q = q.eq('scheduled_date', opts.date)
  if (opts?.dateFrom) q = q.gte('scheduled_date', opts.dateFrom)
  if (opts?.dateTo) q = q.lte('scheduled_date', opts.dateTo)
  if (opts?.executionStatus) {
    q = Array.isArray(opts.executionStatus)
      ? q.in('execution_status', opts.executionStatus)
      : q.eq('execution_status', opts.executionStatus)
  }
  const { data, error } = await q
  if (error) throw error
  if (!data || data.length === 0) return []
  // карта team_id → {name, home} для подстановки имени и домашнего адреса бригады
  const { data: teamRows } = await supabase.from('tp_teams').select('id, name, address')
  const teamInfo = new Map(
    (teamRows ?? []).map((t) => [t.id as string, { name: t.name as string, home: (t.address as string) ?? '' }]),
  )
  return data.map((r) => mapDbTask(r, teamInfo))
}

/** Маппинг реальной строки tasks → доменный Task (по подтверждённой схеме БД). */
function mapDbTask(r: Record<string, any>, teamInfo?: Map<string, { name: string; home: string }>): Task {
  const st = r.scheduled_time ?? null // jsonb {start,end,anchor,anchor_time}
  const isAnchor = st?.anchor === true || st?.type === 'exact'
  const proj = r.projects ?? null
  const rawStop = r.additional_stop
  // БД хранит ключ `timing` ('before'|'after'); движок/типы ждут `when`. Нормализуем.
  const stop = rawStop
    ? {
        ...rawStop,
        when: rawStop.when ?? rawStop.timing ?? 'after',
        duration_min: rawStop.duration_min ?? r.additional_stop_duration ?? 30,
      }
    : null
  return {
    id: r.id,
    status: r.status ?? 'requested',
    // ось исполнения (миграция 0007). Старые строки, где колонки ещё нет/она null,
    // читаем как 'pending' — legacy-флаг completed backfill'ится миграцией.
    execution_status: r.execution_status ?? 'pending',
    completed_at: r.completed_at ?? null,
    task_accepted: r.task_accepted ?? null,
    closed_at: r.closed_at ?? null,
    ai_request_id: r.ai_request_id ?? null,
    ai_warnings: Array.isArray(r.ai_warnings) && r.ai_warnings.length ? r.ai_warnings : null,
    anchor_moved_from: r.anchor_moved_from ?? null,
    requested_team_id: r.requested_team_id ?? null,
    ai_sent_at: r.ai_sent_at ?? null,
    created_by: r.created_by ?? null,
    pm_email: r.pm_email ?? null,
    task_type: r.task_type ?? 'Project task',
    project_id: r.project_id ?? null,
    project_name: proj?.name,
    title: r.title,
    // В описаниях из синка переносы строк приходят буквами «\n» (49 из 54 задач на 24.10.2026) —
    // показываем их как настоящие переносы (BAS-1512).
    description: unescapeNewlines(r.description ?? r.title ?? ''),
    scheduled_date: r.scheduled_date ?? '',
    time_type: isAnchor ? 'exact' : st?.start ? 'timeframe' : null,
    // exact-якорь хранится как {type:'exact', time} (новый формат) или {start/anchor_time} (старый)
    exact_time: isAnchor ? st?.time || st?.anchor_time || st?.start || null : null,
    timeframe_start: !isAnchor ? st?.start ?? null : null,
    timeframe_end: !isAnchor ? st?.end ?? null : null,
    estimated_duration_min: Math.round((Number(r.estimated_duration) || 0) * 60), // часы → минуты
    task_address: r.address ?? proj?.address ?? '',
    lat: proj?.latitude ?? null,
    lng: proj?.longitude ?? null,
    project_manager: r.project_manager ?? proj?.project_manager ?? '',
    assigned_team_id: r.team_id ?? null,
    assigned_team_name: r.teams?.name ?? (r.team_id ? teamInfo?.get(r.team_id)?.name : undefined),
    assigned_team_home_base: r.team_id ? teamInfo?.get(r.team_id)?.home : undefined,
    priority: toPriority(r.priority),
    required_skill_ids: r.skill_requirements ?? r.required_skills ?? [],
    schedule_prompt: r.schedule_prompt ?? null,
    additional_stop: stop,
    stop_number: r.stop_number ?? null,
    request_task_id: r.request_task_id ?? null,
    sched_start: st?.start ?? null,
    sched_end: st?.end ?? null,
    travel_time: r.travel_time ?? null,
    anchor: isAnchor,
    anchor_time: st?.anchor_time || (isAnchor ? st?.start : '') || '',
  }
}

export async function fetchTeams(): Promise<Team[]> {
  if (!supabase) return []
  // скиллы команды связаны через skills.description ("Available teams: recAAA, recBBB").
  // Тянем skills параллельно и инвертируем маппинг скилл→команды в команда→скиллы.
  const [teamsRes, skillsRes] = await Promise.all([
    // Неактивные (пропали из Airtable, миграция 0037) не предлагаются и не уходят в AI.
    supabase.from('tp_teams').select('*').eq('is_active', true),
    supabase.from('tp_skills').select('name, description'),
  ])
  if (teamsRes.error) throw teamsRes.error
  const skillsByTeam = new Map<string, TeamSkill[]>()
  for (const s of skillsRes.data ?? []) {
    const skill = splitSkillLevel((s as { name: string }).name)
    for (const tid of parseAvailableTeams((s as { description: string | null }).description)) {
      const arr = skillsByTeam.get(tid) ?? []
      arr.push(skill)
      skillsByTeam.set(tid, arr)
    }
  }
  return (teamsRes.data ?? []).map((r): Team => ({
    id: r.id, airtable_id: r.airtable_id, name: r.name,
    home_address: r.address ?? '', lat: r.latitude, lng: r.longitude,
    slack_user_id: r.slack_id,
    skills: r.airtable_id ? skillsByTeam.get(r.airtable_id) ?? [] : [],
    overtime_limit_min: r.overtime_limit_minutes ?? DEFAULT_OVERTIME_LIMIT_MIN,
  }))
}

export async function fetchProjects(): Promise<Project[]> {
  if (!supabase) return []
  const { data, error } = await supabase.from('tp_projects').select('*')
  if (error) throw error
  return (data ?? []).map((r): Project => ({
    id: r.id, airtable_id: r.airtable_id, name: r.name, address: r.address ?? '',
    lat: r.latitude, lng: r.longitude, project_manager: r.project_manager ?? '',
    slack_id: r.slack_id ?? null,
  }))
}

/**
 * Бригада текущего юзера — по совпадению email (основа роли `team_lead`, см.
 * `pages/task-planner/useTaskPlannerRole.ts`). Узкий запрос: три колонки, без скиллов.
 * `ilike` без wildcard = регистронезависимое равенство. Зеркалит SQL-функцию
 * `tp_my_team_id()` из миграции 0006, которая тем же правилом скоупит RLS.
 */
export async function fetchTeamByEmail(email: string): Promise<{ id: string; name: string } | null> {
  if (!supabase || !email) return null
  const { data, error } = await supabase
    .from('tp_teams')
    .select('id, name')
    .ilike('email', email)
    .maybeSingle()
  if (error) throw error
  return data ? { id: data.id as string, name: (data.name as string) ?? '' } : null
}

/** Аккаунты команд для Admin → Team (сырые строки teams: email/адрес/slack/статус). */
export async function fetchTeamAccounts(): Promise<import('../../domain/task-planner/types').TeamAccount[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('tp_teams')
    .select('id, name, email, address, slack_id, account_status')
    .order('name')
  if (error) throw error
  return (data ?? []).map((r): import('../../domain/task-planner/types').TeamAccount => ({
    id: r.id, name: r.name, email: r.email ?? null, address: r.address ?? null,
    slack_id: r.slack_id ?? null, account_status: r.account_status ?? null,
  }))
}

/**
 * Бригады для Directories → Team (BAS-1441): строка tp_teams + роли модуля того, кто входит
 * в портал с email бригады. Роли — из app_user_roles через `tp_team_roles()` (миграция 0029,
 * только Admin модуля); старые роли Lovable из tp_user_roles больше не показываются.
 * Если функции ещё нет или нет прав — роли пустые, список бригад всё равно отдаётся.
 */
export async function fetchTeamMembers(): Promise<import('../../domain/task-planner/types').TeamMember[]> {
  if (!supabase) return []
  const [tRes, rRes] = await Promise.all([
    supabase.from('tp_teams').select('id, name, email, address, account_status, is_active').order('name'),
    supabase.rpc('tp_team_roles'),
  ])
  if (tRes.error) throw tRes.error
  const rolesByTeam = new Map<string, { hasAccount: boolean; roles: string[] }>()
  for (const r of ((rRes.error ? [] : rRes.data) ?? []) as { team_id: string; has_account: boolean; roles: string[] | null }[]) {
    rolesByTeam.set(r.team_id, { hasAccount: r.has_account, roles: r.roles ?? [] })
  }
  const label = (key: string) => TP_ROLES.find((r) => r.key === key)?.label ?? key
  return ((tRes.data ?? []) as Record<string, any>[]).map((t): import('../../domain/task-planner/types').TeamMember => {
    const info = rolesByTeam.get(t.id)
    return {
      id: t.id,
      name: t.name,
      email: t.email ?? null,
      address: t.address ?? null,
      role: info?.roles.length ? info.roles.map(label).join(', ') : null,
      hasAccount: info ? info.hasAccount : null,
      // Неактивная (пропала из Airtable) — это важнее статуса аккаунта.
      status: t.is_active === false ? 'inactive · not in Airtable' : t.account_status ?? null,
    }
  })
}

/**
 * Синк из Airtable — через Supabase Edge Functions (НЕ n8n). Запускает по очереди.
 * Функции: sync-airtable-projects | sync-airtable-teams | sync-airtable-skills |
 * sync-team-accounts | auto-sync-airtable.
 */
export async function runEdgeSync(fns: string[]): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured')
  for (const fn of fns) {
    const { error } = await supabase.functions.invoke(fn)
    if (error) throw new Error(`${fn}: ${error.message ?? error}`)
  }
}


/* ---------------- Task Types CRUD (Admin) ---------------- */
export async function createTaskType(name: string, description?: string): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured')
  const { error } = await supabase.from('tp_task_types').insert({ name, description: description ?? null })
  if (error) throw error
}
export async function updateTaskType(id: string, name: string, description?: string): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured')
  const { error } = await supabase.from('tp_task_types').update({ name, description: description ?? null }).eq('id', id)
  if (error) throw error
}
export async function deleteTaskType(id: string): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured')
  const { error } = await supabase.from('tp_task_types').delete().eq('id', id)
  if (error) throw error
}

/**
 * app_settings — key/value настройки приложения (тянем из БД, не хардкодим).
 * Сейчас используется для URL вебхука планировщика (редактируется в Админке).
 */
export async function fetchSetting(key: string): Promise<string | null> {
  if (!supabase) return null
  const { data, error } = await supabase.from('tp_app_settings').select('value').eq('key', key).maybeSingle()
  if (error) throw error
  return (data?.value as string | undefined) ?? null
}
export async function updateSetting(key: string, value: string): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured')
  const { error } = await supabase.from('tp_app_settings').upsert({ key, value }, { onConflict: 'key' })
  if (error) throw error
}

/* ---------------- Профиль текущего пользователя ---------------- */

/** Имя/фамилия текущего юзера из profiles (по auth uid). null, если строки нет. */
export async function fetchMyProfile(): Promise<{ first_name: string; last_name: string } | null> {
  if (!supabase) return null
  const { data: auth } = await supabase.auth.getUser()
  const uid = auth.user?.id
  if (!uid) return null
  // ВАЖНО: auth-uid лежит в user_id; tp_profiles.id — самостоятельный gen_random_uuid().
  const { data, error } = await supabase.from('tp_profiles').select('first_name, last_name').eq('user_id', uid).maybeSingle()
  if (error) throw error
  return data ? { first_name: data.first_name ?? '', last_name: data.last_name ?? '' } : null
}

/** Сохранить имя/фамилию в profiles (своя строка, RLS: user_id = auth.uid()). */
export async function updateMyProfile(firstName: string, lastName: string): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured')
  const { data: auth } = await supabase.auth.getUser()
  const uid = auth.user?.id
  if (!uid) throw new Error('Not signed in')
  // upsert по user_id: у портальных юзеров (PM/админ) строки в tp_profiles может не быть —
  // её создаёт только sync-team-accounts для бригадиров, триггера на auth.users нет.
  const { data: auth2 } = await supabase.auth.getUser()
  const { error } = await supabase
    .from('tp_profiles')
    .upsert(
      { user_id: uid, email: auth2.user?.email ?? null, first_name: firstName, last_name: lastName },
      { onConflict: 'user_id' },
    )
  if (error) throw error
}

/** Сменить пароль текущего юзера. */
export async function updateMyPassword(password: string): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured')
  const { error } = await supabase.auth.updateUser({ password })
  if (error) throw error
}

/** "Material Handling & Staging - 2" → { name: "Material Handling & Staging", level: 2 }. */
function splitSkillLevel(full: string): TeamSkill {
  const m = /^(.+?)\s*-\s*(\d+)\s*$/.exec(full)
  return m ? { name: m[1].trim(), level: Number(m[2]) } : { name: full.trim(), level: null }
}

/** "Available teams: recAAA, recBBB" в skills.description → airtable_id команд. */
function parseAvailableTeams(description: string | null): string[] {
  if (!description) return []
  const m = /Available teams:\s*(.+)/i.exec(description)
  if (!m) return []
  return m[1].split(',').map((s) => s.trim()).filter(Boolean)
}

export async function fetchSkills(): Promise<Skill[]> {
  if (!supabase) return []
  const { data, error } = await supabase.from('tp_skills').select('*')
  if (error) throw error
  return (data ?? []).map((r): Skill => ({
    id: r.id, name: r.name, category: r.category ?? 'Uncategorized',
    description: r.description ?? undefined,
    available_team_ids: parseAvailableTeams(r.description),
  }))
}

/** Типы задач из БД (task_types) — для дропдауна Task Type (никакого хардкода). */
export async function fetchTaskTypes(): Promise<import('../../domain/task-planner/types').TaskType[]> {
  if (!supabase) return []
  const { data, error } = await supabase.from('tp_task_types').select('id, name, description').order('name')
  if (error) throw error
  return (data ?? []).map((r): import('../../domain/task-planner/types').TaskType => ({ id: r.id, name: r.name, description: r.description ?? null }))
}

export async function fetchAvailability(): Promise<TeamAvailability[]> {
  if (!supabase) return []
  // team_availability ссылается на team_id; имя команды подтянем join'ом
  const { data, error } = await supabase
    .from('tp_team_availability')
    .select('id, team_id, start_date, end_date, kind, note, teams:tp_teams(name)')
  if (error) throw error
  return (data ?? []).map((r: Record<string, unknown>): TeamAvailability => ({
    id: r.id as string, team_id: r.team_id as string,
    team_name: (r.teams as { name?: string } | null)?.name ?? '',
    start_date: r.start_date as string, end_date: r.end_date as string,
    kind: toAvailabilityKind(r.kind), note: (r.note as string | null) ?? null,
  }))
}

export interface AvailabilityInput {
  teamId: string
  startDate: string
  endDate: string
  kind: AvailabilityKind
  note?: string | null
}

/** Добавить период недоступности команды. Возвращает id новой записи. */
export async function createAvailability(input: AvailabilityInput): Promise<string> {
  if (!supabase) throw new Error('Supabase is not configured')
  const { data: auth } = await supabase.auth.getUser()
  const { data, error } = await supabase.from('tp_team_availability').insert({
    team_id: input.teamId, start_date: input.startDate, end_date: input.endDate,
    kind: input.kind, note: input.note?.trim() || null, created_by: auth.user?.id ?? null,
  }).select('id').single()
  if (error) throw error
  return data.id as string
}

/** Изменить период недоступности (BAS-1446). */
export async function updateAvailability(id: string, input: AvailabilityInput): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured')
  const { error } = await supabase.from('tp_team_availability').update({
    team_id: input.teamId, start_date: input.startDate, end_date: input.endDate,
    kind: input.kind, note: input.note?.trim() || null,
  }).eq('id', id)
  if (error) throw error
}

/** Удалить период недоступности. */
export async function deleteAvailability(id: string): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured')
  const { error } = await supabase.from('tp_team_availability').delete().eq('id', id)
  if (error) throw error
}

/* ---------------- Запись (фаза 2) ---------------- */

/** Полезная нагрузка для создания задачи (Create Task → INSERT в tasks). */
export interface CreateTaskInput {
  task_type: string
  project_id: string | null
  description: string
  title?: string
  scheduled_date: string
  /** jsonb {start,end} для timeframe; {anchor:true,anchor_time} для exact; null если без времени */
  scheduled_time: Record<string, unknown> | null
  estimated_duration_min: number
  address: string
  project_manager?: string
  team_id?: string | null
  priority?: TaskPriority
  skill_requirements?: string[]
  schedule_prompt?: string | null
  additional_stop?: Record<string, unknown> | null
  created_by?: string | null
  pm_email?: string | null
  /** Исходная задача, если эта создана после непринятой работы (BAS-1431). Только бэкенд. */
  origin_task_id?: string | null
}

/** INSERT новой задачи (status=requested). Возвращает id. */
export async function createTask(input: CreateTaskInput): Promise<string> {
  if (!supabase) throw new Error('Supabase is not configured')
  const row = {
    status: 'requested',
    task_type: input.task_type,
    project_id: input.project_id,
    description: input.description,
    // title в tp_tasks обязателен (not null), а форма его не спрашивает — берём первую
    // строку описания, как materializeProposedCopies. Без этого Create Task падал с 23502.
    title: (input.title?.trim() || input.description.split('\n')[0].trim() || 'Task').slice(0, 200),
    scheduled_date: input.scheduled_date,
    scheduled_time: input.scheduled_time,
    estimated_duration: input.estimated_duration_min / 60, // минуты → часы (схема хранит часы)
    address: input.address,
    project_manager: input.project_manager ?? null,
    team_id: input.team_id ?? null,
    priority: input.priority ?? DEFAULT_PRIORITY,
    skill_requirements: input.skill_requirements ?? [],
    schedule_prompt: input.schedule_prompt ?? null,
    additional_stop: input.additional_stop ?? null,
    created_by: input.created_by ?? null,
    pm_email: input.pm_email ? input.pm_email.toLowerCase() : null,
    origin_task_id: input.origin_task_id ?? null,
  }
  const { data, error } = await supabase.from('tp_tasks').insert(row).select('id').single()
  if (error) throw error
  return (data as { id: string }).id
}

/** Поля, доступные для редактирования задачи (Edit Task). */
export interface UpdateTaskInput {
  title?: string
  description?: string
  estimated_duration_min?: number
  priority?: TaskPriority
  scheduled_date?: string
  address?: string
  /** Бригада заявки — правится только в Requested (BAS-1446: заменить бригаду в отпуске). */
  team_id?: string | null
}

/** UPDATE существующей задачи (точечная правка полей). */
export async function updateTask(id: string, input: UpdateTaskInput): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured')
  const row: Record<string, unknown> = {}
  if (input.title !== undefined) row.title = input.title
  if (input.description !== undefined) row.description = input.description
  if (input.estimated_duration_min !== undefined) row.estimated_duration = input.estimated_duration_min / 60
  if (input.priority !== undefined) row.priority = input.priority
  if (input.scheduled_date !== undefined) row.scheduled_date = input.scheduled_date
  if (input.address !== undefined) row.address = input.address
  if (input.team_id !== undefined) row.team_id = input.team_id
  if (!Object.keys(row).length) return
  const { error } = await supabase.from('tp_tasks').update(row).eq('id', id)
  if (error) throw error
}

/** Удаление задачи. */
export async function deleteTask(id: string): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured')
  const { error } = await supabase.from('tp_tasks').delete().eq('id', id)
  if (error) throw error
}

/** Массовая смена статуса задач (requested→proposed, proposed→scheduled, →archived). */
export async function updateTasksStatus(ids: string[], status: Task['status']): Promise<void> {
  if (!ids.length) return
  if (!supabase) throw new Error('Supabase is not configured')
  const { error } = await supabase.from('tp_tasks').update({ status }).in('id', ids)
  if (error) throw error
}

/**
 * Применить одобренное расписание к задачам: записать время/бригаду/порядок и
 * перевести в status=scheduled. Источник — (возможно отредактированные) TeamDay[].
 */
export async function applyScheduleToTasks(
  days: import('../../domain/task-planner/types').TeamDay[],
  status: 'proposed' | 'scheduled' = 'scheduled',
): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured')
  // Окно времени оригинала (`scheduled_time.requested`) не затираем — переносим как было.
  const ids = days.flatMap((d) => d.tasks.map((t) => t.task_id))
  const requestedById = new Map<string, unknown>()
  if (ids.length) {
    const { data: cur, error: curErr } = await supabase.from('tp_tasks').select('id, scheduled_time').in('id', ids)
    if (curErr) throw curErr
    for (const r of cur ?? []) {
      const req = (r.scheduled_time as Record<string, unknown> | null)?.requested
      if (req) requestedById.set(r.id as string, req)
    }
  }
  const updates: Promise<void>[] = []
  for (const day of days) {
    for (const t of day.tasks) {
      const scheduled_time: Record<string, unknown> = t.anchor
        ? { start: t.start_time, end: t.end_time, anchor: true, anchor_time: t.anchor_time }
        : { start: t.start_time, end: t.end_time }
      if (requestedById.has(t.task_id)) scheduled_time.requested = requestedById.get(t.task_id)
      updates.push(
        (async () => {
          const { error } = await supabase!
            .from('tp_tasks')
            .update({
              status,
              team_id: day.team_id === 'unassigned' ? null : day.team_id,
              stop_number: t.scheduled_order,
              scheduled_time,
              estimated_duration: t.duration_minutes / 60,
              travel_time: t.drive_minutes_from_previous,
            })
            .eq('id', t.task_id)
          if (error) throw error
        })(),
      )
    }
  }
  await Promise.all(updates)
}

/**
 * Люди для выбора PM задачи — Contacts Directory «All employees» через функцию tp_people()
 * (миграция 0032): имя и email.
 */
export async function fetchPeople(): Promise<{ full_name: string; email: string }[]> {
  if (!supabase) return []
  const { data, error } = await supabase.rpc('tp_people')
  if (error) throw error
  return (data ?? []) as { full_name: string; email: string }[]
}

/**
 * Сменить PM задачи (миграция 0034): сама задача и её копии в Proposed / Scheduled.
 * PM — только из справочника людей; в историю модуля изменение пишет триггер.
 */
export async function setTaskPm(taskId: string, email: string): Promise<number> {
  if (!supabase) throw new Error('Supabase is not configured')
  const { data, error } = await supabase.rpc('tp_set_task_pm', { p_task_id: taskId, p_email: email })
  if (error) throw error
  return (data ?? 0) as number
}

/** Люди, добавленные поверх справочника (тестовые аккаунты, миграция 0035): email → пометка. */
export async function fetchExtraPeopleNotes(): Promise<Map<string, string>> {
  if (!supabase) return new Map()
  const { data, error } = await supabase.rpc('tp_people_extra_notes')
  if (error) throw error
  return new Map(((data ?? []) as { email: string; note: string | null }[]).map((r) => [r.email, r.note ?? 'added manually']))
}

/**
 * Вернуть утверждённое расписание дня обратно в Proposed одной пачкой (кнопка Back to Proposed
 * во вкладке Scheduled). Только задачи, которые бригада ещё не трогала (`pending`): выполненные
 * и закрытые остаются в Scheduled. Раскладка (бригада, порядок, время) сохраняется как была.
 */
export async function returnScheduledToProposed(date: string): Promise<number> {
  if (!supabase) throw new Error('Supabase is not configured')
  const { data, error } = await supabase
    .from('tp_tasks')
    .update({ status: 'proposed' })
    .eq('status', 'scheduled')
    .eq('execution_status', 'pending')
    .eq('scheduled_date', date)
    .select('id')
  if (error) throw error
  return (data ?? []).length
}

/**
 * Подтянуть ответ планировщика (по requestId или последний) и наложить его на задачи, которые
 * ждут этот запрос (TP-1.1). Спасает от таймаута/refresh. Возвращает число применённых задач.
 */
export async function pullScheduleIntoTasks(requestId?: string): Promise<number> {
  const run = await fetchScheduleRun(requestId)
  if (!run?.output_data?.schedule) return 0
  return applyAiRun(run)
}

/**
 * Наложить ответ AI на задачи (TP-1.1, миграция 0041): та же строка, из ответа — только поля
 * расписания, вопросы к задаче — пометками (`buildAiApplyItems`). Применяет функция БД одной
 * транзакцией и пишет журнал для разработчика. Задачи, которые больше не ждут этот запрос,
 * пропускаются (в журнал как ignored).
 */
export async function applyAiRun(run: ScheduleRun): Promise<number> {
  if (!supabase) throw new Error('Supabase is not configured')
  const sent = await fetchTasksWaitingFor(run.request_id)
  if (!sent.length) return 0
  const date = sent[0].scheduled_date
  const [teams, unavailable] = await Promise.all([fetchTeams(), fetchAvailability()])
  const c2 = (run.comments_ai_2 && typeof run.comments_ai_2 === 'object' ? run.comments_ai_2 : {}) as Record<string, unknown>
  const items = buildAiApplyItems({
    sent,
    schedule: run.output_data?.schedule ?? [],
    unscheduled: Array.isArray(c2.unscheduled) ? (c2.unscheduled as AiUnscheduled[]) : [],
    teams, unavailable, date,
  })
  const { data, error } = await supabase.rpc('tp_ai_apply', { p_request_id: run.request_id, p_date: date, p_items: items })
  if (error) throw error
  return (data ?? 0) as number
}

/** Задачи Requested, которые ждут ответ этого запроса. */
async function fetchTasksWaitingFor(requestId: string): Promise<Task[]> {
  const list = await fetchTasks('requested')
  return list.filter((t) => t.ai_request_id === requestId)
}

/**
 * Перенести задачу на другой день (BAS-1437, миграция 0041): та же строка, статус requested,
 * поля расписания от AI снимаются, бригада и окно времени возвращаются к заявленным.
 * Якорь (BAS-1436, 0043): anchor не передан — время прежнее, задачу пометят «проверить время»;
 * '' — снять якорь; 'HH:MM' — новое точное время.
 */
export async function moveTask(taskId: string, date: string, anchor?: string): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured')
  const { error } = await supabase.rpc('tp_move_task', {
    p_task_id: taskId, p_date: date, ...(anchor !== undefined ? { p_anchor: anchor } : {}),
  })
  if (error) throw error
}

/** Поменять ('HH:MM'), снять ('') или подтвердить (без параметра) время якоря в Requested (BAS-1436). */
export async function setTaskAnchor(taskId: string, anchor?: string): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured')
  const { error } = await supabase.rpc('tp_set_task_anchor', {
    p_task_id: taskId, ...(anchor !== undefined ? { p_anchor: anchor } : {}),
  })
  if (error) throw error
}

/** Строка журнала прогонов AI (только Developer, миграция 0041). */
export interface AiRunLogRow {
  id: number
  request_id: string
  batch_date: string | null
  task_id: string | null
  kind: 'sent' | 'applied' | 'ignored'
  sent: Record<string, unknown> | null
  received: unknown
  applied: { before?: Record<string, unknown>; after?: Record<string, unknown> } | null
  warnings: AiWarning[] | null
  note: string | null
  created_at: string
}

export async function fetchAiRunLog(limit = 2000): Promise<AiRunLogRow[]> {
  if (!supabase) return []
  const { data, error } = await supabase.from('tp_ai_run_log').select('*').order('id', { ascending: false }).limit(limit)
  if (error) throw error
  return (data ?? []) as AiRunLogRow[]
}

export async function fetchScheduleRun(requestId?: string): Promise<ScheduleRun | null> {
  if (!supabase) return null
  // реальная таблица — AI_teams_schedule; comments лежат внутри output_data
  let q = supabase
    .from('tp_ai_teams_schedule')
    .select('id, created_at, request_ID, output_data')
    .order('created_at', { ascending: false })
    .limit(1)
  if (requestId) q = supabase
    .from('tp_ai_teams_schedule')
    .select('id, created_at, request_ID, output_data')
    .eq('request_ID', requestId)
    .limit(1)
  const { data, error } = await q
  if (error) throw error
  const row = data?.[0] as Record<string, unknown> | undefined
  if (!row) return null
  const out = (row.output_data ?? {}) as Record<string, unknown>
  return {
    request_id: row.request_ID as string,
    status: out.schedule ? 'done' : 'processing',
    output_data: out.schedule ? { schedule: out.schedule as never } : null,
    comments_ai_1: out['commentsAI-1'] ?? {},
    comments_ai_2: out['commentsAI-2'] ?? {},
    created_at: row.created_at as string,
  }
}

/* ---------------- Travel-кэш (Supabase travel_cache) ---------------- */

/**
 * Читает закэшированные travel-времена по парам адресов.
 * Возвращает Map по ключу `from|to` → минуты. Устойчиво: если таблицы нет
 * или запрос упал — возвращает пусто (работаем без кэша).
 */
export async function fetchTravelCache(pairs: [string, string][]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (!supabase || !pairs.length) return out
  const froms = [...new Set(pairs.map(([f]) => f).filter(Boolean))]
  const tos = [...new Set(pairs.map(([, t]) => t).filter(Boolean))]
  if (!froms.length || !tos.length) return out
  try {
    const { data, error } = await supabase
      .from('tp_travel_cache')
      .select('from_address,to_address,minutes')
      .in('from_address', froms)
      .in('to_address', tos)
    if (error) return out
    for (const r of data ?? []) out.set(`${r.from_address}|${r.to_address}`, r.minutes as number)
  } catch {
    /* нет таблицы travel_cache — игнорируем, работаем без кэша */
  }
  return out
}

/** Upsert новых travel-рёбер в кэш. Устойчиво к отсутствию таблицы/RLS. */
export async function saveTravelCache(entries: { from: string; to: string; minutes: number }[]): Promise<void> {
  if (!supabase || !entries.length) return
  try {
    await supabase
      .from('tp_travel_cache')
      .upsert(
        entries.map((e) => ({ from_address: e.from, to_address: e.to, minutes: e.minutes })),
        { onConflict: 'from_address,to_address' },
      )
  } catch {
    /* нет таблицы / RLS не пускает запись — игнорируем */
  }
}

/**
 * Пометка «отправлено в AI» (BAS-1514, 0040): задачи, ушедшие в планировщик, недоступны
 * у всех пользователей, пока ждут ответа. Снимается при ответе, ошибке или по времени ожидания.
 */
export async function markSentToAi(ids: string[], requestId: string, date: string): Promise<number> {
  if (!ids.length) return 0
  if (!supabase) throw new Error('Supabase is not configured')
  // 0041: функция помечает только Requested этого дня и снимает снимок для журнала
  const { data, error } = await supabase.rpc('tp_ai_mark_sent', { p_request_id: requestId, p_date: date, p_task_ids: ids })
  if (error) throw error
  return (data ?? 0) as number
}

export async function clearSentToAi(requestId: string): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured')
  const { error } = await supabase.from('tp_tasks')
    .update({ ai_request_id: null, ai_sent_at: null }).eq('ai_request_id', requestId)
  if (error) throw error
}

/**
 * Лимит переработки бригады (BAS-1445): минут сверх 8 часов. Права — Admin, PM, Schedule Manager
 * (проверяет функция в базе, миграция 0045); смена попадает в History.
 */
export async function setTeamOvertimeLimit(teamId: string, minutes: number): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.rpc('tp_set_team_overtime_limit', { p_team_id: teamId, p_minutes: minutes })
  if (error) throw error
}
