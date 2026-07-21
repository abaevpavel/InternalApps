import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  DndContext, closestCenter, closestCorners, PointerSensor, useSensor, useSensors,
  useDroppable, DragOverlay, type DragEndEvent, type DragOverEvent,
} from '@dnd-kit/core'
import {
  SortableContext, arrayMove, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  GripVertical, SquarePen, Clock, Calendar, Users, Wrench, MapPin, Loader2,
  ArrowRight, AlertTriangle, CheckCircle2, Lock, LockOpen, Trash2, Info, RefreshCw,
} from 'lucide-react'
import { Button, Card, Input, Badge, StatusBadge, Modal, Tabs } from '../../components/task-planner-ui'
import { cn, errMsg } from '../../lib/utils'
import {
  fetchTasks, fetchTeams, fetchSkills, fetchAvailability,
  fetchScheduleRun, applyScheduleToTasks, pullScheduleIntoTasks,
  replaceProposedWithSchedule, deleteTasksByStatus, restoreRequestedFromRun,
  updateTask, deleteTask, type UpdateTaskInput,
} from '../../services/task-planner/data'
import { sendToAi, sendToSlack, buildSlackPayload } from '../../services/task-planner/n8n'
import { resolveString } from '../../services/app-settings'
import { pollScheduleRun } from '../../services/task-planner/aiPoller'
import { setPendingRequestId, getPendingRequestId, clearPendingRequestId } from '../../services/task-planner/pendingRun'
import { buildTravelMatrix, matrixProvider, edgeKey, type MatrixPoint } from '../../services/task-planner/maps'
import { recomputeTeamDay, type Point } from '../../domain/task-planner/scheduling-engine'
import { minToAmPm, hhmmToMin, minToHm, minToHoursLabel } from '../../lib/task-planner-time'
import type { ScheduledTask, TeamDay, Task } from '../../domain/task-planner/types'

/** Простой генератор request_ID для запуска планировщика. */
function newRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return 'req-' + Math.abs(Date.now()).toString(36)
}

/** Task → ScheduledTask (строка расписания). */
function taskToScheduled(t: Task): ScheduledTask {
  return {
    scheduled_order: t.stop_number ?? 0,
    task_id: t.id,
    project_id: t.project_id ?? '',
    project_name: t.project_name ?? '',
    project_address: t.task_address,
    description: t.title ?? t.description,
    anchor: t.anchor ?? false,
    anchor_time: t.anchor_time ?? '',
    start_time: t.sched_start ?? '',
    end_time: t.sched_end ?? '',
    duration_minutes: t.estimated_duration_min,
    drive_minutes_from_previous: t.travel_time ?? 0,
    additional_stop: t.additional_stop,
  }
}

/** Группировка задач по бригадам → дни расписания. */
function buildTeamDays(tasks: Task[]): TeamDay[] {
  const groups = new Map<string, Task[]>()
  for (const t of tasks) {
    const key = t.assigned_team_id ?? 'unassigned'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(t)
  }
  const days: TeamDay[] = []
  for (const [key, ts] of groups) {
    ts.sort((a, b) => (a.stop_number ?? 0) - (b.stop_number ?? 0))
    const st = ts.map(taskToScheduled)
    const totalDur = ts.reduce((s, t) => s + t.estimated_duration_min, 0)
    const totalTravel = st.slice(1).reduce((s, t) => s + t.drive_minutes_from_previous, 0)
    const working = totalDur + totalTravel
    days.push({
      team_id: key, team_name: ts[0].assigned_team_name ?? (key === 'unassigned' ? 'Unassigned' : key),
      date: ts[0].scheduled_date, timezone: 'America/New_York',
      team_home_base: ts[0].assigned_team_home_base ?? '',
      workday_start_time: st[0]?.start_time ?? '', workday_end_time: st[st.length - 1]?.end_time ?? '',
      morning_commute_minutes: 0, end_of_day_commute_minutes: 0,
      total_working_minutes: working,
      day_length_category: working <= 480 ? 'normal' : working <= 600 ? 'overtime_8_to_10' : 'overtime_over_10',
      overtime: working > 480, tasks: st,
      summary: { total_tasks: st.length, total_travel_in_day_minutes: totalTravel },
    })
  }
  return days.sort((a, b) => a.team_name.localeCompare(b.team_name))
}

type Tab = 'requested' | 'proposed' | 'scheduled'

export function TasksPage() {
  const [tab, setTab] = useState<Tab>('requested')
  return (
    <div>
      <Tabs<Tab>
        className="mb-6"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'requested', label: 'Requested' },
          { key: 'proposed', label: 'Proposed' },
          { key: 'scheduled', label: 'Scheduled' },
        ]}
      />
      {tab === 'requested' && <Requested goProposed={() => setTab('proposed')} />}
      {tab === 'proposed' && <Proposed goScheduled={() => setTab('scheduled')} />}
      {tab === 'scheduled' && <Scheduled />}
    </div>
  )
}

/* ---------------- Requested ---------------- */
function priorityTone(p: number): { label: string; tone: 'danger' | 'warning' | 'neutral' } {
  if (p <= 3) return { label: 'High', tone: 'danger' }
  if (p >= 7) return { label: 'Low', tone: 'neutral' }
  return { label: 'Medium', tone: 'warning' }
}

