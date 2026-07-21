import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Card, PageTitle, Input, Field } from '../components/ui'
import { fetchSetting, updateSetting } from '../services/data'
import { errMsg } from '../lib/utils'

/**
 * App Settings приложения Task Planner — аналог портального /settings/:appCode,
 * вынесен в отдельный экран (раньше был вкладкой внутри Admin), чтобы пункт
 * «App Settings» в бургер-меню вёл туда же, что и у остальных апок портала.
 * Значения лежат в tp_app_settings (key/value), запись — только super_admin (RLS).
 */
export function AppSettingsPage() {
  return (
    <>
      <PageTitle title="App Settings" />
      <PlannerWebhookCard />
      <ResourcesCard />
    </>
  )
}

function PlannerWebhookCard() {
  const qc = useQueryClient()
  const webhook = useQuery({
    queryKey: ['setting', 'planner_webhook_url'],
    queryFn: () => fetchSetting('planner_webhook_url'),
  })
  const [url, setUrl] = useState<string | null>(null)
  const value = url ?? webhook.data ?? ''
  const save = useMutation({
    mutationFn: (v: string) => updateSetting('planner_webhook_url', v.trim()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['setting', 'planner_webhook_url'] })
      setUrl(null)
    },
    onError: (e: unknown) => alert(errMsg(e)),
  })

  return (
    <Card className="mb-6 max-w-3xl p-6">
      <h2 className="mb-1 text-lg font-semibold text-gray-900">Planner Webhook</h2>
      <p className="mb-4 text-sm text-gray-500">
        URL вебхука n8n, куда отправляются задачи по кнопке «Send to AI». Хранится в БД, не в коде.
        Если значение пустое — используется фолбэк из env (<code>VITE_N8N_PLANNER_WEBHOOK</code>).
      </p>
      <Field label="Planner Webhook URL">
        <Input
          value={value}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…app.n8n.cloud/webhook/…"
          disabled={webhook.isLoading}
        />
      </Field>
      <div className="mt-4 flex items-center gap-3">
        <Button
          variant="accent"
          disabled={save.isPending || webhook.isLoading || !value.trim() || value.trim() === (webhook.data ?? '')}
          onClick={() => save.mutate(value)}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        {webhook.isError && <span className="text-sm text-red-600">⚠ {errMsg(webhook.error)}</span>}
      </div>
    </Card>
  )
}

/** Справка по ресурсам апки — тот же смысл, что вкладка Resources в портальном App Settings. */
function ResourcesCard() {
  const tables = [
    'tp_tasks', 'tp_projects', 'tp_teams', 'tp_skills', 'tp_task_types', 'tp_team_availability',
    'tp_ai_teams_schedule', 'tp_ai_settings', 'tp_travel_cache', 'tp_sync_logs',
    'tp_task_batch_snapshots', 'tp_app_settings', 'tp_profiles', 'tp_user_roles',
  ]
  const functions = [
    'sync-airtable-projects', 'sync-airtable-teams', 'sync-airtable-skills',
    'sync-team-accounts', 'auto-sync-airtable', 'set-team-password',
  ]
  return (
    <Card className="max-w-3xl p-6">
      <h2 className="mb-1 text-lg font-semibold text-gray-900">Resources</h2>
      <p className="mb-4 text-sm text-gray-500">
        Приложение работает в общей БД портала (Supabase «HR DASHBOARD»); все его таблицы
        изолированы префиксом <code>tp_</code>.
      </p>
      <ResourceList title="Таблицы" items={tables} />
      <ResourceList title="Edge-функции" items={functions} />
      <ResourceList title="Внешние сервисы" items={['n8n (планировщик)', 'Airtable (проекты, бригады, навыки)', 'Google Maps / Places']} />
    </Card>
  )
}

function ResourceList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="mb-4 last:mb-0">
      <div className="mb-2 text-sm font-medium text-gray-700">{title}</div>
      <div className="flex flex-wrap gap-2">
        {items.map((i) => (
          <span key={i} className="rounded bg-gray-100 px-2 py-1 font-mono text-xs text-gray-700">{i}</span>
        ))}
      </div>
    </div>
  )
}
