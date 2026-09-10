import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Building2, CheckCircle2, RefreshCw, Users } from 'lucide-react'
import { Button, Card, PageTitle } from '../../components/ui'
import { cn, errMsg } from '../../lib/utils'
import {
  getSchedule, hhmm, inViewerZone, runSync, setSchedule, tzInfo,
  type SyncJob, type SyncType,
} from '../../services/hr-sync'

/** Имена заданий pg_cron. Менять их нельзя — они же в белом списке RPC (миграция 0015). */
const JOBS: Record<SyncType, { morning: string; afternoon: string }> = {
  employees: { morning: 'sync-employees-11am', afternoon: 'sync-employees-5pm' },
  vendors: { morning: 'sync-vendors-11am', afternoon: 'sync-vendors-5pm' },
}

export function HRSyncAirtablePage() {
  const scheduleQ = useQuery({ queryKey: ['hr-sync-schedule'], queryFn: getSchedule })
  const byName = new Map((scheduleQ.data ?? []).map((j) => [j.jobname, j]))

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-10 sm:px-6">
      <PageTitle title="HR Sync — Airtable Contacts" subtitle="Trigger contact syncs to Airtable via Make.com." />
      <div className="grid gap-5 md:grid-cols-2">
        <SyncCard
          type="employees"
          title="Employee Contacts"
          description="Sync employee contacts into Airtable."
          icon={<Users size={26} />}
          jobs={JOBS.employees}
          byName={byName}
          loadingSchedule={scheduleQ.isLoading}
          scheduleError={scheduleQ.error ? errMsg(scheduleQ.error) : null}
        />
        <SyncCard
          type="vendors"
          title="Key Vendor Contacts"
          description="Sync key vendor contacts into Airtable."
          icon={<Building2 size={26} />}
          jobs={JOBS.vendors}
          byName={byName}
          loadingSchedule={scheduleQ.isLoading}
          scheduleError={scheduleQ.error ? errMsg(scheduleQ.error) : null}
        />
      </div>
    </div>
  )
}