function Requested({ goProposed }: { goProposed: () => void }) {
  const qc = useQueryClient()
  const { data: tasks } = useQuery({ queryKey: ['tasks', 'requested'], queryFn: () => fetchTasks('requested') })
  const [error, setError] = useState<string | null>(null)

  // Send to AI: отправить задачи планировщику → поллить результат → перевести в proposed.
  // URL вебхука берём из app_settings (Админка), не из хардкода.
  const send = useMutation({
    mutationFn: async () => {
      const list = tasks ?? []
      if (!list.length) throw new Error('No requested tasks')
      const [teams, skills, unavailable, webhookUrl] = await Promise.all([
        fetchTeams(), fetchSkills(), fetchAvailability(),
        resolveString('task-planner', 'planner_webhook', import.meta.env.VITE_N8N_PLANNER_WEBHOOK as string | undefined),
      ])
      const requestId = newRequestId()
      // запоминаем запрос ДО ожидания — если поллинг прервётся (таймаут/refresh),
      // результат можно будет подтянуть кнопкой по этому id.
      setPendingRequestId(requestId)
      const date = list[0]?.scheduled_date ?? null
      await sendToAi({
        requestId, date, tasks: list, teams, unavailableTeams: unavailable, skills,
        webhookUrl: webhookUrl ?? undefined,
      })
      const run = await pollScheduleRun(requestId)
      if (run.status === 'error') throw new Error(run.error || 'AI returned an error')
      // материализуем AI-расписание как НОВЫЕ proposed-копии; requested-эталон
      // НЕ трогаем (всегда остаётся для повторных тестов).
      if (run.output_data?.schedule?.length) {
        await replaceProposedWithSchedule(run.output_data.schedule)
      } else {
        throw new Error('AI returned no schedule (empty)')
      }
      clearPendingRequestId() // результат применён — запрос больше не «висит»
      return run
    },
    onSuccess: () => {
      setError(null)
      qc.invalidateQueries({ queryKey: ['tasks'] })
      qc.invalidateQueries({ queryKey: ['scheduleRun'] })
      goProposed()
    },
    // НЕ чистим pending на ошибке (таймаут и т.п.) — даём шанс подтянуть результат
    onError: (e: unknown) => setError(errMsg(e)),
  })

  // Восстановление: подтянуть результат «висящего» запроса (после таймаута/refresh).
  const pendingId = getPendingRequestId()
  const recover = useMutation({
    mutationFn: async () => {
      const n = await pullScheduleIntoTasks(getPendingRequestId() ?? undefined)
      if (!n) throw new Error('Result not ready yet or not found in Supabase')
      clearPendingRequestId()
      return n
    },
    onSuccess: () => {
      setError(null)
      qc.invalidateQueries({ queryKey: ['tasks'] })
      qc.invalidateQueries({ queryKey: ['scheduleRun'] })
      goProposed()
    },
    onError: (e: unknown) => setError(errMsg(e)),
  })

  // Сброс тестового набора: восстановить эталонные requested-задачи из последнего
  // прогона (input_tasks) + проставить утренние якоря 09/11/12 в формате ИИ.
  const restore = useMutation({
    mutationFn: async () => {
      const n = await restoreRequestedFromRun()
      if (!n) throw new Error('No saved run with input_tasks to restore')
      return n
    },
    onSuccess: () => {
      setError(null)
      qc.invalidateQueries({ queryKey: ['tasks'] })
    },
    onError: (e: unknown) => setError(errMsg(e)),
  })

  // Удаление задачи прямо из Requested (Edit убран, Delete оставлен).
  const del = useMutation({
    mutationFn: (id: string) => deleteTask(id),
    onSuccess: () => { setError(null); qc.invalidateQueries({ queryKey: ['tasks'] }) },
    onError: (e: unknown) => setError(errMsg(e)),
  })

  const busy = send.isPending || recover.isPending || restore.isPending
  return (
    <div className="space-y-6">
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Generate Schedule</h2>
          <div className="flex items-center gap-2">
            <Button variant="ghost" className="text-gray-500" disabled={busy} onClick={() => restore.mutate()}>
              {restore.isPending ? 'Resetting…' : '↺ Reset test set'}
            </Button>
            <Badge className="bg-gray-100 text-gray-600">{tasks?.length ?? 0} tasks</Badge>
          </div>
        </div>
        <div className="mt-4 flex items-center justify-between">
          <span className="text-sm text-gray-500">
            {busy ? 'Sending tasks & waiting for AI…' : `${tasks?.length ?? 0} tasks will be analyzed`}
          </span>
          <div className="flex gap-2">
            <Button variant="primary" disabled={busy || !tasks?.length} onClick={() => send.mutate()}>
              {busy ? <span className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" /> Working…</span> : 'Send to AI'}
            </Button>
          </div>
        </div>
        {error && <p className="mt-3 text-sm text-red-600">⚠ {error}</p>}
      </Card>

      {pendingId && !send.isPending && (
        <Card className="flex flex-wrap items-center gap-3 border-amber-200 bg-amber-50 p-4">
          <AlertTriangle size={18} className="text-amber-600" />
          <span className="text-sm text-amber-800">
            There's an unfinished AI request — polling may have been interrupted (timeout/refresh). You can pull the result.
          </span>
          <Button variant="outline" className="ml-auto border-amber-300 text-amber-800"
            disabled={recover.isPending} onClick={() => recover.mutate()}>
            {recover.isPending ? 'Pulling…' : 'Pull AI result'}
          </Button>
        </Card>
      )}

      <div>
        <div className="mb-3 flex items-center gap-2">
          <StatusBadge tone="info">Unassigned</StatusBadge>
          <span className="text-sm text-gray-500">{tasks?.length ?? 0} tasks</span>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {tasks?.map((t) => (
            <TaskCardCompact key={t.id} t={t}
              onDelete={() => { if (confirm(`Delete task “${t.title ?? t.description}”?`)) del.mutate(t.id) }} />
          ))}
        </div>
      </div>
    </div>
  )
}

/** Компактная карточка задачи (Requested). Только просмотр + удаление (без Edit). */
function TaskCardCompact({ t, onDelete }: { t: Task; onDelete?: () => void }) {
  const title = t.title ?? (t.description ?? '').split('\n')[0]
  const skillCount = t.required_skill_ids?.length ?? 0
  const durH = (t.estimated_duration_min ?? 0) / 60
  const prio = priorityTone(t.priority ?? 5)
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold text-gray-900">{title}</span>
            <Badge className="shrink-0 bg-accent-50 text-accent-700">{t.task_type}</Badge>
          </div>
          <div className="truncate text-xs text-gray-500">
            {[t.project_name, t.task_address, t.project_manager ? `PM: ${t.project_manager}` : null].filter(Boolean).join(' · ')}
          </div>
        </div>
        <button onClick={onDelete} className="shrink-0 text-gray-400 hover:text-red-600" aria-label="delete"><Trash2 size={16} /></button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-gray-600">
        <StatusBadge tone={prio.tone}>{prio.label}</StatusBadge>
        <span className="flex items-center gap-1"><Clock size={13} /> {durH.toFixed(1)}h</span>
        {t.exact_time && <span className="font-semibold text-accent-700">{t.exact_time}</span>}
        {t.scheduled_date && <span className="flex items-center gap-1"><Calendar size={13} /> {t.scheduled_date}</span>}
        <span className="flex items-center gap-1">
          <Users size={13} /> {t.assigned_team_name ?? (t.assigned_team_id ? 'assigned' : <span className="text-accent-600">N/A</span>)}
        </span>
        <span className="flex items-center gap-1">
          <Wrench size={13} /> {skillCount ? `${skillCount} skills` : <span className="text-accent-600">N/A</span>}
        </span>
        {t.additional_stop
          ? <span className="flex items-center gap-1"><MapPin size={13} /> +stop {t.additional_stop.when}</span>
          : <span className="flex items-center gap-1 text-accent-600"><MapPin size={13} /> no stop</span>}
      </div>
    </Card>
  )
}

/** Модалка редактирования / удаления задачи (Requested). */
function TaskEditModal({ task, onClose, onSaved }: {
  task: Task | null
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<UpdateTaskInput>({})
  const [confirmDel, setConfirmDel] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!task) return
    setForm({
      title: task.title ?? '',
      description: task.description ?? '',
      estimated_duration_min: task.estimated_duration_min,
      priority: task.priority,
      scheduled_date: task.scheduled_date,
      address: task.task_address,
    })
    setConfirmDel(false)
    setError(null)
  }, [task])

  const save = useMutation({
    mutationFn: () => updateTask(task!.id, form),
    onSuccess: onSaved,
    onError: (e: unknown) => setError(errMsg(e)),
  })
  const del = useMutation({
    mutationFn: () => deleteTask(task!.id),
    onSuccess: onSaved,
    onError: (e: unknown) => setError(errMsg(e)),
  })
  const busy = save.isPending || del.isPending

  const set = (patch: Partial<UpdateTaskInput>) => setForm((f) => ({ ...f, ...patch }))

  return (
    <Modal
      open={!!task}
      size="lg"
      title="Edit task"
      onClose={onClose}
      footer={
        <div className="flex w-full items-center justify-between">
          <Button variant="ghost" className="text-red-600 hover:bg-red-50"
            disabled={busy} onClick={() => setConfirmDel(true)}>
            <span className="flex items-center gap-1"><Trash2 size={15} /> Delete</span>
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={busy} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        {confirmDel && (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <span className="flex items-center gap-2"><AlertTriangle size={16} /> Delete this task permanently?</span>
            <div className="flex gap-2">
              <Button variant="ghost" className="py-1" disabled={busy} onClick={() => setConfirmDel(false)}>No</Button>
              <Button variant="danger" className="py-1" disabled={busy} onClick={() => del.mutate()}>
                {del.isPending ? 'Deleting…' : 'Yes, delete'}
              </Button>
            </div>
          </div>
        )}
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">Title</label>
          <Input value={form.title ?? ''} onChange={(e) => set({ title: e.target.value })} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">Description</label>
          <Input value={form.description ?? ''} onChange={(e) => set({ description: e.target.value })} />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">Duration (min)</label>
            <Input type="number" value={form.estimated_duration_min ?? 0}
              onChange={(e) => set({ estimated_duration_min: Math.max(0, Number(e.target.value)) })} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">Priority (1–10)</label>
            <Input type="number" value={form.priority ?? 5}
              onChange={(e) => set({ priority: Number(e.target.value) })} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">Date</label>
            <Input type="date" value={form.scheduled_date ?? ''}
              onChange={(e) => set({ scheduled_date: e.target.value })} />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">Address</label>
          <Input value={form.address ?? ''} onChange={(e) => set({ address: e.target.value })} />
        </div>
        {error && <p className="text-sm text-red-600">⚠ {error}</p>}
      </div>
    </Modal>
  )
}

