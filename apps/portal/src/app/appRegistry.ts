import type { LucideIcon } from 'lucide-react'
import { BookUser, CalendarDays, ListChecks, Plus } from 'lucide-react'

/**
 * Реестр приложений портала для app-settings: настройки (вебхуки) и справка о ресурсах
 * (таблицы/базы/бакеты/edge/внешние интеграции) каждой апки + роут-префиксы для определения
 * «в какой апке мы сейчас». Расширяется по мере роста.
 */
export interface WebhookField {
  key: string
  label: string
  hint?: string
  envDefault?: string
}

export interface ExternalIntegration {
  name: string
  detail?: string
}

/** Read-only справка о ресурсах приложения (для админ-вью Resources). */
export interface AppResources {
  database?: string
  tables?: string[]
  storageBuckets?: string[]
  edgeFunctions?: string[]
  external?: ExternalIntegration[]
}

/**
 * «Внутренняя роль» приложения — вид, который апка показывает пользователю
 * (напр. у Task Planner: планировщик ↔ бригадир). Сама роль нигде не хранится:
 * админ на `/settings/:appCode` → вкладка Roles сопоставляет ей **портальные роли**,
 * и маппинг ложится в `app_settings` под ключом `roles_<key>` (массив role_id).
 * Так точка настройки — в настройках апки, а реестр ролей остаётся один, портальный
 * (правило 3 платформы).
 */
export interface AppRoleSlot {
  key: string
  label: string
  hint?: string
}

/** Ключ в app_settings, под которым лежат портальные роли для слота. */
export function appRoleSettingKey(slotKey: string): string {
  return `roles_${slotKey}`
}

/** Пункт бургер-меню, показываемый, когда пользователь находится внутри этой апки. */
export interface AppNavItem {
  to: string
  label: string
  icon: LucideIcon
  adminOnly?: boolean
}

export interface AppConfig {
  code: string
  label: string
  /** Короткое имя для заголовка секции в бургер-меню (без номера отдела). */
  shortLabel?: string
  routePrefixes: string[]
  webhooks: WebhookField[]
  resources?: AppResources
  /** Экраны апки — попадают в общее бургер-меню, когда мы внутри неё. */
  nav?: AppNavItem[]
  /** Внутренние роли апки (вкладка Roles в App Settings). */
  appRoles?: AppRoleSlot[]
}

const SUPABASE = 'Supabase — pilxwhtkhysanpukaliu (shared with the portal)'

