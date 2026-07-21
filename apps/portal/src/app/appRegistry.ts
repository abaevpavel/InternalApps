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

export interface AppConfig {
  code: string
  label: string
  /** Пусто у внешних апок: они живут на своём origin, а не роутом портала. */
  routePrefixes: string[]
  webhooks: WebhookField[]
  resources?: AppResources
  /** Внешняя апка (свой деплой/origin) — её настройки редактируются внутри неё самой. */
  externalUrl?: string
}

const SUPABASE = 'Supabase — pilxwhtkhysanpukaliu (shared with the portal)'

export const APPS: AppConfig[] = [
  {
    code: 'sales',
    label: '02-Sales — Send an Offer Email',
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
    // Внешняя апка: свой Vite-деплой и свой origin (локально :5173), в портале только карточка.
    // С 2026-07-21 работает в ОБЩЕЙ портальной БД — все её таблицы с префиксом tp_.
    code: 'task-planner',
    label: '01-Task Planner (Daly Schedule)',
    routePrefixes: [], // роутов в портале нет — открывается по абсолютному applications.url с SSO
    externalUrl: import.meta.env.VITE_TASK_PLANNER_URL as string | undefined,
    // Настройки (planner_webhook_url) живут в tp_app_settings и правятся на экране
    // «App Settings» внутри самой апки — здесь их не дублируем, иначе портал писал бы
    // в свою app_settings, откуда Task Planner не читает.
    webhooks: [],
    resources: {
      database: SUPABASE,
      tables: [
        'tp_tasks', 'tp_projects', 'tp_teams', 'tp_skills', 'tp_task_types', 'tp_team_availability',
        'tp_ai_teams_schedule', 'tp_ai_settings', 'tp_travel_cache', 'tp_sync_logs',
        'tp_task_batch_snapshots', 'tp_app_settings', 'tp_profiles', 'tp_user_roles',
      ],
      edgeFunctions: [
        'sync-airtable-projects', 'sync-airtable-teams', 'sync-airtable-skills',
        'sync-team-accounts', 'auto-sync-airtable', 'set-team-password',
      ],
      external: [
        { name: 'n8n — Task Planner', detail: 'workflow cit7Gah53xPLLbdy; URL вебхука в tp_app_settings.planner_webhook_url' },
        { name: 'Airtable — 03-Projects', detail: 'appucrtf5MBcFXVza / General Project Info / view TEAM MANAGEMENT' },
        { name: 'Airtable — 05-Contacts Directory', detail: 'appiScywNMqBk3x9e / Directory (бригады) + Skills with Rating' },
        { name: 'Google Maps / Places', detail: 'геокодинг адресов проектов и бригад, Distance Matrix' },
        { name: 'Slack (через n8n)', detail: 'рассылка расписания бригадам' },
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
