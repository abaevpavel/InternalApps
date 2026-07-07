import { useState } from 'react'
import { AlertTriangle, Building2, CheckCircle2, RefreshCw, Users } from 'lucide-react'
import { Button, Card, PageTitle } from '../../components/ui'
import { cn, errMsg } from '../../lib/utils'
import { runSync, type SyncType } from '../../services/hr-sync'

const NOT_WIRED =
  "Not functional — editing the schedule isn't wired up. Automatic syncs run on a fixed server cron (shown below)."

export function HRSyncAirtablePage() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <PageTitle title="HR Sync — Airtable Contacts" subtitle="Trigger contact syncs to Airtable via Make.com." />
      <div className="grid gap-5 md:grid-cols-2">
        <SyncCard
          type="employees"
          title="Employee Contacts"
          description="Sync employee contacts into Airtable."
          icon={<Users size={26} />}
          times={['11:00', '17:00']}
        />
        <SyncCard
          type="vendors"
          title="Key Vendor Contacts"
          description="Sync key vendor contacts into Airtable."
          icon={<Building2 size={26} />}
          times={['11:10', '17:10']}
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
  times,
}: {
  type: SyncType
  title: string
  description: string
  icon: React.ReactNode
  times: [string, string]
}) {
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<{ type: 'success' | 'error'; msg: string } | null>(null)
  const [scheduleNote, setScheduleNote] = useState(false)

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

      {/* schedule (read-only — editing not wired up) */}
      <div className="mt-5 border-t border-gray-100 pt-4">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Automatic Sync Times (ET)</div>
        <div className="grid grid-cols-2 gap-3">
          <TimeField label="Morning" value={times[0]} />
          <TimeField label="Afternoon" value={times[1]} />
        </div>
        <div className="mt-3 flex items-center gap-3">
          {/* not `disabled` so the title tooltip shows on hover */}
          <button
            title={NOT_WIRED}
            onClick={() => setScheduleNote(true)}
            className="cursor-not-allowed rounded-lg bg-gray-100 px-3.5 py-2 text-sm font-medium text-gray-400"
          >
            Save Schedule
          </button>
          <span className="text-xs text-gray-400">Managed by server cron</span>
        </div>
        {scheduleNote && <p className="mt-2 text-xs text-amber-600">{NOT_WIRED}</p>}
      </div>
    </Card>
  )
}

function TimeField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <label className="mb-1 block text-xs text-gray-500">{label}</label>
      <input
        type="time"
        value={value}
        readOnly
        title="Read-only — schedule is managed by server cron and can't be edited here yet."
        className="w-full cursor-not-allowed rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-500"
      />
    </div>
  )
}
