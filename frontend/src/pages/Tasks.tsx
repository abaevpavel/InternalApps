import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, arrayMove, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, SquarePen, Clock, Calendar, Users, Wrench, MapPin, Loader2 } from 'lucide-react'
import { Button, Card, Input, Badge, Modal } from '../components/ui'
import { cn } from '../lib/utils'
import {
  fetchTasks, fetchTeams, fetchSkills, fetchAvailability,
  fetchScheduleRun, updateTasksStatus, applyScheduleToTasks,
} from '../services/data'
import { sendToAi, sendToSlack } from '../services/n8n'
import { pollScheduleRun } from '../services/aiPoller'
import { buildTravelMatrix, matrixProvider, edgeKey, type MatrixPoint } from '../services/maps'
import { recomputeTeamDay, type Point } from '../domain/scheduling-engine'
import { minToAmPm, hhmmToMin, minToHm, minToHoursLabel } from '../lib/time'
import type { ScheduledTask, TeamDay, Task } from '../domain/types'

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
      date: ts[0].scheduled_date, timezone: 'America/New_York', team_home_base: '',
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
      <div className="mb-6 flex gap-1 rounded-lg bg-gray-100 p-1">
        {(['requested', 'proposed', 'scheduled'] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={cn('flex-1 rounded-md py-3 text-sm font-semibold capitalize', tab === t ? 'bg-white shadow' : 'text-gray-500')}>
            {t}
          </button>
        ))}
      </div>
      {tab === 'requested' && <Requested goProposed={() => setTab('proposed')} />}
      {tab === 'proposed' && <Proposed goScheduled={() => setTab('scheduled')} />}
      {tab === 'scheduled' && <Scheduled />}
    </div>
  )
}

/* ---------------- Requested ---------------- */
function priorityLabel(p: number): string {
  if (p <= 3) return 'High'
  if (p >= 7) return 'Low'
  return 'Medium'
}

