import { resolveString } from './app-settings'

/**
 * 06-HR-Sync Airtable Contacts. Прямой POST в Make-вебхук (как в оригинале) с телом
 * {action}. Вебхук берётся из app-settings (БД) с фолбэком на env.
 *
 * Расписание (авто-синк) живёт в 4 pg_cron-джобах и из UI не редактируется —
 * RPC для этого в базе нет (см. Save Schedule = no-op). Здесь только ручной запуск.
 */
export type SyncType = 'employees' | 'vendors'

export async function runSync(type: SyncType): Promise<void> {
  const key = type === 'employees' ? 'employees_webhook' : 'vendors_webhook'
  const env =
    type === 'employees'
      ? (import.meta.env.VITE_MAKE_HR_SYNC_EMPLOYEES as string | undefined)
      : (import.meta.env.VITE_MAKE_HR_SYNC_VENDORS as string | undefined)

  const webhook = await resolveString('hr-sync', key, env)
  if (!webhook) throw new Error('Sync webhook is not configured (App Settings → Webhooks or .env)')

  const action = type === 'employees' ? 'sync_employees' : 'sync_vendors'
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  })
  if (!res.ok) throw new Error(`Sync webhook error: HTTP ${res.status}`)
}