export const APPS: AppConfig[] = [
  {
    code: 'sales',
    label: '02-Sales — Send an Offer Email',
    shortLabel: 'Send an Offer Email',
    routePrefixes: ['/sales-email-sender'],
    webhooks: [
      {
        key: 'offer_webhook',
        label: 'Sales offer webhook (Make)',
        hint: 'POST target for the "Send Email" button.',
        envDefault: import.meta.env.VITE_MAKE_SALES_OFFER_WEBHOOK as string | undefined,
      },
    ],
    resources: {
      database: SUPABASE,
      tables: ['email_templates'],
      external: [
        { name: 'Make.com webhook', detail: 'Send Email → delivers the email to the recipient list from Airtable' },
        { name: 'Airtable', detail: 'recipient list (handled on the Make side)' },
      ],
    },
  },
  {
    code: 'production-checklist',
    label: '03-Production Checklist',
    shortLabel: 'Production Checklist',
    routePrefixes: ['/production-checklist'],
    webhooks: [
      {
        key: 'send_webhook',
        label: 'Checklist Send webhook (Make)',
        hint: 'POST target when a project checklist is sent.',
        envDefault: import.meta.env.VITE_MAKE_SEND_WEBHOOK as string | undefined,
      },
    ],
    resources: {
      database: SUPABASE,
      tables: [
        'projects',
        'production_checklists',
        'production_checklist_items',
        'project_checklists',
        'project_checklist_progress',
      ],
      storageBuckets: ['production-checklist-photos'],
      edgeFunctions: ['create-project-webhook (incoming project webhook → projects)', 'extract-checklist-from-image (AI import)'],
      external: [
        { name: 'Make.com (incoming)', detail: 'create-project-webhook → projects' },
        { name: 'Make.com (outgoing)', detail: 'Send → webhook (see the Webhooks tab)' },
      ],
    },
  },
  {
    code: 'buildertrend-schedule',
    label: '03-Production — Send Buildertrend Schedule',
    shortLabel: 'Send Buildertrend Schedule',
    routePrefixes: ['/buildertrend-schedule'],
    webhooks: [
      {
        key: 'schedule_webhook',
        label: 'Schedule Send webhook (Make)',
        hint: 'POST target for the "Submit" button (project name + photo URLs).',
        envDefault: import.meta.env.VITE_MAKE_BUILDERTREND_SCHEDULE as string | undefined,
      },
    ],
    resources: {
      database: SUPABASE,
      tables: ['— no own tables; project list comes live from Airtable via edge function'],
      storageBuckets: ['buildertrend-schedule-photos'],
      edgeFunctions: ['list-schedule-projects (Airtable "General Project Info" proxy → project dropdown)'],
      external: [
        {
          name: 'Airtable (incoming)',
          detail: 'General Project Info (appucrtf5MBcFXVza) → project dropdown; token in edge secrets (AIRTABLE_TOKEN)',
        },
        {
          name: 'Make.com (outgoing)',
          detail: 'Submit → "SEND SCHEDULE JOTFORM" scenario (formID 241016020135133): JotForm-shaped body, rawRequest carries { project, input119: [url] } → Airtable lookup → Slack + client email',
        },
      ],
    },
  },
  {
    code: 'hr-checklists',
    label: '06-HR Checklists',
    shortLabel: 'HR Checklists',
    routePrefixes: ['/checklists', '/checklist'],
    webhooks: [],
    resources: {
      database: SUPABASE,
      tables: [
        'employees',
        'employee_types',
        'checklists',
        'checklist_items',
        'employee_checklists',
        'employee_checklist_progress',
        'employee_phase_preferences',
        'checklist_photos',
      ],
      storageBuckets: ['checklist-item-photos', 'checklist-photos'],
      edgeFunctions: ['extract-checklist-from-image (AI import)'],
      external: [{ name: 'Lovable AI Gateway', detail: 'gemini-2.5-flash — AI checklist import from image (via edge)' }],
    },
  },
  {
    code: 'gmail-auto-sender',
    label: '06-HR Gmail Auto Sender',
    shortLabel: 'Gmail Auto Sender',
    routePrefixes: ['/gmail-auto-sender'],
    webhooks: [],
    resources: {
      database: '— the app stores nothing (state and tokens live on AWS)',
      tables: [],
      edgeFunctions: ['gmail-auth (proxy to AWS API Gateway)'],
      external: [
        { name: 'AWS API Gateway', detail: '3mb71kyw2k.execute-api.us-east-1.amazonaws.com/dev/gmail/auth' },
        { name: 'Google OAuth', detail: 'consent screen on the mailbox owner side' },
      ],
    },
  },
  {
    code: 'hr-sync',
    label: '06-HR Sync Airtable Contacts',
    shortLabel: 'Sync Airtable Contacts',
    routePrefixes: ['/hr-sync-airtable'],
    webhooks: [
      {
        key: 'employees_webhook',
        label: 'Employees sync webhook (Make)',
        hint: 'POST target for "Sync Employees Contacts".',
        envDefault: import.meta.env.VITE_MAKE_HR_SYNC_EMPLOYEES as string | undefined,
      },
      {
        key: 'vendors_webhook',
        label: 'Key Vendors sync webhook (Make)',
        hint: 'POST target for "Sync Key Vendors Contacts".',
        envDefault: import.meta.env.VITE_MAKE_HR_SYNC_VENDORS as string | undefined,
      },
    ],
    resources: {
      database: '— no own tables; automatic sync via pg_cron (4 jobs) + pg_net',
      tables: [],
      edgeFunctions: ['manage-sync-schedules (schedule RPCs not present in DB — Save Schedule is a no-op)'],
      external: [
        { name: 'Make.com — Employees sync', detail: 'POST {action:sync_employees} → Airtable (employee contacts)' },
        { name: 'Make.com — Key Vendors sync', detail: 'POST {action:sync_vendors} → Airtable (vendor contacts)' },
        { name: 'Server cron', detail: 'Employees 11:00 & 17:00 ET, Vendors 11:10 & 17:10 ET (pg_cron)' },
      ],
    },
  },
  {
    // Встроен в портал роутами 2026-07-22 (был отдельным SPA). БД общая, таблицы tp_*.
    code: 'task-planner',
    label: '01-Task Planner (Daly Schedule)',
    shortLabel: 'Daly Schedule',
    routePrefixes: ['/task-planner'],
    nav: [
      { to: '/task-planner', label: 'Tasks', icon: ListChecks },
      { to: '/task-planner/create', label: 'Create Task', icon: Plus },
      { to: '/task-planner/availability', label: 'Teams Availability', icon: CalendarDays },
      { to: '/task-planner/admin', label: 'Directories', icon: BookUser, adminOnly: true },
    ],
    appRoles: [
      {
        key: 'admin',
        label: 'Planner Admin',
        hint: 'Full view: every task, Send to AI, directories. Portal admins always get this view, regardless of this setting.',
      },
      {
        key: 'team_lead',
        label: 'Team Lead (crew PM)',
        hint: 'Limited view: own crew only. A user whose email matches a row in tp_teams also counts as a team lead, even without a role here.',
      },
    ],
    webhooks: [
      {
        key: 'planner_webhook',
        label: 'Planner webhook (n8n)',
        hint: 'POST target for "Send to AI" — tasks go to the scheduling workflow.',
        envDefault: import.meta.env.VITE_N8N_PLANNER_WEBHOOK as string | undefined,
      },
      {
        key: 'slack_webhook',
        label: 'Slack webhook (n8n)',
        hint: 'POST target for sending the approved schedule to Slack.',
        envDefault: import.meta.env.VITE_N8N_SLACK_WEBHOOK as string | undefined,
      },
    ],
    resources: {
      database: SUPABASE,
      tables: [
        'tp_tasks', 'tp_projects', 'tp_teams', 'tp_skills', 'tp_task_types', 'tp_team_availability',
        'tp_ai_teams_schedule', 'tp_travel_cache', 'tp_sync_logs',
        'tp_task_batch_snapshots', 'tp_app_settings', 'tp_profiles', 'tp_user_roles',
      ],
      edgeFunctions: [
        'sync-airtable-projects', 'sync-airtable-teams', 'sync-airtable-skills',
        'sync-team-accounts', 'auto-sync-airtable', 'set-team-password',
      ],
      external: [
        { name: 'n8n — Task Planner', detail: 'workflow cit7Gah53xPLLbdy; webhook URL in tp_app_settings.planner_webhook_url' },
        { name: 'Airtable — 03-Projects', detail: 'appucrtf5MBcFXVza / General Project Info / view TEAM MANAGEMENT' },
        { name: 'Airtable — 05-Contacts Directory', detail: 'appiScywNMqBk3x9e / Directory (crews) + Skills with Rating' },
        { name: 'Google Maps / Places', detail: 'geocoding of project and crew addresses, Distance Matrix' },
        { name: 'Slack (via n8n)', detail: 'sends the schedule out to the crews' },
      ],
    },
  },
]

export function appForPath(path: string): AppConfig | null {
  return APPS.find((a) => a.routePrefixes.some((p) => path === p || path.startsWith(p + '/'))) ?? null
}

export function appByCode(code: string): AppConfig | null {
  return APPS.find((a) => a.code === code) ?? null
}

/**
 * Апка, в контексте которой мы находимся — для хедера и бургер-меню. В отличие от
 * `appForPath` учитывает и экран настроек апки (`/settings/:appCode`): он лежит вне
 * её роут-префиксов, но принадлежит ей, поэтому меню и заголовок там должны остаться
 * «внутри апки», а не сваливаться на портальный вид.
 */
export function currentAppForPath(path: string): AppConfig | null {
  const settings = /^\/settings\/([^/]+)/.exec(path)
  if (settings) return appByCode(settings[1])
  return appForPath(path)
}