/* ---------------- Proposed (реальные tasks со status=proposed + движок) ---------------- */
function Proposed({ goScheduled }: { goScheduled: () => void }) {
  const qc = useQueryClient()
  // источник — реальные tasks (status=proposed), материализованные из AI при Send to AI
  const { data: tasks, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['tasks', 'proposed'], queryFn: () => fetchTasks('proposed'),
  })
  // последний AI-прогон — только для модалки Explain Yourself (комментарии)
  const { data: run } = useQuery({ queryKey: ['scheduleRun'], queryFn: () => fetchScheduleRun() })
  const days = useMemo<TeamDay[]>(() => buildTeamDays(tasks ?? []), [tasks])
  // актуальное (отредактированное на доске) расписание по всем бригадам — для Approve
  const editedRef = useRef<TeamDay[]>(days)
  const [error, setError] = useState<string | null>(null)
  const [explainOpen, setExplainOpen] = useState(false)

  const approve = useMutation({
    mutationFn: async () => {
      await applyScheduleToTasks(editedRef.current, 'scheduled')
    },
    onSuccess: () => {
      setError(null)
      qc.invalidateQueries({ queryKey: ['tasks'] })
      goScheduled()
    },
    onError: (e: unknown) => setError(errMsg(e)),
  })

  // Подтянуть последний результат планировщика из Supabase и материализовать
  // (на случай таймаута/refresh — результат не теряется).
  const pull = useMutation({
    mutationFn: async () => {
      const n = await pullScheduleIntoTasks()
      if (!n) throw new Error('No ready AI result in Supabase yet')
      clearPendingRequestId()
      return n
    },
    onSuccess: () => {
      setError(null)
      qc.invalidateQueries({ queryKey: ['tasks'] })
      qc.invalidateQueries({ queryKey: ['scheduleRun'] })
    },
    onError: (e: unknown) => setError(errMsg(e)),
  })

  // Удалить ВСЕ proposed-задачи (это копии; requested-эталон не затрагивается).
  const wipe = useMutation({
    mutationFn: () => deleteTasksByStatus('proposed'),
    onSuccess: () => {
      setError(null)
      editedRef.current = []
      qc.invalidateQueries({ queryKey: ['tasks'] })
    },
    onError: (e: unknown) => setError(errMsg(e)),
  })

  // Persist current computed schedule (Google travel + manual edits) into the
  // proposed rows, so a page reload keeps recalculated travel and reorder.
  const [saved, setSaved] = useState(false)
  const save = useMutation({
    mutationFn: () => applyScheduleToTasks(editedRef.current, 'proposed'),
    onSuccess: () => {
      setError(null); setSaved(true)
      qc.invalidateQueries({ queryKey: ['tasks'] })
    },
    onError: (e: unknown) => { setSaved(false); setError(errMsg(e)) },
  })

  if (isLoading) return <p className="text-gray-500">Loading…</p>
  if (!days.length) return (
    <div className="space-y-3">
      <p className="text-gray-500">No proposed tasks. Run Send to AI on the Requested tab.</p>
      <Button variant="outline" className="text-blue-600" disabled={pull.isPending} onClick={() => pull.mutate()}>
        {pull.isPending ? 'Pulling…' : 'Pull AI result'}
      </Button>
      {error && <p className="text-sm text-red-600">⚠ {error}</p>}
    </div>
  )

  const total = days.reduce((s, d) => s + d.tasks.length, 0)
  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-2 p-4">
        {days[0]?.date && (
          <Badge className="bg-accent-50 font-semibold text-accent-700">
            📅 {new Date(days[0].date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
          </Badge>
        )}
        <Badge className="bg-gray-100 text-gray-600">{total} tasks</Badge>
        <Button variant="outline" className="text-blue-600" disabled={isFetching} onClick={() => refetch()}>
          {isFetching ? 'Refreshing…' : 'Fetch AI Data'}
        </Button>
        <Button variant="outline" className="text-blue-600" disabled={pull.isPending} onClick={() => pull.mutate()}>
          {pull.isPending ? 'Pulling…' : 'Pull AI result'}
        </Button>
        <Button variant="outline" className="text-blue-600" disabled={save.isPending}
          onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : saved ? '✓ Saved' : 'Save changes'}
        </Button>
        <Button variant="green" disabled={approve.isPending} onClick={() => approve.mutate()}>
          {approve.isPending ? 'Approving…' : 'Approve All'}
        </Button>
        <Button variant="outline" onClick={() => setExplainOpen(true)}>💬 Explain Yourself</Button>
        <Button variant="outline" className="ml-auto border-red-200 text-red-600"
          disabled={wipe.isPending}
          onClick={() => { if (confirm(`Delete all ${total} tasks from Proposed? Requested is not affected.`)) wipe.mutate() }}>
          {wipe.isPending ? 'Deleting…' : '🗑 Delete all'}
        </Button>
        {error && <span className="text-sm text-red-600">⚠ {error}</span>}
      </Card>
      <EditableBoard days={days} onComputed={(d) => { editedRef.current = d }} />

      <Modal open={explainOpen} title="AI reasoning — how the schedule was built" onClose={() => setExplainOpen(false)} size="lg"
        footer={<Button variant="ghost" onClick={() => setExplainOpen(false)}>Close</Button>}>
        <ExplainComments ai1={run?.comments_ai_1} ai2={run?.comments_ai_2} days={days} />
      </Modal>
    </div>
  )
}