function Requested({ goProposed }: { goProposed: () => void }) {
  const qc = useQueryClient()
  const { data: tasks } = useQuery({ queryKey: ['tasks', 'requested'], queryFn: () => fetchTasks('requested') })
  const [persistentPrompt, setPersistentPrompt] = useState('')
  const [oneTimePrompt, setOneTimePrompt] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Send to AI: отправить задачи планировщику → поллить результат → перевести в proposed.
  const send = useMutation({
    mutationFn: async (test: boolean) => {
      const list = tasks ?? []
      if (!list.length) throw new Error('Нет задач со статусом requested')
      const [teams, skills, unavailable] = await Promise.all([
        fetchTeams(), fetchSkills(), fetchAvailability(),
      ])
      const requestId = newRequestId()
      const date = list[0]?.scheduled_date ?? null
      await sendToAi({
        requestId, date, tasks: list, teams, unavailableTeams: unavailable, skills,
        persistentPrompt: persistentPrompt || undefined,
        oneTimePrompt: oneTimePrompt || undefined,
        test,
      })
      const run = await pollScheduleRun(requestId)
      if (run.status === 'error') throw new Error(run.error || 'AI вернул ошибку')
      // помечаем отправленные задачи как proposed
      await updateTasksStatus(list.map((t) => t.id), 'proposed')
      return run
    },
    onSuccess: () => {
      setError(null)
      qc.invalidateQueries({ queryKey: ['tasks'] })
      qc.invalidateQueries({ queryKey: ['scheduleRun'] })
      goProposed()
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  })

  const busy = send.isPending
  return (
    <div className="space-y-6">
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Generate Schedule</h2>
          <Badge className="bg-gray-100">{tasks?.length ?? 0} tasks</Badge>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">Persistent Prompt</label>
            <Input value={persistentPrompt} onChange={(e) => setPersistentPrompt(e.target.value)}
              placeholder="Постоянные указания планировщику" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">One-time Prompt</label>
            <Input value={oneTimePrompt} onChange={(e) => setOneTimePrompt(e.target.value)}
              placeholder="Разовое указание для этого запуска" />
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between">
          <span className="text-sm text-gray-500">
            {busy ? 'Отправка задач и ожидание AI…' : `${tasks?.length ?? 0} tasks will be analyzed`}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" className="border-orange-300 text-orange-600"
              disabled={busy || !tasks?.length} onClick={() => send.mutate(true)}>
              Test Send to AI
            </Button>
            <Button variant="blue" disabled={busy || !tasks?.length} onClick={() => send.mutate(false)}>
              {busy ? <span className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" /> Working…</span> : 'Send to AI'}
            </Button>
          </div>
        </div>
        {error && <p className="mt-2 text-sm text-red-600">⚠ {error}</p>}
      </Card>

      <div>
        <div className="mb-2 flex items-center gap-2">
          <Badge className="bg-blue-50 text-blue-700">Unassigned</Badge>
          <span className="text-sm text-gray-500">{tasks?.length ?? 0} tasks</span>
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          {tasks?.map((t) => <TaskCardCompact key={t.id} t={t} />)}
        </div>
      </div>
    </div>
  )
}

/** Компактная карточка задачи (Requested). */
function TaskCardCompact({ t }: { t: import('../domain/types').Task }) {
  const title = t.title ?? (t.description ?? '').split('\n')[0]
  const skillCount = t.required_skill_ids?.length ?? 0
  const durH = (t.estimated_duration_min ?? 0) / 60
  return (
    <Card className="p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{title}</span>
            <Badge className="shrink-0 bg-amber-50 text-amber-700">{t.task_type}</Badge>
          </div>
          <div className="truncate text-xs text-gray-500">
            {[t.project_name, t.task_address, t.project_manager ? `PM: ${t.project_manager}` : null].filter(Boolean).join(' · ')}
          </div>
        </div>
        <button className="shrink-0 text-gray-400 hover:text-gray-600" aria-label="edit"><SquarePen size={16} /></button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600">
        <Badge className="bg-gray-100">Priority: {priorityLabel(t.priority ?? 5)}</Badge>
        <span className="flex items-center gap-1"><Clock size={13} /> {durH.toFixed(1)}h</span>
        {t.exact_time && <span className="font-medium text-red-600">⚓ {t.exact_time}</span>}
        {t.scheduled_date && <span className="flex items-center gap-1"><Calendar size={13} /> {t.scheduled_date}</span>}
        <span className="flex items-center gap-1">
          <Users size={13} /> {t.assigned_team_name ?? (t.assigned_team_id ? 'assigned' : <span className="text-amber-600">N/A</span>)}
        </span>
        <span className="flex items-center gap-1">
          <Wrench size={13} /> {skillCount ? `${skillCount} skills` : <span className="text-amber-600">N/A</span>}
        </span>
        {t.additional_stop
          ? <span className="flex items-center gap-1"><MapPin size={13} /> +stop {t.additional_stop.when}</span>
          : <span className="flex items-center gap-1 text-amber-600"><MapPin size={13} /> no stop</span>}
      </div>
    </Card>
  )
}

/* ---------------- Proposed (результат AI-поллинга + движок) ---------------- */
function Proposed({ goScheduled }: { goScheduled: () => void }) {
  const qc = useQueryClient()
  const { data: run, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['scheduleRun'], queryFn: () => fetchScheduleRun(),
  })
  const days = useMemo<TeamDay[]>(() => run?.output_data?.schedule ?? [], [run])
  // отредактированные пользователем дни (drag/duration) — для Approve
  const editedRef = useRef<Record<string, TeamDay>>({})
  const [error, setError] = useState<string | null>(null)
  const [explainOpen, setExplainOpen] = useState(false)

  const approve = useMutation({
    mutationFn: async () => {
      const finalDays = days.map((d) => editedRef.current[d.team_id] ?? d)
      await applyScheduleToTasks(finalDays)
    },
    onSuccess: () => {
      setError(null)
      qc.invalidateQueries({ queryKey: ['tasks'] })
      goScheduled()
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  })

  if (isLoading) return <p className="text-gray-500">Loading…</p>
  if (!days.length) return <p className="text-gray-500">Нет готового расписания. Запустите Send to AI на вкладке Requested.</p>

  const total = days.reduce((s, d) => s + d.tasks.length, 0)
  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-2 p-4">
        <Badge className="bg-gray-100">{total} tasks</Badge>
        <Button variant="outline" className="text-blue-600" disabled={isFetching} onClick={() => refetch()}>
          {isFetching ? 'Refreshing…' : 'Fetch AI Data'}
        </Button>
        <Button variant="green" disabled={approve.isPending} onClick={() => approve.mutate()}>
          {approve.isPending ? 'Approving…' : 'Approve All'}
        </Button>
        <Button variant="outline" onClick={() => setExplainOpen(true)}>💬 Explain Yourself</Button>
        {error && <span className="text-sm text-red-600">⚠ {error}</span>}
      </Card>
      {days.map((day) => (
        <EditableTeamDay key={day.team_id} day={day}
          onComputed={(d) => { editedRef.current[day.team_id] = d }} />
      ))}

      <Modal open={explainOpen} title="AI comments" onClose={() => setExplainOpen(false)}
        footer={<Button variant="ghost" onClick={() => setExplainOpen(false)}>Close</Button>}>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs text-gray-600">
          {JSON.stringify({ comments_ai_1: run?.comments_ai_1, comments_ai_2: run?.comments_ai_2 }, null, 2)}
        </pre>
      </Modal>
    </div>
  )
}

/** Редактируемый день: drag-and-drop + Duration → движок пересчитывает, якорь держится. */
function EditableTeamDay({ day, onComputed }: { day: TeamDay; onComputed?: (d: TeamDay) => void }) {
  const [durations, setDurations] = useState<Record<string, number>>(
    () => Object.fromEntries(day.tasks.map((t) => [t.task_id, t.duration_minutes])),
  )
  const [order, setOrder] = useState<string[]>(() => day.tasks.map((t) => t.task_id))
  // отложенное перемещение якоря, ждущее подтверждения
  const [pendingMove, setPendingMove] = useState<{ next: string[]; anchorTime: string } | null>(null)

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

  // строим матрицу Google один раз на день (набор адресов не зависит от порядка)
  useEffect(() => {
    let aborted = false
    const ac = new AbortController()
    const points: MatrixPoint[] = [{ key: 'home', address: day.team_home_base }]
    for (const t of day.tasks) {
      points.push({ key: t.task_id, address: t.project_address })
      if (t.additional_stop?.address) {
        points.push({ key: t.additional_stop.address, address: t.additional_stop.address })
      }
    }
    // departureTime = день + 09:00 (учёт пробок, только если дата в будущем)
    const departureTime = day.date ? new Date(`${day.date}T09:00:00`) : null
    setTravelLoading(true)
    buildTravelMatrix(points, { departureTime, signal: ac.signal })
      .then((m) => { if (!aborted) setMatrix(m) })
      .catch(() => {})
      .finally(() => { if (!aborted) setTravelLoading(false) })
    return () => { aborted = true; ac.abort() }
  }, [day])

  const computed = useMemo(() => {
    const ordered = order.map((id) => byId[id]).filter(Boolean)
    const tasks: ScheduledTask[] = ordered.map((t) => ({
      ...t, duration_minutes: durations[t.task_id] ?? t.duration_minutes,
    }))
    const pointOf = (t: ScheduledTask): Point => ({ lat: null, lng: null, key: t.task_id })
    // матрица Google в приоритете, seed (числа AI) как фолбэк до её загрузки
    const travel = matrixProvider(matrix ?? new Map(), (f, t) => seed.get(edgeKey(f.key ?? '', t.key ?? '')) ?? 0)
    return recomputeTeamDay({
      team_id: day.team_id, team_name: day.team_name, date: day.date, timezone: day.timezone,
      home: { lat: null, lng: null, key: 'home' }, home_address: day.team_home_base, tasks, pointOf, travel,
    })
  }, [day, durations, order, byId, matrix, seed])

  // сообщаем актуальный (отредактированный) день наверх — для Approve
  useEffect(() => { onComputed?.(computed) }, [computed, onComputed])

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = order.indexOf(String(active.id))
    const to = order.indexOf(String(over.id))
    const next = arrayMove(order, from, to)
    // подтверждение нужно, если ЛЮБАЯ якорная задача сменила позицию —
    // как при перетаскивании самого якоря, так и при выталкивании его другой задачей
    const affectedAnchor = day.tasks.find(
      (t) => t.anchor && order.indexOf(t.task_id) !== next.indexOf(t.task_id),
    )
    if (affectedAnchor) {
      setPendingMove({ next, anchorTime: affectedAnchor.anchor_time })
    } else {
      setOrder(next)
    }
  }

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg bg-amber-50 px-3 py-2">
        <span className="font-semibold text-amber-700">👥 {day.team_name}</span>
        <Badge className="bg-gray-700 text-white">{computed.tasks.length} tasks</Badge>
        <Badge className="bg-blue-50 text-blue-700">Total: {minToHm(computed.total_working_minutes)}</Badge>
        <Badge className="bg-green-50 text-green-700">Duration: {minToHoursLabel(computed.tasks.reduce((s, t) => s + t.duration_minutes, 0))}</Badge>
        <Badge className="bg-purple-50 text-purple-700">Travel: {computed.summary?.total_travel_in_day_minutes}m</Badge>
        {computed.overtime && <Badge className="bg-red-100 text-red-700">overtime</Badge>}
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
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      <p className="mt-2 text-xs text-gray-400">Drag to reorder · change Duration — times recompute, anchors stay fixed.</p>

      <Modal
        open={!!pendingMove}
        title="Move anchored task?"
        onClose={() => setPendingMove(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingMove(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => { if (pendingMove) setOrder(pendingMove.next); setPendingMove(null) }}>
              Move anyway
            </Button>
          </>
        }
      >
        This change moves a task with a fixed <b>Exact time ({pendingMove?.anchorTime})</b>. It may
        break the anchor and cause scheduling conflicts. Are you sure you want to continue?
      </Modal>
    </Card>
  )
}

