/** n8n-клиент: отправка задач планировщику и расписания в Slack. */
import type { Task, Team, TeamAvailability, Skill, TeamDay } from '../domain/types'

const PLANNER = import.meta.env.VITE_N8N_PLANNER_WEBHOOK as string | undefined
const PLANNER_TEST = import.meta.env.VITE_N8N_PLANNER_TEST_WEBHOOK as string | undefined
const SLACK = import.meta.env.VITE_N8N_SLACK_WEBHOOK as string | undefined

export interface SendToAiParams {
  requestId: string
  date: string | null
  tasks: Task[]
  teams: Team[]
  unavailableTeams: TeamAvailability[]
  skills: Skill[]
  persistentPrompt?: string
  oneTimePrompt?: string
  test?: boolean
}

/**
 * scheduled_time в формате, который ждёт ИИ-агент: для exact-якоря — `time`
 * (НЕ `start`), для timeframe — окно start/end. Раньше слали `start` для exact,
 * из-за чего был рассинхрон с промптом (он читает `scheduled_time.time`).
 */
function buildScheduledTime(t: Task): Record<string, string> | null {
  if (t.anchor || t.exact_time) {
    return { type: 'exact', time: t.exact_time ?? t.anchor_time ?? '' }
  }
  if (t.timeframe_start || t.timeframe_end) {
    return { type: 'timeframe', start: t.timeframe_start ?? '', end: t.timeframe_end ?? '' }
  }
  return null
}

/** Task → элемент tasks[] в форме, которую ждёт прод-воркфлоу (вложенные project/team). */
function toWebhookTask(t: Task, teamsById: Map<string, Team>) {
  const tm = t.assigned_team_id ? teamsById.get(t.assigned_team_id) : undefined
  return {
    id: t.id,
    description: t.description,
    estimated_duration: t.estimated_duration_min / 60, // минуты → часы (контракт)
    priority: t.priority,
    task_type: t.task_type,
    scheduled_date: t.scheduled_date,
    scheduled_time: buildScheduledTime(t),
    stop_number: t.stop_number ?? null,
    schedule_prompt: t.schedule_prompt ?? null,
    additional_stop: t.additional_stop ?? null,
    skill_requirements: t.required_skill_ids ?? [],
    project: {
      project_id: t.project_id,
      project_name: t.project_name ?? '',
      project_address: t.task_address,
      project_latitude: t.lat,
      project_longitude: t.lng,
    },
    team: tm
      ? {
          team_id: tm.id,
          team_name: tm.name,
          team_address: tm.home_address,
          team_airtable_id: tm.airtable_id,
        }
      : null,
  }
}

/** Send to AI → вебхук планировщика. Возвращает ack. */
export async function sendToAi(p: SendToAiParams): Promise<{ request_ID: string }> {
  const url = p.test ? PLANNER_TEST || PLANNER : PLANNER
  const teamsById = new Map(p.teams.map((t) => [t.id, t]))
  const payload = {
    request_ID: p.requestId,
    date: p.date,
    source: 'requested',
    'Persistent Prompt': p.persistentPrompt ?? null,
    'One-time Prompt': p.oneTimePrompt ?? null,
    tasks: p.tasks.map((t) => toWebhookTask(t, teamsById)),
    Teams: p.teams.map((t) => ({
      team_name: t.name, team_address: t.home_address,
      team_latitude: t.lat, team_longitude: t.lng, skills: t.skills,
    })),
    'Unavailable teams': p.unavailableTeams.map((u) => ({ team_name: u.team_name })),
    Skills: p.skills.map((s) => s.name),
    total: p.tasks.length,
  }

  if (!url) throw new Error('n8n planner webhook не настроен (VITE_N8N_PLANNER_WEBHOOK)')
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`n8n planner ${res.status}`)
  return res.json().catch(() => ({ request_ID: p.requestId }))
}

/**
 * Сборка payload под контракт прод-воркфлоу Slack (aa6XaAQ6xuLEZRcz):
 * `{ request_ID, timestamp, teams: [{ team_name, tasks: [...] }] }`.
 * Внутренний tasks[] несёт поля, которые форматтер n8n кладёт в сообщение
 * (время, проект, адрес → Google Maps link, описание).
 */
export function buildSlackPayload(days: TeamDay[], requestId: string, date: string) {
  return {
    request_ID: requestId,
    timestamp: date,
    teams: days
      .filter((d) => d.tasks.length)
      .map((d) => ({
        team_name: d.team_name,
        tasks: d.tasks.map((t) => ({
          start_time: t.start_time,
          end_time: t.end_time,
          project_name: t.project_name,
          project_address: t.project_address,
          description: t.description,
          anchor: t.anchor,
          anchor_time: t.anchor_time,
        })),
      })),
  }
}

/** Send tasks → вебхук Slack-рассыльщика. */
export async function sendToSlack(schedule: unknown): Promise<void> {
  if (!SLACK) throw new Error('n8n slack webhook не настроен (VITE_N8N_SLACK_WEBHOOK)')
  const res = await fetch(SLACK, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(schedule),
  })
  if (!res.ok) throw new Error(`n8n slack ${res.status}`)
}