/** Человекочитаемый разбор комментариев ИИ (route builder + inserter). */
function ExplainComments({ ai1, ai2, days }: { ai1: unknown; ai2: unknown; days: TeamDay[] }) {
  const [raw, setRaw] = useState(false)
  const taskName = useMemo(() => {
    const m = new Map<string, string>()
    for (const d of days) for (const t of d.tasks) m.set(t.task_id, (t.description || '').split('\n')[0].trim() || t.task_id.slice(0, 8))
    return m
  }, [days])
  const teamName = useMemo(() => {
    const m = new Map<string, string>()
    for (const d of days) m.set(d.team_id, d.team_name)
    return m
  }, [days])
  // резолв id→имя; если ключ уже имя (ИИ так делает в first_task_rationale) — отдаём как есть
  const tN = (id?: string) => (id && taskName.get(id)) || id || ''
  const teamN = (id?: string) => (id && teamName.get(id)) || id || ''

  const a1 = (ai1 && typeof ai1 === 'object' ? ai1 : {}) as Record<string, any>
  const a2 = (ai2 && typeof ai2 === 'object' ? ai2 : {}) as Record<string, any>
  const inserted: any[] = Array.isArray(a2.inserted) ? a2.inserted : []
  const unscheduled: any[] = Array.isArray(a2.unscheduled) ? a2.unscheduled : []
  const anchors: any[] = Array.isArray(a1.anchor_conflicts_resolved) ? a1.anchor_conflicts_resolved : []
  const firstTask: Record<string, unknown> = (a1.first_task_rationale && typeof a1.first_task_rationale === 'object') ? a1.first_task_rationale : {}
  const notes = [a1.overtime_notes, a1.travel_time_methodology, a2.travel_time_methodology].filter((x) => typeof x === 'string' && x.trim()) as string[]
  const empty = !inserted.length && !unscheduled.length && !anchors.length && !Object.keys(firstTask).length && !notes.length

  if (raw) return (
    <div>
      <button className="mb-2 text-xs text-blue-600" onClick={() => setRaw(false)}>← back to readable</button>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs text-gray-600">{JSON.stringify({ comments_ai_1: ai1, comments_ai_2: ai2 }, null, 2)}</pre>
    </div>
  )
  if (empty) return <p className="text-gray-500">No AI reasoning available for this run. <button className="text-blue-600 underline" onClick={() => setRaw(true)}>view raw</button></p>

  return (
    <div className="max-h-[28rem] space-y-4 overflow-auto text-sm">
      <section>
        <h4 className="mb-1.5 font-semibold text-gray-800">📌 Placed unassigned tasks ({inserted.length})</h4>
        {inserted.length ? (
          <ul className="space-y-1.5">
            {inserted.map((x, i) => (
              <li key={i} className="rounded-md bg-gray-50 px-3 py-2 text-gray-700">
                <b className="text-gray-900">{tN(x.task_id)}</b> → <b className="text-accent-700">{teamN(x.team_id)}</b>
                <span className="text-gray-500">{x.placement ? ` · ${x.placement}` : ''}{x.added_drive_minutes != null ? ` · +${x.added_drive_minutes}m drive` : ''}{x.score != null ? ` · score ${x.score}` : ''}{x.overtime_after ? ` · +${x.overtime_after}m overtime` : ''}</span>
                {x.placed_between && (x.placed_between.prev_task_id || x.placed_between.next_task_id) && (
                  <div className="text-xs text-gray-400">between «{tN(x.placed_between.prev_task_id) || '—'}» and «{tN(x.placed_between.next_task_id) || '—'}»</div>
                )}
              </li>
            ))}
          </ul>
        ) : <p className="text-gray-400">—</p>}
      </section>

      {unscheduled.length > 0 && (
        <section>
          <h4 className="mb-1.5 font-semibold text-red-700">⚠ Could not schedule ({unscheduled.length})</h4>
          <ul className="space-y-1">{unscheduled.map((x, i) => <li key={i} className="text-red-600"><b>{tN(x.task_id)}</b> — {x.reason}{x.notes ? ` (${x.notes})` : ''}</li>)}</ul>
        </section>
      )}

      {anchors.length > 0 && (
        <section>
          <h4 className="mb-1.5 font-semibold text-gray-800">⚓ Anchor handling</h4>
          <ul className="list-disc space-y-1 pl-5 text-gray-600">{anchors.map((a, i) => <li key={i}>{typeof a === 'string' ? a : (a?.notes || JSON.stringify(a))}</li>)}</ul>
        </section>
      )}

      {Object.keys(firstTask).length > 0 && (
        <section>
          <h4 className="mb-1.5 font-semibold text-gray-800">🚩 First task per team</h4>
          <ul className="space-y-1 text-gray-600">{Object.entries(firstTask).map(([tid, r]) => <li key={tid}><b className="text-accent-700">{teamN(tid)}</b>: {String(r)}</li>)}</ul>
        </section>
      )}

      {notes.length > 0 && (
        <section>
          <h4 className="mb-1.5 font-semibold text-gray-800">📝 Notes</h4>
          <ul className="space-y-1 text-gray-500">{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
        </section>
      )}

      <button className="text-xs text-gray-400 underline hover:text-gray-600" onClick={() => setRaw(true)}>view raw JSON</button>
    </div>
  )
}

/**
 * Доска расписания: drag задач ВНУТРИ бригады И МЕЖДУ бригадами, с живым пересчётом
 * обеих затронутых бригад (движок держит якоря). Состояние (порядок по бригадам,
 * Duration, ручной override travel) поднято на уровень доски.
 */
/** Время выезда, под которое Google считает трафик (один на день бригады). */
const TRAFFIC_DEPARTURE_HHMM = '09:00'

/** Провенанс задачи: travel ИИ→текущий + откуда, и ручные перемещения. */
interface TaskProv {
  aiDrive: number
  curDrive: number
  source: 'first' | 'manual' | 'google' | 'ai'
  departBasis?: string
  origTeam?: string
  curTeam?: string
  teamChanged: boolean
  origOrder?: number
  curOrder?: number
  orderChanged: boolean
}

function EditableBoard({ days, onComputed }: { days: TeamDay[]; onComputed?: (computed: TeamDay[]) => void }) {
  const allTasks = useMemo(() => days.flatMap((d) => d.tasks), [days])
  const byId = useMemo(() => Object.fromEntries(allTasks.map((t) => [t.task_id, t])), [allTasks])
  const meta = useMemo(() => Object.fromEntries(days.map((d) => [d.team_id, d])), [days])
  const teamIds = useMemo(() => days.map((d) => d.team_id), [days])

  const [cols, setCols] = useState<Record<string, string[]>>(
    () => Object.fromEntries(days.map((d) => [d.team_id, d.tasks.map((t) => t.task_id)])),
  )
  const [durations, setDurations] = useState<Record<string, number>>(
    () => Object.fromEntries(allTasks.map((t) => [t.task_id, t.duration_minutes])),
  )
  const [overrides, setOverrides] = useState<Record<string, number>>({})
  const [activeId, setActiveId] = useState<string | null>(null)
  // явный пересчёт travel через Google: bump → effect перестраивает матрицы
  const [recalcKey, setRecalcKey] = useState(0)
  const [recalcLoading, setRecalcLoading] = useState(false)

  // ре-инициализация при новом наборе days (новый прогон / Подтянуть)
  const sig = useMemo(
    () => days.map((d) => d.team_id + ':' + d.tasks.map((t) => t.task_id).join(',')).join('|'),
    [days],
  )
  const prevSig = useRef(sig)
  useEffect(() => {
    if (prevSig.current === sig) return
    prevSig.current = sig
    setCols(Object.fromEntries(days.map((d) => [d.team_id, d.tasks.map((t) => t.task_id)])))
    setDurations(Object.fromEntries(allTasks.map((t) => [t.task_id, t.duration_minutes])))
    setOverrides({})
  }, [sig, days, allTasks])

  // seed travel из чисел AI (fallback пока не приедет матрица Google)
  const seeds = useMemo(() => {
    const s: Record<string, Map<string, number>> = {}
    for (const d of days) {
      const m = new Map<string, number>()
      d.tasks.forEach((t, i) => {
        if (i > 0) m.set(edgeKey(d.tasks[i - 1].task_id, t.task_id), t.drive_minutes_from_previous ?? 0)
      })
      if (d.tasks[0]) m.set(edgeKey('home', d.tasks[0].task_id), d.morning_commute_minutes ?? 0)
      s[d.team_id] = m
    }
    return s
  }, [days])

  // матрицы Google по бригадам — пересобираем при изменении состава колонок
  const [matrices, setMatrices] = useState<Record<string, Map<string, number>>>({})
  const colsSig = useMemo(
    () => teamIds.map((id) => id + ':' + (cols[id] ?? []).join(',')).join('|'),
    [cols, teamIds],
  )
  useEffect(() => {
    let stale = false
    setRecalcLoading(true)
    ;(async () => {
      for (const tid of teamIds) {
        const m = meta[tid]
        if (!m) continue
        const points: MatrixPoint[] = [{ key: 'home', address: m.team_home_base }]
        for (const id of cols[tid] ?? []) {
          const t = byId[id]
          if (!t) continue
          points.push({ key: t.task_id, address: t.project_address })
          if (t.additional_stop?.address) points.push({ key: t.additional_stop.address, address: t.additional_stop.address })
        }
        const departureTime = m.date ? new Date(`${m.date}T${TRAFFIC_DEPARTURE_HHMM}:00`) : null
        try {
          const mx = await buildTravelMatrix(points, { departureTime })
          if (!stale) setMatrices((prev) => ({ ...prev, [tid]: mx }))
        } catch { /* остаёмся на seed */ }
      }
    })().finally(() => { if (!stale) setRecalcLoading(false) })
    return () => { stale = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colsSig, recalcKey])

  const computeTeam = useCallback((tid: string): TeamDay => {
    const m = meta[tid]
    const ordered = (cols[tid] ?? []).map((id) => byId[id]).filter(Boolean)
    const tasks: ScheduledTask[] = ordered.map((t) => {
      const ov = overrides[t.task_id]
      return {
        ...t,
        duration_minutes: durations[t.task_id] ?? t.duration_minutes,
        ...(ov != null
          ? { travel_overridden: true, drive_minutes_from_previous: ov }
          : { travel_overridden: false }),
      }
    })
    const pointOf = (t: ScheduledTask): Point => ({ lat: null, lng: null, key: t.task_id })
    const travel = matrixProvider(matrices[tid] ?? new Map(), (f, t) => seeds[tid]?.get(edgeKey(f.key ?? '', t.key ?? '')) ?? 0)
    return recomputeTeamDay({
      team_id: tid, team_name: m.team_name, date: m.date, timezone: m.timezone,
      home: { lat: null, lng: null, key: 'home' }, home_address: m.team_home_base, tasks, pointOf, travel,
    })
  }, [cols, byId, durations, overrides, matrices, seeds, meta])

  const computedDays = useMemo(() => teamIds.map((tid) => computeTeam(tid)), [teamIds, computeTeam])
  useEffect(() => { onComputed?.(computedDays) }, [computedDays, onComputed])

  // исходное (от ИИ) положение каждой задачи — для «было/стало»
  const origByTask = useMemo(() => {
    const m = new Map<string, { teamId: string; teamName: string; order: number; aiDrive: number }>()
    for (const d of days) d.tasks.forEach((t, i) =>
      m.set(t.task_id, { teamId: d.team_id, teamName: d.team_name, order: i + 1, aiDrive: t.drive_minutes_from_previous ?? 0 }))
    return m
  }, [days])

  // провенанс по каждой задаче: travel ИИ→текущий (источник), смена бригады/порядка
  const provByTask = useMemo(() => {
    const m = new Map<string, TaskProv>()
    for (const day of computedDays) {
      day.tasks.forEach((t, i) => {
        const orig = origByTask.get(t.task_id)
        const prevId = i > 0 ? day.tasks[i - 1].task_id : 'home'
        let source: TaskProv['source'] = 'first'
        if (i > 0) {
          if (overrides[t.task_id] != null) source = 'manual'
          else source = matrices[day.team_id]?.has(edgeKey(prevId, t.task_id)) ? 'google' : 'ai'
        }
        m.set(t.task_id, {
          aiDrive: orig?.aiDrive ?? 0,
          curDrive: t.drive_minutes_from_previous,
          source,
          departBasis: source === 'google' ? minToAmPm(hhmmToMin(TRAFFIC_DEPARTURE_HHMM)) : undefined,
          origTeam: orig?.teamName, curTeam: day.team_name,
          teamChanged: !!orig && orig.teamId !== day.team_id,
          origOrder: orig?.order, curOrder: i + 1,
          orderChanged: !!orig && (orig.teamId !== day.team_id || orig.order !== i + 1),
        })
      })
    }
    return m
  }, [computedDays, origByTask, overrides, matrices])

  const googleActive = useMemo(() => [...provByTask.values()].some((p) => p.source === 'google'), [provByTask])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const findContainer = useCallback((id: string): string | undefined => {
    if (cols[id]) return id
    return teamIds.find((tid) => (cols[tid] ?? []).includes(id))
  }, [cols, teamIds])

  function onDragOver(e: DragOverEvent) {
    const over = e.over
    if (!over) return
    const activeId = String(e.active.id)
    const overId = String(over.id)
    const from = findContainer(activeId)
    const to = findContainer(overId)
    if (!from || !to || from === to) return
    setCols((prev) => {
      const fromItems = (prev[from] ?? []).filter((id) => id !== activeId)
      const toItems = [...(prev[to] ?? [])]
      let idx = toItems.indexOf(overId)
      if (idx < 0) idx = toItems.length
      toItems.splice(idx, 0, activeId)
      return { ...prev, [from]: fromItems, [to]: toItems }
    })
  }

  function onDragEnd(e: DragEndEvent) {
    setActiveId(null)
    const over = e.over
    if (!over) return
    const activeId = String(e.active.id)
    const overId = String(over.id)
    const c = findContainer(activeId)
    if (!c) return
    const items = cols[c] ?? []
    const a = items.indexOf(activeId)
    const b = items.indexOf(overId)
    if (a >= 0 && b >= 0 && a !== b) setCols((prev) => ({ ...prev, [c]: arrayMove(prev[c] ?? [], a, b) }))
  }

  const activeTask = activeId ? byId[activeId] : null

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={(e) => setActiveId(String(e.active.id))}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div className="space-y-4">
        <Card className="flex flex-wrap items-center gap-3 p-3">
          <Button variant="outline" className="text-blue-600" disabled={recalcLoading}
            onClick={() => setRecalcKey((k) => k + 1)}>
            <span className="flex items-center gap-1.5">
              <RefreshCw size={14} className={cn(recalcLoading && 'animate-spin')} />
              {recalcLoading ? 'Recalculating…' : 'Recalculate travel (Google)'}
            </span>
          </Button>
          {recalcLoading ? (
            <span className="text-xs text-gray-400">computing travel times…</span>
          ) : googleActive ? (
            <span className="flex items-center gap-1 text-xs text-green-600"><CheckCircle2 size={13} /> Google: real travel (with traffic)</span>
          ) : recalcKey > 0 ? (
            // amber только ПОСЛЕ явного пересчёта (не пугаем при загрузке страницы)
            <span className="flex items-center gap-1 text-xs text-amber-600"><AlertTriangle size={13} /> Google unavailable — travel from AI estimate. Check key/console.</span>
          ) : (
            <span className="text-xs text-gray-400">travel from AI — click Recalculate for live Google times</span>
          )}
        </Card>
        {computedDays.map((day) => (
          <TeamColumn
            key={day.team_id}
            day={day}
            ids={cols[day.team_id] ?? []}
            durations={durations}
            overrides={overrides}
            provByTask={provByTask}
            onDuration={(id, v) => setDurations((d) => ({ ...d, [id]: v }))}
            onOverride={(id, v) => setOverrides((o) => {
              if (v == null) { const { [id]: _drop, ...rest } = o; return rest }
              return { ...o, [id]: v }
            })}
          />
        ))}
      </div>
      <DragOverlay>
        {activeTask ? (
          <div className="rounded-lg border border-accent-300 bg-white px-3 py-2 text-sm shadow-lg">
            <b className="text-gray-900">{activeTask.description}</b>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

/** Колонка одной бригады в доске: droppable-контейнер + сортируемые задачи. */
function TeamColumn({
  day, ids, durations, overrides, provByTask, onDuration, onOverride,
}: {
  day: TeamDay
  ids: string[]
  durations: Record<string, number>
  overrides: Record<string, number>
  provByTask: Map<string, TaskProv>
  onDuration: (id: string, v: number) => void
  onOverride: (id: string, v: number | null) => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: day.team_id })
  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-accent-50 px-3 py-2">
        <span className="font-semibold text-accent-700">👥 {day.team_name}</span>
        <Badge className="bg-gray-800 text-white">{day.tasks.length} tasks</Badge>
        <Badge className="bg-blue-50 text-blue-700">Total: {minToHm(day.total_working_minutes)}</Badge>
        <Badge className="bg-green-50 text-green-700">Duration: {minToHoursLabel(day.tasks.reduce((s, t) => s + t.duration_minutes, 0))}</Badge>
        <Badge className="bg-purple-50 text-purple-700">Travel: {day.summary?.total_travel_in_day_minutes}m</Badge>
        {day.overtime && <StatusBadge tone="danger">overtime +{minToHm(Math.max(0, day.total_working_minutes - 480))}</StatusBadge>}
      </div>

      <div ref={setNodeRef} className={cn('min-h-[48px] rounded-lg', isOver && 'bg-accent-50/60 ring-1 ring-accent-200')}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <div className="space-y-2">
            {day.tasks.map((t, i) => (
              <SortableTaskRow
                key={t.task_id} t={t} index={i}
                duration={durations[t.task_id] ?? t.duration_minutes}
                prov={provByTask.get(t.task_id)}
                onDuration={(v) => onDuration(t.task_id, v)}
                overridden={overrides[t.task_id] != null}
                onTravelOverride={(v) => onOverride(t.task_id, v)}
              />
            ))}
            {!day.tasks.length && (
              <div className="rounded-lg border border-dashed border-gray-200 px-3 py-4 text-center text-xs text-gray-400">
                Drop a task here
              </div>
            )}
          </div>
        </SortableContext>
      </div>

      <p className="mt-2 text-xs text-gray-400">Drag tasks within and between teams · change Duration — times recompute, anchors stay fixed.</p>
    </Card>
  )
}

/** Редактируемый день: drag-and-drop + Duration → движок пересчитывает, якорь держится. */
function EditableTeamDay({ day, onComputed }: { day: TeamDay; onComputed?: (d: TeamDay) => void }) {
  const [durations, setDurations] = useState<Record<string, number>>(
    () => Object.fromEntries(day.tasks.map((t) => [t.task_id, t.duration_minutes])),
  )
  const [order, setOrder] = useState<string[]>(() => day.tasks.map((t) => t.task_id))
  // ручной override travel по task_id (минуты). Если задан — движок не пересчитывает это ребро.
  const [overrides, setOverrides] = useState<Record<string, number>>({})
  // предложенный (но ещё не применённый) порядок — ждёт подтверждения в модалке
  const [pending, setPending] = useState<string[] | null>(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const byId = useMemo(() => Object.fromEntries(day.tasks.map((t) => [t.task_id, t])), [day.tasks])

  // матрица времён Google + индикатор пересчёта
  const [matrix, setMatrix] = useState<Map<string, number> | null>(null)
  const [travelLoading, setTravelLoading] = useState(false)

  // seed из чисел AI — показываем, пока не приедет матрица Google (по исходному порядку)
  const seed = useMemo(() => {
    const m = new Map<string, number>()
    day.tasks.forEach((t, i) => {
      if (i > 0) m.set(edgeKey(day.tasks[i - 1].task_id, t.task_id), t.drive_minutes_from_previous ?? 0)
    })
    if (day.tasks[0]) m.set(edgeKey('home', day.tasks[0].task_id), day.morning_commute_minutes ?? 0)
    return m
  }, [day])

  // строим матрицу Google один раз на день (набор адресов не зависит от порядка).
  // ВАЖНО: НЕ отменяем сам сетевой запрос на cleanup — он полезен (заполняет
  // глобальный кэш рёбер). При размонтировании просто игнорируем setState.
  useEffect(() => {
    let stale = false
    const points: MatrixPoint[] = [{ key: 'home', address: day.team_home_base }]
    for (const t of day.tasks) {
      points.push({ key: t.task_id, address: t.project_address })
      if (t.additional_stop?.address) {
        points.push({ key: t.additional_stop.address, address: t.additional_stop.address })
      }
    }
    const departureTime = day.date ? new Date(`${day.date}T09:00:00`) : null
    setTravelLoading(true)
    buildTravelMatrix(points, { departureTime })
      .then((m) => { if (!stale) setMatrix(m) })
      .catch(() => {})
      .finally(() => { if (!stale) setTravelLoading(false) })
    return () => { stale = true }
  }, [day])

  // чистый пересчёт дня для любого порядка
  const computeForOrder = useCallback((ord: string[]): TeamDay => {
    const ordered = ord.map((id) => byId[id]).filter(Boolean)
    const tasks: ScheduledTask[] = ordered.map((t) => {
      const ov = overrides[t.task_id]
      return {
        ...t,
        duration_minutes: durations[t.task_id] ?? t.duration_minutes,
        // ручной override travel: фиксируем значение, движок его не трогает
        ...(ov != null
          ? { travel_overridden: true, drive_minutes_from_previous: ov }
          : { travel_overridden: false }),
      }
    })
    const pointOf = (t: ScheduledTask): Point => ({ lat: null, lng: null, key: t.task_id })
    const travel = matrixProvider(matrix ?? new Map(), (f, t) => seed.get(edgeKey(f.key ?? '', t.key ?? '')) ?? 0)
    return recomputeTeamDay({
      team_id: day.team_id, team_name: day.team_name, date: day.date, timezone: day.timezone,
      home: { lat: null, lng: null, key: 'home' }, home_address: day.team_home_base, tasks, pointOf, travel,
    })
  }, [day, durations, byId, matrix, seed, overrides])

  const computed = useMemo(() => computeForOrder(order), [computeForOrder, order])
  const preview = useMemo(() => (pending ? computeForOrder(pending) : null), [computeForOrder, pending])

  // сообщаем актуальный (применённый) день наверх — для Approve
  useEffect(() => { onComputed?.(computed) }, [computed, onComputed])

  // якорь, который сменит позицию при предложенной перестановке
  const movedAnchor = useMemo(() => {
    if (!pending) return null
    return day.tasks.find((t) => t.anchor && order.indexOf(t.task_id) !== pending.indexOf(t.task_id)) ?? null
  }, [pending, order, day.tasks])

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = order.indexOf(String(active.id))
    const to = order.indexOf(String(over.id))
    setPending(arrayMove(order, from, to))
  }

  function applyPending() { if (pending) setOrder(pending); setPending(null) }

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-accent-50 px-3 py-2">
        <span className="font-semibold text-accent-700">👥 {day.team_name}</span>
        <Badge className="bg-gray-800 text-white">{computed.tasks.length} tasks</Badge>
        <Badge className="bg-blue-50 text-blue-700">Total: {minToHm(computed.total_working_minutes)}</Badge>
        <Badge className="bg-green-50 text-green-700">Duration: {minToHoursLabel(computed.tasks.reduce((s, t) => s + t.duration_minutes, 0))}</Badge>
        <Badge className="bg-purple-50 text-purple-700">Travel: {computed.summary?.total_travel_in_day_minutes}m</Badge>
        {computed.overtime && <StatusBadge tone="danger">overtime +{minToHm(Math.max(0, computed.total_working_minutes - 480))}</StatusBadge>}
        {travelLoading && (
          <span className="flex items-center gap-1 text-xs text-gray-400">
            <Loader2 size={12} className="animate-spin" /> travel…
          </span>
        )}
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={order} strategy={verticalListSortingStrategy}>
          <div className="space-y-2">
            {computed.tasks.map((t, i) => (
              <SortableTaskRow
                key={t.task_id} t={t} index={i}
                duration={durations[t.task_id]}
                onDuration={(v) => setDurations((d) => ({ ...d, [t.task_id]: v }))}
                overridden={overrides[t.task_id] != null}
                onTravelOverride={(v) => setOverrides((o) => {
                  if (v == null) { const { [t.task_id]: _, ...rest } = o; return rest }
                  return { ...o, [t.task_id]: v }
                })}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      <p className="mt-2 text-xs text-gray-400">Drag to reorder · change Duration — times recompute, anchors stay fixed.</p>

      <RecalcModal
        open={!!pending}
        loading={travelLoading}
        before={computed}
        after={preview}
        movedAnchor={movedAnchor}
        onCancel={() => setPending(null)}
        onApply={applyPending}
      />
    </Card>
  )
}

/* ---------------- Модалка подтверждения перестановки (diff) ---------------- */

function fmtDelta(min: number): { text: string; cls: string } {
  if (min === 0) return { text: '±0m', cls: 'text-gray-400' }
  const sign = min > 0 ? '+' : '−'
  // рост travel/total — хуже (красный), снижение — лучше (зелёный)
  return { text: `${sign}${Math.abs(min)}m`, cls: min > 0 ? 'text-red-600' : 'text-green-600' }
}

function RecalcModal({
  open, loading, before, after, movedAnchor, onCancel, onApply,
}: {
  open: boolean
  loading: boolean
  before: TeamDay
  after: TeamDay | null
  movedAnchor: ScheduledTask | null
  onCancel: () => void
  onApply: () => void
}) {
  const diff = useMemo(() => {
    if (!after) return null
    const beforeById = Object.fromEntries(before.tasks.map((t) => [t.task_id, t]))
    const rows = after.tasks.map((t) => {
      const b = beforeById[t.task_id]
      const changed = !b || b.start_time !== t.start_time || b.end_time !== t.end_time
      return { t, b, changed }
    })
    const dTravel = (after.summary?.total_travel_in_day_minutes ?? 0) - (before.summary?.total_travel_in_day_minutes ?? 0)
    const dTotal = after.total_working_minutes - before.total_working_minutes
    const beforeConf = new Set(before.tasks.filter((t) => t.conflict).map((t) => t.task_id))
    const afterConf = new Map(after.tasks.filter((t) => t.conflict).map((t) => [t.task_id, t]))
    const newConflicts = after.tasks.filter((t) => t.conflict && !beforeConf.has(t.task_id))
    const resolvedConflicts = before.tasks.filter((t) => t.conflict && !afterConf.has(t.task_id))
    return {
      rows, dTravel, dTotal, newConflicts, resolvedConflicts,
      overtimeChanged: before.overtime !== after.overtime,
      nowOvertime: after.overtime,
    }
  }, [before, after])

  const tEl = (hhmm: string) => minToAmPm(hhmmToMin(hhmm))
  const hasAnchorRisk = !!movedAnchor || (diff?.newConflicts.length ?? 0) > 0

  return (
    <Modal
      open={open}
      size="lg"
      title="Review schedule changes"
      subtitle="Reordering recomputes times. Review the result and confirm."
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant={hasAnchorRisk ? 'danger' : 'accent'} disabled={loading || !after} onClick={onApply}>
            {hasAnchorRisk ? 'Apply anyway' : 'Apply changes'}
          </Button>
        </>
      }
    >
      {loading || !diff ? (
        <div className="flex items-center justify-center gap-3 py-10 text-gray-500">
          <Loader2 size={18} className="animate-spin" />
          Recalculating travel times via Google…
        </div>
      ) : (
        <div className="space-y-4">
          {/* предупреждение про якорь */}
          {movedAnchor && (
            <div className="flex items-start gap-2 rounded-lg border border-accent-200 bg-accent-50 px-3 py-2 text-accent-700">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>
                Moving a task with a fixed <b>Exact time ({movedAnchor.anchor_time})</b>.
                Это может сломать якорь и вызвать конфликты.
              </span>
            </div>
          )}
          {/* новые конфликты */}
          {diff.newConflicts.map((t) => (
            <div key={t.task_id} className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>New conflict: <b>{t.description}</b> — can't reach the anchor in time (+{t.conflict?.overlap_min}m).</span>
            </div>
          ))}
          {/* снятые конфликты */}
          {diff.resolvedConflicts.map((t) => (
            <div key={t.task_id} className="flex items-start gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-green-700">
              <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
              <span>Conflict resolved: <b>{t.description}</b>.</span>
            </div>
          ))}

          {/* сводка по дню */}
          <div className="grid grid-cols-3 gap-3">
            <SummaryStat label="Δ Travel" delta={diff.dTravel} />
            <SummaryStat label="Δ Total" delta={diff.dTotal} />
            <div className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-gray-400">Overtime</div>
              <div className={cn('mt-0.5 text-sm font-semibold', diff.nowOvertime ? 'text-red-600' : 'text-green-600')}>
                {diff.nowOvertime ? 'Yes' : 'No'}{diff.overtimeChanged && ' (changed)'}
              </div>
            </div>
          </div>

          {/* было/стало по времени задач */}
          <div className="overflow-hidden rounded-lg border border-gray-100">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase tracking-wide text-gray-400">
                  <th className="px-3 py-2 text-left font-semibold">#</th>
                  <th className="px-3 py-2 text-left font-semibold">Task</th>
                  <th className="px-3 py-2 text-left font-semibold">Was</th>
                  <th className="px-3 py-2 text-left font-semibold">Now</th>
                </tr>
              </thead>
              <tbody>
                {diff.rows.map(({ t, b, changed }, i) => (
                  <tr key={t.task_id} className={cn('border-b border-gray-100 last:border-0', changed && 'bg-accent-50/40')}>
                    <td className="px-3 py-2 font-semibold text-accent-700">{i + 1}</td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-gray-900">{t.description}</div>
                      {t.anchor && <span className="text-xs text-accent-600">{t.anchor_time}</span>}
                    </td>
                    <td className="px-3 py-2 text-gray-400">
                      {b ? `${tEl(b.start_time)} – ${tEl(b.end_time)}` : '—'}
                    </td>
                    <td className={cn('px-3 py-2', changed ? 'font-semibold text-gray-900' : 'text-gray-500')}>
                      <span className="inline-flex items-center gap-1">
                        {changed && <ArrowRight size={12} className="text-accent-500" />}
                        {tEl(t.start_time)} – {tEl(t.end_time)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  )
}

function SummaryStat({ label, delta }: { label: string; delta: number }) {
  const f = fmtDelta(delta)
  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-400">{label}</div>
      <div className={cn('mt-0.5 text-sm font-semibold', f.cls)}>{f.text}</div>
    </div>
  )
}

/** Одна перетаскиваемая строка задачи. */
const SOURCE_LABEL: Record<TaskProv['source'], string> = {
  google: 'Google (with traffic)', ai: 'AI estimate', manual: 'manual', first: 'first task (0)',
}

/** Поповер «ⓘ»: travel было/стало + ручные перемещения. */
function TaskInfo({ prov }: { prov?: TaskProv }) {
  if (!prov) return null
  const delta = prov.curDrive - prov.aiDrive
  return (
    <div className="group relative shrink-0">
      <button type="button" className="text-gray-300 hover:text-blue-500" aria-label="info"><Info size={15} /></button>
      <div className="invisible absolute right-0 top-5 z-20 w-64 rounded-lg border border-gray-200 bg-white p-3 text-xs shadow-lg group-hover:visible">
        <div className="mb-1 font-semibold text-gray-700">Travel</div>
        {prov.source === 'first' ? (
          <div className="text-gray-500">First task of the day — travel not counted (0).</div>
        ) : (
          <div className="text-gray-600">
            AI: <b>{prov.aiDrive}m</b> → now: <b className="text-gray-900">{prov.curDrive}m</b>{' '}
            {delta !== 0 && <span className={delta > 0 ? 'text-red-600' : 'text-green-600'}>({delta > 0 ? '+' : '−'}{Math.abs(delta)}m)</span>}
            <div className="mt-0.5 text-gray-400">source: {SOURCE_LABEL[prov.source]}</div>
            {prov.departBasis && (
              <div className="text-gray-400">traffic basis: {prov.departBasis} (day start)</div>
            )}
          </div>
        )}
        {(prov.teamChanged || prov.orderChanged) && (
          <>
            <div className="mb-1 mt-2 font-semibold text-gray-700">Manual moves</div>
            {prov.teamChanged && <div className="text-gray-600">Team: <span className="text-gray-400">{prov.origTeam}</span> → <b>{prov.curTeam}</b></div>}
            {prov.orderChanged && <div className="text-gray-600">Order: <span className="text-gray-400">#{prov.origOrder}</span> → <b>#{prov.curOrder}</b></div>}
          </>
        )}
        {!prov.teamChanged && !prov.orderChanged && prov.source !== 'first' && (
          <div className="mt-2 text-gray-400">No manual moves.</div>
        )}
      </div>
    </div>
  )
}

function SortableTaskRow({
  t, index, duration, prov, onDuration, overridden, onTravelOverride,
}: {
  t: ScheduledTask
  index: number
  duration: number
  prov?: TaskProv
  onDuration: (v: number) => void
  overridden: boolean
  onTravelOverride: (v: number | null) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: t.task_id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }

  return (
    <div ref={setNodeRef} style={style}
      className={cn('rounded-lg border p-3', t.conflict ? 'border-red-300 bg-red-50' : 'border-gray-200', isDragging && 'ring-2 ring-accent-300')}>
      <div className="flex items-center gap-2 text-sm">
        <button {...attributes} {...listeners} className="cursor-grab text-gray-400 hover:text-gray-600" aria-label="drag">
          <GripVertical size={16} />
        </button>
        <span className="font-bold text-accent-600">{index + 1}</span>
        <Badge className="bg-accent-50 text-accent-700">Project task</Badge>
        <b className="text-gray-900">{t.description}</b>
        {t.anchor && <StatusBadge tone="danger">anchor</StatusBadge>}
        {(prov?.teamChanged || prov?.orderChanged) && <span className="text-[10px] font-medium text-blue-500">moved</span>}
        <div className="ml-auto"><TaskInfo prov={prov} /></div>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span className="text-accent-700">Exact time: {t.anchor ? t.anchor_time : '—'}</span>
        {index === 0 ? (
          <span className="text-gray-600">Travel: <b className="text-gray-900">0</b> min</span>
        ) : overridden ? (
          <span className="flex items-center gap-1 text-gray-600">Travel:
            <Input className="w-16 py-1" type="number" value={t.drive_minutes_from_previous}
              onChange={(e) => onTravelOverride(Math.max(0, Number(e.target.value)))} /> min
            <button type="button" title="Manual travel — click to revert to auto"
              className="text-accent-600 hover:text-accent-800" onClick={() => onTravelOverride(null)}>
              <Lock size={13} />
            </button>
          </span>
        ) : (
          <span className="flex items-center gap-1 text-gray-600">Travel:
            <b className="text-gray-900">{t.drive_minutes_from_previous}</b> min
            <button type="button" title="Override travel manually"
              className="text-gray-400 hover:text-accent-600" onClick={() => onTravelOverride(t.drive_minutes_from_previous)}>
              <LockOpen size={13} />
            </button>
          </span>
        )}
        <span className="text-gray-600">Time: <b className="text-gray-900">{minToAmPm(hhmmToMin(t.start_time))}</b> – {minToAmPm(hhmmToMin(t.end_time))}</span>
        <span className="flex items-center gap-1 text-gray-600">Duration:
          <Input className="w-20 py-1" type="number" value={duration}
            onChange={(e) => onDuration(Number(e.target.value))} /> min
        </span>
        {t.additional_stop && <Badge className="bg-gray-100 text-gray-600">+stop {t.additional_stop.when} ({t.additional_stop.duration_min}m)</Badge>}
        {t.conflict && <span className="font-medium text-red-600">⚠ can't reach anchor: +{t.conflict.overlap_min}m</span>}
      </div>
      <div className="mt-1 text-xs text-gray-500">{t.project_name} · {t.project_address}</div>
    </div>
  )
}

/* ---------------- Scheduled (реальные задачи, read-only) ---------------- */
function Scheduled() {
  const { data: tasks, isLoading } = useQuery({ queryKey: ['tasks', 'scheduled'], queryFn: () => fetchTasks('scheduled') })
  const days = useMemo(() => buildTeamDays(tasks ?? []), [tasks])
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const send = useMutation({
    mutationFn: () => sendToSlack(buildSlackPayload(days, newRequestId(), days[0]?.date ?? '')),
    onSuccess: () => { setSent(true); setError(null) },
    onError: (e: unknown) => setError(errMsg(e)),
  })
  if (isLoading) return <p className="text-gray-500">Loading…</p>
  if (!days.length) return <p className="text-gray-500">No approved tasks yet.</p>
  return (
    <div className="space-y-4">
      <Card className="flex items-center justify-between p-4">
        <span className="font-semibold text-gray-900">Scheduled</span>
        <div className="flex items-center gap-2">
          {error && <span className="text-sm text-red-600">⚠ {error}</span>}
          {sent && <span className="flex items-center gap-1 text-sm text-green-600"><CheckCircle2 size={14} /> Sent</span>}
          <Button variant="primary" disabled={send.isPending} onClick={() => send.mutate()}>
            {send.isPending ? 'Sending…' : 'Send tasks'}
          </Button>
          <Badge className="bg-gray-100 text-gray-600">{days.reduce((s, d) => s + d.tasks.length, 0)} tasks</Badge>
        </div>
      </Card>
      {days.map((day) => (
        <Card key={day.team_id} className="p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-accent-50 px-3 py-2">
            <span className="font-semibold text-accent-700">👥 {day.team_name}</span>
            <Badge className="bg-gray-800 text-white">{day.tasks.length} tasks</Badge>
            <Badge className="bg-blue-50 text-blue-700">Total: {minToHm(day.total_working_minutes)}</Badge>
            {day.total_working_minutes > 480 && (
              <StatusBadge tone="danger">overtime +{minToHm(day.total_working_minutes - 480)}</StatusBadge>
            )}
          </div>
          <div className="space-y-2">
            {day.tasks.map((t, i) => (
              <div key={t.task_id} className="flex items-center justify-between rounded-lg border border-gray-200 p-3 text-sm">
                <div>
                  <div><span className="font-bold text-accent-600">{i + 1}</span> <b className="text-gray-900">{t.description}</b></div>
                  <div className="text-gray-600">
                    {t.anchor && <span className="text-accent-700">Exact: {t.anchor_time} · </span>}
                    Time: {minToAmPm(hhmmToMin(t.start_time))} – {minToAmPm(hhmmToMin(t.end_time))} · {t.duration_minutes}m
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  )
}