/** Одна перетаскиваемая строка задачи. */
function SortableTaskRow({
  t, index, duration, onDuration,
}: {
  t: ScheduledTask
  index: number
  duration: number
  onDuration: (v: number) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: t.task_id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }

  return (
    <div ref={setNodeRef} style={style}
      className={cn('rounded-lg border p-3', t.conflict ? 'border-red-300 bg-red-50' : 'border-gray-200', isDragging && 'ring-2 ring-blue-300')}>
      <div className="flex items-center gap-2 text-sm">
        <button {...attributes} {...listeners} className="cursor-grab text-gray-400 hover:text-gray-600" aria-label="drag">
          <GripVertical size={16} />
        </button>
        <span className="font-bold text-amber-600">{index + 1}</span>
        <Badge className="bg-amber-50 text-amber-700">Project task</Badge>
        <b>{t.description}</b>
        {t.anchor && <Badge className="bg-red-100 text-red-700">⚓ anchor</Badge>}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span className="text-red-600">Exact time: {t.anchor ? t.anchor_time : '—'}</span>
        <span>Travel: <b>{t.drive_minutes_from_previous}</b> min</span>
        <span>Time: <b>{minToAmPm(hhmmToMin(t.start_time))}</b> – {minToAmPm(hhmmToMin(t.end_time))}</span>
        <span className="flex items-center gap-1">Duration:
          <Input className="w-20 py-1" type="number" value={duration}
            onChange={(e) => onDuration(Number(e.target.value))} /> min
        </span>
        {t.additional_stop && <Badge className="bg-gray-100">+stop {t.additional_stop.when} ({t.additional_stop.duration_min}m)</Badge>}
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
    mutationFn: () => sendToSlack({ schedule: days }),
    onSuccess: () => { setSent(true); setError(null) },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  })
  if (isLoading) return <p className="text-gray-500">Loading…</p>
  if (!days.length) return <p className="text-gray-500">No approved tasks yet.</p>
  return (
    <div className="space-y-4">
      <Card className="flex items-center justify-between p-4">
        <span className="font-semibold">Scheduled</span>
        <div className="flex items-center gap-2">
          {error && <span className="text-sm text-red-600">⚠ {error}</span>}
          {sent && <span className="text-sm text-green-600">✓ Sent</span>}
          <Button variant="blue" disabled={send.isPending} onClick={() => send.mutate()}>
            {send.isPending ? 'Sending…' : 'Send tasks'}
          </Button>
          <Badge className="bg-gray-100">{days.reduce((s, d) => s + d.tasks.length, 0)} tasks</Badge>
        </div>
      </Card>
      {days.map((day) => (
        <Card key={day.team_id} className="p-4">
          <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg bg-amber-50 px-3 py-2">
            <span className="font-semibold text-amber-700">👥 {day.team_name}</span>
            <Badge className="bg-gray-700 text-white">{day.tasks.length} tasks</Badge>
            <Badge className="bg-blue-50 text-blue-700">Total: {minToHm(day.total_working_minutes)}</Badge>
          </div>
          <div className="space-y-2">
            {day.tasks.map((t, i) => (
              <div key={t.task_id} className="flex items-center justify-between rounded-lg border border-gray-200 p-3 text-sm">
                <div>
                  <div><span className="font-bold text-amber-600">{i + 1}</span> <b>{t.description}</b></div>
                  <div className="text-gray-600">
                    {t.anchor && <span className="text-red-600">Exact: {t.anchor_time} · </span>}
                    Time: {minToAmPm(hhmmToMin(t.start_time))} – {minToAmPm(hhmmToMin(t.end_time))} · {t.duration_minutes}m
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" className="py-1 text-xs">Status</Button>
                  <Button variant="outline" className="py-1 text-xs">Restore</Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  )
}
