import { requireSupabase } from '../lib/supabase'
import { resolveString } from './app-settings'

/**
 * 06-HR-Sync Airtable Contacts. Прямой POST в Make-вебхук (как в оригинале) с телом
 * {action}. Вебхук берётся из app-settings (БД) с фолбэком на env.
 *
 * Расписание (авто-синк) живёт в 4 pg_cron-джобах и правится через RPC
 * `hr_sync_get_schedule` / `hr_sync_set_schedule` (миграция 0015). Напрямую в `cron.job`
 * из браузера не ходим: там произвольный SQL, выполняемый суперпользователем.
 *
 * Время человек вводит в СВОЕЙ зоне (America/New_York) — в `cron.job` оно уходит
 * пересчитанным в UTC, а раз в сутки пересчитывается заново, поэтому переход на летнее
 * время подхватывается сам. Раньше этого не было: `0 16 * * *` поставили под 11:00 EST,
 * и летом синк молча начал ходить в 12:00 ET.
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

/* ---------------- Расписание автосинка (pg_cron через RPC) ---------------- */

export interface SyncJob {
  jobname: string
  /** Время, которое видит и вводит человек, — в зоне `tz`. */
  local_hour: number
  local_minute: number
  tz: string
  /** Фактическое cron-выражение в UTC — показываем как справку. */
  cron_utc: string
  active: boolean
}

export async function getSchedule(): Promise<SyncJob[]> {
  const sb = requireSupabase()
  const { data, error } = await sb.rpc('hr_sync_get_schedule')
  if (error) throw error
  return (data ?? []) as SyncJob[]
}

export async function setSchedule(jobname: string, hour: number, minute: number): Promise<void> {
  const sb = requireSupabase()
  const { error } = await sb.rpc('hr_sync_set_schedule', {
    p_jobname: jobname,
    p_hour: hour,
    p_minute: minute,
  })
  if (error) throw error
}

/** «16:00» из часа и минуты. */
export function hhmm(h: number, m: number): string {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/* ---------------- Пояснение по таймзоне (для экрана) ---------------- */

export interface TzInfo {
  /** «EDT» или «EST». */
  abbr: string
  /** Смещение от UTC сейчас, например «UTC−4». */
  offset: string
  /** Дата ближайшего перехода на летнее/зимнее время, если он есть. */
  nextChange: Date | null
}

/** Смещение зоны от UTC в минутах на заданный момент. */
function offsetMinutes(tz: string, at: Date): number {
  // Один и тот же момент, отформатированный как «локальный» в зоне и в UTC:
  // разница между ними и есть смещение.
  const asUtc = new Date(at.toLocaleString('en-US', { timeZone: 'UTC' }))
  const asTz = new Date(at.toLocaleString('en-US', { timeZone: tz }))
  return Math.round((asTz.getTime() - asUtc.getTime()) / 60000)
}

/**
 * Сокращение зоны, текущее смещение и дата следующего перехода.
 *
 * Переход ищем перебором по суткам вперёд (до года): правило DST в разных зонах своё,
 * а зашивать «второе воскресенье марта» — значит сломаться на первой же зоне с другим
 * правилом. Считается один раз при рендере, стоит доли миллисекунды.
 */
export function tzInfo(tz: string, now = new Date()): TzInfo {
  const abbr =
    new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(now)
      .find((p) => p.type === 'timeZoneName')?.value ?? tz

  const mins = offsetMinutes(tz, now)
  const sign = mins < 0 ? '−' : '+'
  const abs = Math.abs(mins)
  const offset = `UTC${sign}${abs / 60}`.replace('.5', ':30')

  let nextChange: Date | null = null
  const day = 24 * 60 * 60 * 1000
  for (let i = 1; i <= 366; i++) {
    const probe = new Date(now.getTime() + i * day)
    if (offsetMinutes(tz, probe) !== mins) {
      // Нашли сутки со сменой — уточнять до часа незачем, показываем дату.
      nextChange = probe
      break
    }
  }
  return { abbr, offset, nextChange }
}

/**
 * То же время, но в зоне того, кто смотрит на экран.
 *
 * Команда работает из Киева, офис клиента — на восточном побережье: разница семь часов.
 * Без пересчёта «12:00» на экране читается как своё время, и человек уверен, что синк
 * идёт днём, хотя у него это уже вечер.
 */
export function inViewerZone(tz: string, hour: number, minute: number): { time: string; zone: string } | null {
  const viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (!viewerTz || viewerTz === tz) return null

  // Строим момент: сегодняшняя дата + указанное время В ЗОНЕ ОФИСА.
  const today = new Date()
  const naive = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), hour, minute))
  const shift = offsetMinutes(tz, naive)
  const instant = new Date(naive.getTime() - shift * 60000)

  return {
    time: instant.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
    zone:
      new Intl.DateTimeFormat('en-US', { timeZone: viewerTz, timeZoneName: 'short' })
        .formatToParts(instant)
        .find((p) => p.type === 'timeZoneName')?.value ?? viewerTz,
  }
}
