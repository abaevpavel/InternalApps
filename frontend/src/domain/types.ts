/** Доменные типы Daly Schedule. */

export type AppRole = 'super_admin' | 'pm' | 'team_lead'

export type TaskStatus = 'requested' | 'proposed' | 'scheduled' | 'archived'

export type TimeType = 'exact' | 'timeframe'

export interface LatLng {
  lat: number | null
  lng: number | null
}

export interface AdditionalStop {
  when: 'before' | 'after'
  address: string
  lat: number | null
  lng: number | null
  duration_min: number
  /** travel домой/к задаче — заполняется Google при пересчёте */
  travel_to_min?: number
  travel_from_min?: number
}

/** Справочники */
export interface Project {
  id: string
  airtable_id?: string
  name: string
  address: string
  lat: number | null
  lng: number | null
  project_manager: string
}

export interface Team {
  id: string
  airtable_id?: string
  name: string
  home_address: string
  lat: number | null
  lng: number | null
  slack_user_id?: string | null
  skills: string[]
}

export interface Skill {
  id: string
  airtable_id?: string
  name: string
  category: string
  description?: string
  available_team_ids: string[]
}

export interface TaskType {
  id: string
  name: string
}

export interface TeamAvailability {
  id: string
  team_id: string
  team_name: string
  start_date: string
  end_date: string
}

/** Задача (новая сущность в Supabase) */
export interface Task {
  id: string
  status: TaskStatus
  task_type: string
  project_id: string | null
  project_name?: string
  title?: string
  description: string
  scheduled_date: string
  time_type: TimeType | null
  exact_time: string | null // "HH:MM" — якорь
  timeframe_start: string | null
  timeframe_end: string | null
  estimated_duration_min: number
  task_address: string
  lat: number | null
  lng: number | null
  project_manager: string
  assigned_team_id: string | null
  assigned_team_name?: string
  assigned_team_home_base?: string
  priority: number
  required_skill_ids: string[]
  schedule_prompt: string | null
  additional_stop: AdditionalStop | null
  stop_number?: number | null
  request_task_id?: string | null
  // рассчитанное расписание (из scheduled_time / travel_time в БД)
  sched_start?: string | null
  sched_end?: string | null
  travel_time?: number | null
  anchor?: boolean
  anchor_time?: string | null
  created_by?: string
  created_at?: string
  updated_at?: string
}

/** ---- Результат планировщика (output_data из n8n) ---- */

export interface ScheduledTask {
  scheduled_order: number
  task_id: string
  project_id: string
  project_name: string
  project_address: string
  description: string
  anchor: boolean
  anchor_time: string // "HH:MM" если anchor, иначе ""
  start_time: string // "HH:MM"
  end_time: string // "HH:MM"
  duration_minutes: number
  drive_minutes_from_previous: number
  additional_stop?: AdditionalStop | null
  /** ручной override travel — не затирается пересчётом */
  travel_overridden?: boolean
  /** флаг конфликта: не успеваем доехать к якорю */
  conflict?: { overlap_min: number } | null
}

export interface TeamDay {
  team_id: string
  team_name: string
  date: string
  timezone: string
  team_home_base: string
  workday_start_time: string
  workday_end_time: string
  morning_commute_minutes: number
  end_of_day_commute_minutes: number
  total_working_minutes: number
  day_length_category: 'normal' | 'overtime_8_to_10' | 'overtime_over_10'
  overtime: boolean
  tasks: ScheduledTask[]
  summary?: {
    total_tasks: number
    total_travel_in_day_minutes: number
    compliance?: {
      no_overlaps: boolean
      anchors_preserved: boolean
      all_tasks_scheduled: boolean
    }
  }
}

export interface ScheduleRun {
  request_id: string
  status: 'processing' | 'done' | 'error'
  output_data: { schedule: TeamDay[] } | null
  comments_ai_1?: unknown
  comments_ai_2?: unknown
  error?: string | null
  created_at?: string
  updated_at?: string
}
