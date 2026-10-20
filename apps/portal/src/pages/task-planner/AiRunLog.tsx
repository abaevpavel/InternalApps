/**
 * Журнал Send to AI для разработчика (миграция 0041): по каждому запросу — что отправили, что
 * пришло от AI и что легло на задачу («до → после»), какие пометки поставлены, что пропущено.
 * Кнопка видна только роли Developer; читать таблицу база тоже даёт только ей (RLS).
 */
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useAuth } from '../../auth/AuthProvider'
import { Button, Modal } from '../../components/task-planner-ui'
import { errMsg } from '../../lib/utils'
import { fetchAiRunLog, type AiRunLogRow } from '../../services/task-planner/data'

export function useIsDeveloper(): boolean {
  const { profile } = useAuth()
  return (profile?.roles ?? []).some((r) => r.name === 'Developer')
}

type Rec = Record<string, unknown> | null | undefined
const str = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v))
const hoursToMin = (v: unknown) => (v === null || v === undefined ? '—' : `${Math.round(Number(v) * 60)}m`)

interface TaskTrace {
  taskId: string
  title: string
  sent?: AiRunLogRow
  result?: AiRunLogRow
}

interface RunTrace {
  requestId: string
  date: string | null
  at: string
  tasks: TaskTrace[]
  applied: number
  ignored: number
  warned: number
}

function groupRuns(rows: AiRunLogRow[]): RunTrace[] {
  const runs = new Map<string, RunTrace>()
  for (const r of [...rows].sort((a, b) => a.id - b.id)) {
    let run = runs.get(r.request_id)
    if (!run) {
      run = { requestId: r.request_id, date: r.batch_date, at: r.created_at, tasks: [], applied: 0, ignored: 0, warned: 0 }
      runs.set(r.request_id, run)
    }
    const id = r.task_id ?? `row-${r.id}`
    let t = run.tasks.find((x) => x.taskId === id)
    if (!t) {
      t = { taskId: id, title: '' }
      run.tasks.push(t)
    }
    if (r.kind === 'sent') {
      t.sent = r
      t.title = String((r.sent as Rec)?.title ?? '')
    } else {
      t.result = r
      if (r.kind === 'applied') run.applied++
      else run.ignored++
      if (r.warnings?.length) run.warned++
    }
  }
  return [...runs.values()].sort((a, b) => b.at.localeCompare(a.at))
}

export function AiRunLogButton() {
  const isDev = useIsDeveloper()
  const [open, setOpen] = useState(false)
  if (!isDev) return null
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} title="Developer only: what was sent to the AI, what came back and what was applied">
        🧾 AI log
      </Button>
      <Modal open={open} title="AI runs — developer log" onClose={() => setOpen(false)} size="lg"
        footer={<Button variant="ghost" onClick={() => setOpen(false)}>Close</Button>}>
        {open && <AiRunLogBody />}
      </Modal>
    </>
  )
}

function AiRunLogBody() {
  const q = useQuery({ queryKey: ['tp-ai-run-log'], queryFn: () => fetchAiRunLog() })
  const runs = useMemo(() => groupRuns(q.data ?? []), [q.data])
  const [openRun, setOpenRun] = useState<string | null>(null)

  if (q.isLoading) return <p className="text-sm text-gray-500">Loading…</p>
  if (q.error) return <p className="text-sm text-red-600">⚠ {errMsg(q.error)}</p>
  if (!runs.length) return <p className="text-sm text-gray-500">No AI runs logged yet. Runs are logged from the next Send to AI.</p>

  return (
    <div className="max-h-[32rem] space-y-2 overflow-auto text-sm">
      {runs.map((run) => {
        const isOpen = openRun === run.requestId
        return (
          <div key={run.requestId} className="rounded-md border border-gray-200">
            <button type="button" onClick={() => setOpenRun(isOpen ? null : run.requestId)}
              className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left hover:bg-gray-50">
              {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <b className="text-gray-900">{run.date ?? '—'}</b>
              <span className="text-gray-500">{new Date(run.at).toLocaleString('en-US')}</span>
              <span className="text-gray-600">· sent {run.tasks.filter((t) => t.sent).length}</span>
              <span className="text-gray-600">· applied {run.applied}</span>
              {run.ignored > 0 && <span className="text-red-600">· ignored {run.ignored}</span>}
              {run.warned > 0 && <span className="text-orange-600">· with warnings {run.warned}</span>}
              {!run.applied && !run.ignored && <span className="text-gray-400">· no answer applied</span>}
              <span className="ml-auto font-mono text-[11px] text-gray-400">{run.requestId}</span>
            </button>
            {isOpen && (
              <div className="space-y-2 border-t border-gray-100 p-3">
                {run.tasks.map((t) => <TaskTraceView key={t.taskId} t={t} />)}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function TaskTraceView({ t }: { t: TaskTrace }) {
  const sent = t.sent?.sent as Rec
  const recv = t.result?.received as Rec
  const before = t.result?.applied?.before as Rec
  const after = t.result?.applied?.after as Rec
  const stAfter = after?.scheduled_time as Rec
  return (
    <div className="rounded-md bg-gray-50 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <b className="text-gray-900">{t.title || '(untitled)'}</b>
        <span className="font-mono text-[11px] text-gray-400">{t.taskId}</span>
        {t.result?.kind === 'ignored' && <span className="text-xs font-medium text-red-600">ignored: {t.result.note}</span>}
        {!t.result && <span className="text-xs text-gray-400">no answer applied</span>}
      </div>
      <div className="mt-1.5 grid grid-cols-1 gap-2 text-xs md:grid-cols-3">
        <div>
          <div className="font-semibold text-gray-700">Sent</div>
          <div>crew: {str(sent?.team_id)}</div>
          <div>duration: {hoursToMin(sent?.estimated_duration)}</div>
          <div>time: {str(sent?.scheduled_time)}</div>
          <div>date: {str(sent?.scheduled_date)}</div>
        </div>
        <div>
          <div className="font-semibold text-gray-700">AI returned</div>
          {recv ? (
            <>
              <div>crew: {str(recv.team_name ?? recv.team_id)}</div>
              <div>time: {str(recv.start_time)} – {str(recv.end_time)}</div>
              <div>duration: {str(recv.duration_minutes)}m</div>
              <div>order: {str(recv.scheduled_order)} · drive: {str(recv.drive_minutes_from_previous)}m</div>
              {recv.reason !== undefined && <div>unscheduled: {str(recv.reason)}</div>}
            </>
          ) : <div className="text-gray-400">—</div>}
        </div>
        <div>
          <div className="font-semibold text-gray-700">Applied (before → after)</div>
          {after ? (
            <>
              <div>crew: {str(before?.team_id)} → {str(after.team_id)}</div>
              <div>order: {str(before?.stop_number)} → {str(after.stop_number)}</div>
              <div>time: {str(stAfter?.start)} – {str(stAfter?.end)}</div>
              <div>travel: {str(before?.travel_time)} → {str(after.travel_time)}</div>
            </>
          ) : <div className="text-gray-400">—</div>}
        </div>
      </div>
      {t.result?.warnings?.length ? (
        <ul className="mt-1.5 list-disc pl-5 text-xs text-orange-700">
          {t.result.warnings.map((w, i) => <li key={i}>{w.message}</li>)}
        </ul>
      ) : null}
    </div>
  )
}