function SyncCard({
  type,
  title,
  description,
  icon,
  jobs,
  byName,
  loadingSchedule,
  scheduleError,
}: {
  type: SyncType
  title: string
  description: string
  icon: React.ReactNode
  jobs: { morning: string; afternoon: string }
  byName: Map<string, SyncJob>
  loadingSchedule: boolean
  scheduleError: string | null
}) {
  const qc = useQueryClient()
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<{ type: 'success' | 'error'; msg: string } | null>(null)

  const morning = byName.get(jobs.morning)
  const afternoon = byName.get(jobs.afternoon)
  // Показываем зону, текущее смещение и дату ближайшего перехода: без этого «12:00»
  // ничего не говорит о том, что стоит в cron и почему оно там другое.
  const tz = tzInfo(morning?.tz ?? afternoon?.tz ?? 'America/New_York')
  // Команда в Киеве, офис на восточном побережье — семь часов разницы. Показываем обе
  // стороны, иначе «12:00» читается как своё время.
  const officeTz = morning?.tz ?? afternoon?.tz ?? 'America/New_York'
  const vm = morning ? inViewerZone(officeTz, morning.local_hour, morning.local_minute) : null
  const va = afternoon ? inViewerZone(officeTz, afternoon.local_hour, afternoon.local_minute) : null
  const viewer = vm && va ? { morning: vm.time, afternoon: va.time, zone: vm.zone } : null

  // Локальные значения полей: правки копим и сохраняем по кнопке, как в чек-листах.
  const [mTime, setMTime] = useState('')
  const [aTime, setATime] = useState('')
  useEffect(() => {
    if (morning) setMTime(hhmm(morning.local_hour, morning.local_minute))
    if (afternoon) setATime(hhmm(afternoon.local_hour, afternoon.local_minute))
  }, [morning?.local_hour, morning?.local_minute, afternoon?.local_hour, afternoon?.local_minute])

  const dirty =
    (!!morning && mTime !== hhmm(morning.local_hour, morning.local_minute)) ||
    (!!afternoon && aTime !== hhmm(afternoon.local_hour, afternoon.local_minute))

  const saveM = useMutation({
    mutationFn: async () => {
      const apply = async (jobname: string, value: string) => {
        const [h, m] = value.split(':').map(Number)
        if (Number.isNaN(h) || Number.isNaN(m)) throw new Error(`Invalid time: ${value}`)
        await setSchedule(jobname, h, m)
      }
      if (morning && mTime !== hhmm(morning.local_hour, morning.local_minute)) await apply(jobs.morning, mTime)
      if (afternoon && aTime !== hhmm(afternoon.local_hour, afternoon.local_minute)) await apply(jobs.afternoon, aTime)
    },
    onSuccess: () => {
      setStatus({ type: 'success', msg: 'Schedule saved.' })
      qc.invalidateQueries({ queryKey: ['hr-sync-schedule'] })
    },
    onError: (e) => setStatus({ type: 'error', msg: errMsg(e) }),
  })

  async function sync() {
    setStatus(null)
    setLoading(true)
    try {
      await runSync(type)
      setStatus({ type: 'success', msg: 'Sync initiated.' })
    } catch (e) {
      setStatus({ type: 'error', msg: errMsg(e) })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card className="flex flex-col p-6">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-50 text-brand-blue">{icon}</div>
        <div>
          <h2 className="text-lg font-bold text-gray-900">{title}</h2>
          <p className="text-sm text-gray-500">{description}</p>
        </div>
      </div>

      <Button variant="blue" className="w-full py-2.5" onClick={sync} disabled={loading}>
        <RefreshCw size={16} className={cn(loading && 'animate-spin')} /> {loading ? 'Syncing…' : `Sync ${title}`}
      </Button>

      {status && (
        <div
          className={cn(
            'mt-3 flex items-start gap-2 rounded-lg px-3 py-2 text-sm',
            status.type === 'success' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700',
          )}
        >
          {status.type === 'success' ? (
            <CheckCircle2 size={15} className="mt-0.5 shrink-0" />
          ) : (
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          )}
          <span>{status.msg}</span>
        </div>
      )}

      {/* Расписание автосинка. Вводится время офиса (ET); в cron уходит пересчитанным
          в UTC, переход на летнее время подхватывается сам — на экран это не выносим. */}
      <div className="mt-5 border-t border-gray-100 pt-4">
        <div className="mb-2 flex flex-wrap items-baseline gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">Automatic Sync Times</span>
          <span className="text-xs text-gray-500">
            office time · {tz.abbr} · {tz.offset}
          </span>
        </div>

        {scheduleError ? (
          <p className="text-sm text-red-600">{scheduleError}</p>
        ) : loadingSchedule ? (
          <p className="text-sm text-gray-400">Loading schedule…</p>
        ) : !morning && !afternoon ? (
          <p className="text-sm text-gray-400">No scheduled jobs found.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <TimeField label="Morning" value={mTime} onChange={setMTime} />
              <TimeField label="Afternoon" value={aTime} onChange={setATime} />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button variant="primary" disabled={!dirty || saveM.isPending} onClick={() => saveM.mutate()}>
                {saveM.isPending ? 'Saving…' : 'Save Schedule'}
              </Button>
            </div>

            {/* Показываем только то, с чем человек что-то делает: своё время рядом с
                офисным (разница семь часов). Пересчёт в UTC и переход на летнее время
                система берёт на себя — сообщать о них незачем. */}
            {viewer && (
              <p className="mt-3 text-xs text-gray-500">
                {viewer.morning} and {viewer.afternoon} in your timezone ({viewer.zone}).
              </p>
            )}
          </>
        )}
      </div>
    </Card>
  )
}

function TimeField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="mb-1 block text-xs text-gray-500">{label}</label>
      <input
        type="time"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-accent-500 focus:ring-1 focus:ring-accent-500"
      />
    </div>
  )
}

/** «0 16 * * *» → «16:00». Показываем рядом с местным временем, чтобы было видно обе стороны. */
function cronToUtcLabel(expr: string | undefined): string {
  if (!expr) return '—'
  const [m, h] = expr.split(' ')
  if (h === undefined) return expr
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`
}
