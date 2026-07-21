/**
 * Data-layer: единый доступ к задачам/справочникам. Если Supabase is not configured —
 * отдаёт mock-данные (каркас работает офлайн). Реальные запросы добавляются
 * позже без изменения UI (фаза 2).
 */
import { supabase } from '../../lib/supabase'
import type { Project, ScheduleRun, Skill, Task, Team, TeamAvailability, TeamSkill } from '../../domain/task-planner/types'

export async function fetchTasks(status?: Task['status']): Promise<Task[]> {
  if (!supabase) return []
  // ВАЖНО: FK tasks→teams в схеме нет, поэтому embed teams(...) даёт 400.
  // Имя бригады подтягиваем отдельным запросом и резолвим по team_id на клиенте.
  let q = supabase
    .from('tp_tasks')
    // алиас projects: → таблица переименована в tp_projects, ключ в ответе оставляем прежним
    .select('*, projects:tp_projects(name,address,project_manager,latitude,longitude)')
    .order('stop_number', { ascending: true })
  if (status) q = q.eq('status', status)
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
    task_type: r.task_type ?? 'Project task',
    project_id: r.project_id ?? null,
    project_name: proj?.name,
    title: r.title,
    description: r.description ?? r.title ?? '',
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
    priority: r.priority ?? 5,
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
    supabase.from('tp_teams').select('*'),
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

/** app_role → читаемая подпись. */
function prettyRole(r: string): string {
  const m: Record<string, string> = { super_admin: 'Super Admin', pm: 'PM', team_lead: 'Team Lead' }
  return m[r] ?? (r || '')
}

/**
 * Члены команды для Admin → Team: профиль + роль + адрес/статус.
 * Источник — profiles + user_roles (роли) + teams (адрес/статус), мерж в JS.
 * profiles/user_roles под RLS — видны под залогиненным админом; иначе фолбэк на teams.
 * Защитно к именам колонок (first_name/last_name | full_name | name; user_id | id).
 */
export async function fetchTeamMembers(): Promise<import('../../domain/task-planner/types').TeamMember[]> {
  if (!supabase) return []
  const [pRes, rRes, tRes] = await Promise.all([
    supabase.from('tp_profiles').select('*'),
    supabase.from('tp_user_roles').select('*'),
    supabase.from('tp_teams').select('id, name, email, address, account_status'),
  ])
  const teams = (tRes.data ?? []) as Record<string, any>[]
  const teamByEmail = new Map<string, Record<string, any>>()
  for (const t of teams) if (t.email) teamByEmail.set(String(t.email).toLowerCase(), t)
  // явные роли из user_roles (Super Admin / PM / Team Lead) — приоритет
  const roleByUser = new Map<string, string>()
  for (const r of ((rRes.data ?? []) as Record<string, any>[])) {
    const k = String(r.user_id ?? r.id ?? '')
    if (k) roleByUser.set(k, prettyRole(String(r.role ?? '')))
  }
  // роль из user_roles ищем по ОБОИМ ключам (profiles.user_id — auth uid, либо id) →
  // иначе член бригады (есть в teams) = Team Lead → иначе «—»
  const roleFor = (ids: (string | null | undefined)[], email: string | null): string | null => {
    for (const id of ids) {
      const explicit = id != null && roleByUser.get(String(id))
      if (explicit) return explicit
    }
    if (email && teamByEmail.has(email.toLowerCase())) return 'Team Lead'
    return null
  }
  const profiles = (pRes.data ?? []) as Record<string, any>[]
  if (profiles.length) {
    return profiles.map((p): import('../../domain/task-planner/types').TeamMember => {
      const email = p.email ?? ''
      const t = email ? teamByEmail.get(String(email).toLowerCase()) : null
      const name = [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || p.full_name || p.name || email || p.id
      return { id: p.id, name, email: email || null, address: t?.address ?? p.address ?? null, role: roleFor([p.user_id, p.id], email || null), status: t?.account_status ?? null }
    }).sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  }
  // фолбэк: только teams (если profiles закрыты RLS) — все они бригады = Team Lead
  return teams.map((t): import('../../domain/task-planner/types').TeamMember => ({
    id: t.id ?? t.email ?? t.name, name: t.name, email: t.email ?? null,
    address: t.address ?? null, role: roleFor([t.id], t.email ?? null), status: t.account_status ?? null,
  }))
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

/**
 * Задать/сбросить пароль члену бригады (Admin → Team). Через Edge Function
 * `set-team-password` (service_role на сервере). Универсально: создаёт аккаунт
 * с паролем, если его ещё нет, иначе меняет пароль.
 */
export async function setTeamPassword(input: {
  email: string
  password: string
  role?: string
  first_name?: string | null
  last_name?: string | null
}): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured')
  const { data: sessionData } = await supabase.auth.getSession()
  const token = sessionData.session?.access_token
  if (!token) throw new Error('Not signed in — please log in again')
  const { data, error } = await supabase.functions.invoke('set-team-password', {
    body: { ...input, access_token: token }, // токен в теле — платформа может портить заголовок
    headers: { Authorization: `Bearer ${token}` },
  })
  if (error) {
    // При non-2xx supabase-js прячет тело в error.context (Response) — вытащим реальный текст.
    let detail = error.message
    try {
      const ctx = (error as { context?: Response }).context
      const body = ctx && (await ctx.json())
      if (body?.error) detail = body.error
    } catch { /* тело не JSON — оставляем message */ }
    throw new Error(detail)
  }
  if (data?.error) throw new Error(data.error)
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
    .select('id, team_id, start_date, end_date, teams:tp_teams(name)')
  if (error) throw error
  return (data ?? []).map((r: Record<string, unknown>): TeamAvailability => ({
    id: r.id as string, team_id: r.team_id as string,
    team_name: (r.teams as { name?: string } | null)?.name ?? '',
    start_date: r.start_date as string, end_date: r.end_date as string,
  }))
}

/** Добавить период недоступности команды. */
export async function createAvailability(teamId: string, startDate: string, endDate: string): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured')
  const { data: auth } = await supabase.auth.getUser()
  const { error } = await supabase.from('tp_team_availability').insert({
    team_id: teamId, start_date: startDate, end_date: endDate, created_by: auth.user?.id ?? null,
  })
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
  priority?: number
  skill_requirements?: string[]
  schedule_prompt?: string | null
  additional_stop?: Record<string, unknown> | null
  created_by?: string | null
}

/** INSERT новой задачи (status=requested). Возвращает id. */
export async function createTask(input: CreateTaskInput): Promise<string> {
  if (!supabase) throw new Error('Supabase is not configured')
  const row = {
    status: 'requested',
    task_type: input.task_type,
    project_id: input.project_id,
    description: input.description,
    title: input.title ?? null,
    scheduled_date: input.scheduled_date,
    scheduled_time: input.scheduled_time,
    estimated_duration: input.estimated_duration_min / 60, // минуты → часы (схема хранит часы)
    address: input.address,
    project_manager: input.project_manager ?? null,
    team_id: input.team_id ?? null,
    priority: input.priority ?? 5,
    skill_requirements: input.skill_requirements ?? [],
    schedule_prompt: input.schedule_prompt ?? null,
    additional_stop: input.additional_stop ?? null,
    created_by: input.created_by ?? null,
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
  priority?: number
  scheduled_date?: string
  address?: string
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
  const updates: Promise<void>[] = []
  for (const day of days) {
    for (const t of day.tasks) {
      const scheduled_time = t.anchor
        ? { start: t.start_time, end: t.end_time, anchor: true, anchor_time: t.anchor_time }
        : { start: t.start_time, end: t.end_time }
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
 * Материализация результата AI как НОВЫХ строк tasks (status=proposed) — копий.
 * Requested-задачи НЕ трогаются (остаются эталонным набором для тестов).
 * `request_task_id` ссылается на исходную задачу. Поля берём из самого расписания.
 */
export async function materializeProposedCopies(
  days: import('../../domain/task-planner/types').TeamDay[],
): Promise<number> {
  if (!supabase) throw new Error('Supabase is not configured')
  const rows: Record<string, unknown>[] = []
  for (const day of days) {
    for (const t of day.tasks) {
      const scheduled_time = t.anchor
        ? { start: t.start_time, end: t.end_time, anchor: true, anchor_time: t.anchor_time }
        : { start: t.start_time, end: t.end_time }
      const title = (String(t.description ?? '').split('\n')[0] || t.project_name || 'Task').slice(0, 200)
      rows.push({
        status: 'proposed',
        team_id: day.team_id === 'unassigned' ? null : day.team_id,
        project_id: t.project_id || null,
        title,
        description: t.description ?? '',
        task_type: 'Project task',
        scheduled_date: day.date || null,
        scheduled_time,
        estimated_duration: t.duration_minutes / 60,
        stop_number: t.scheduled_order,
        travel_time: t.drive_minutes_from_previous,
        address: t.project_address || null,
        priority: 5,
        skill_requirements: [],
        request_task_id: t.task_id,
      })
    }
  }
  if (!rows.length) return 0
  const { error } = await supabase.from('tp_tasks').insert(rows)
  if (error) throw error
  return rows.length
}

/** Удалить все задачи заданного статуса (для кнопки «Удалить все» в Proposed). */
export async function deleteTasksByStatus(status: Task['status']): Promise<number> {
  if (!supabase) throw new Error('Supabase is not configured')
  const { data, error } = await supabase.from('tp_tasks').delete().eq('status', status).select('id')
  if (error) throw error
  return (data ?? []).length
}

/**
 * Заменить набор proposed результатом расписания: снести старые proposed-копии
 * и вставить новые. Requested остаётся нетронутым.
 */
export async function replaceProposedWithSchedule(
  days: import('../../domain/task-planner/types').TeamDay[],
): Promise<number> {
  await deleteTasksByStatus('proposed')
  return materializeProposedCopies(days)
}

/**
 * Восстановить эталонные requested-задачи из input_tasks сохранённого прогона
 * (по requestId, иначе самый свежий). Чинит строки, которые прошлая логика
 * перевела в proposed и перезаписала расписанием. Возвращает число восстановленных.
 */
/**
 * Тестовые якоря: чиним битые exact-задачи прошлого прогона — ставим реальные
 * УТРЕННИЕ времена в формате, который ждёт ИИ (`{type:'exact', time}`).
 * (Раньше: один вечерний 21:45 + два exact с пустым временем.)
 */
const TEST_ANCHOR_TIMES: Record<string, string> = {
  '1b984091-621c-477e-b801-902868393d79': '09:00', // Stair Trim & Railing Install
  '05327e6a-200e-484d-8440-9b31be8f893e': '11:00', // Build & Install Closet Framing
  '13a699f8-a475-4594-be3a-eda65e52ebb2': '12:00', // relocate vanity light box
}

export async function restoreRequestedFromRun(requestId?: string): Promise<number> {
  if (!supabase) throw new Error('Supabase is not configured')
  const sel = 'request_ID, input_tasks, created_at'
  const q = requestId
    ? supabase.from('tp_ai_teams_schedule').select(sel).eq('request_ID', requestId).limit(1)
    : supabase.from('tp_ai_teams_schedule').select(sel).order('created_at', { ascending: false }).limit(1)
  const { data, error } = await q
  if (error) throw error
  const row = data?.[0] as { input_tasks?: Record<string, any>[] } | undefined
  const tasks = row?.input_tasks ?? []
  if (!tasks.length) return 0
  await Promise.all(
    tasks.map((t) =>
      (async () => {
        // выровненный формат якоря: {type:'exact', time}; иначе — исходный scheduled_time
        const anchor = TEST_ANCHOR_TIMES[t.id]
        const scheduled_time = anchor ? { type: 'exact', time: anchor } : (t.scheduled_time ?? null)
        const { error } = await supabase!
          .from('tp_tasks')
          .update({
            status: 'requested',
            team_id: t.team?.team_id ?? null,
            project_id: t.project?.project_id ?? null,
            description: t.description ?? null,
            task_type: t.task_type ?? 'Project task',
            priority: t.priority ?? 5,
            scheduled_date: t.scheduled_date ?? null,
            scheduled_time,
            estimated_duration: t.estimated_duration ?? null,
            skill_requirements: t.skill_requirements ?? [],
            additional_stop: t.additional_stop ?? null,
            schedule_prompt: t.schedule_prompt ?? null,
            stop_number: t.stop_number ?? null,
            travel_time: null,
          })
          .eq('id', t.id)
        if (error) throw error
      })(),
    ),
  )
  return tasks.length
}

/**
 * Подтянуть результат планировщика (по requestId/последний) и материализовать
 * как proposed-копии. Requested не трогаем. Спасает от таймаута/refresh.
 */
export async function pullScheduleIntoTasks(requestId?: string): Promise<number> {
  const run = await fetchScheduleRun(requestId)
  const sched = run?.output_data?.schedule
  if (!sched?.length) return 0
  return replaceProposedWithSchedule(sched)
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
