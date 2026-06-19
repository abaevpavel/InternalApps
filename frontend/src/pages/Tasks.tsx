import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, arrayMove, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  GripVertical, SquarePen, Clock, Calendar, Users, Wrench, MapPin, Loader2,
  ArrowRight, AlertTriangle, CheckCircle2,
} from 'lucide-react'
import { Button, Card, Input, Badge, StatusBadge, Modal, Tabs } from '../components/ui'
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
      // материализуем AI-расписание в tasks (status=proposed): время, бригада,
      // порядок, travel. Источник Proposed дальше — реальные tasks, не сырой output.
      if (run.output_data?.schedule?.length) {
        await applyScheduleToTasks(run.output_data.schedule, 'proposed')
      } else {
        await updateTasksStatus(list.map((t) => t.id), 'proposed')
      }
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
          <h2 className="text-lg font-semibold text-gray-900">Generate Schedule</h2>
          <Badge className="bg-gray-100 text-gray-600">{tasks?.length ?? 0} tasks</Badge>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
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
        <div className="mt-4 flex items-center justify-between">
          <span className="text-sm text-gray-500">
            {busy ? 'Отправка задач и ожидание AI…' : `${tasks?.length ?? 0} tasks will be analyzed`}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" className="border-accent-200 text-accent-700"
              disabled={busy || !tasks?.length} onClick={() => send.mutate(true)}>
              Test Send to AI
            </Button>
            <Button variant="primary" disabled={busy || !tasks?.length} onClick={() => send.mutate(false)}>
              {busy ? <span className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" /> Working…</span> : 'Send to AI'}
            </Button>
          </div>
        </div>
        {error && <p className="mt-3 text-sm text-red-600">⚠ {error}</p>}
      </Card>

      <div>
        <div className="mb-3 flex items-center gap-2">
          <StatusBadge tone="info">Unassigned</StatusBadge>
          <span className="text-sm text-gray-500">{tasks?.length ?? 0} tasks</span>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {tasks?.map((t) => <TaskCardCompact key={t.id} t={t} />)}
        </div>
      </div>
    </div>
  )
}

/** Компактная карточка задачи (Requested). */
function TaskCardCompact({ t }: { t: Task }) {
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
        <button className="shrink-0 text-gray-400 hover:text-gray-600" aria-label="edit"><SquarePen size={16} /></button>
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
  const editedRef = useRef<Record<string, TeamDay>>({})
  const [error, setError] = useState<string | null>(null)
  const [explainOpen, setExplainOpen] = useState(false)

  const approve = useMutation({
    mutationFn: async () => {
      const finalDays = days.map((d) => editedRef.current[d.team_id] ?? d)
      await applyScheduleToTasks(finalDays, 'scheduled')
    },
    onSuccess: () => {
      setError(null)
      qc.invalidateQueries({ queryKey: ['tasks'] })
      goScheduled()
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  })

  if (isLoading) return <p className="text-gray-500">Loading…</p>
  if (!days.length) return <p className="text-gray-500">Нет задач со статусом proposed. Запустите Send to AI на вкладке Requested.</p>

  const total = days.reduce((s, d) => s + d.tasks.length, 0)
  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-2 p-4">
        <Badge className="bg-gray-100 text-gray-600">{total} tasks</Badge>
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

      <Modal open={explainOpen} title="AI comments" onClose={() => setExplainOpen(false)} size="lg"
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
    const tasks: ScheduledTask[] = ordered.map((t) => ({
      ...t, duration_minutes: durations[t.task_id] ?? t.duration_minutes,
    }))
    const pointOf = (t: ScheduledTask): Point => ({ lat: null, lng: null, key: t.task_id })
    const travel = matrixProvider(matrix ?? new Map(), (f, t) => seed.get(edgeKey(f.key ?? '', t.key ?? '')) ?? 0)
    return recomputeTeamDay({
      team_id: day.team_id, team_name: day.team_name, date: day.date, timezone: day.timezone,
      home: { lat: null, lng: null, key: 'home' }, home_address: day.team_home_base, tasks, pointOf, travel,
    })
  }, [day, durations, byId, matrix, seed])

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
        {computed.overtime && <StatusBadge tone="danger">overtime</StatusBadge>}
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
      subtitle="Перестановка пересчитывает времена. Проверьте результат и подтвердите."
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
                Перемещается задача с фиксированным <b>Exact time ({movedAnchor.anchor_time})</b>.
                Это может сломать якорь и вызвать конфликты.
              </span>
            </div>
          )}
          {/* новые конфликты */}
          {diff.newConflicts.map((t) => (
            <div key={t.task_id} className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>Новый конфликт: <b>{t.description}</b> — не успеваем к якорю (+{t.conflict?.overlap_min}m).</span>
            </div>
          ))}
          {/* снятые конфликты */}
          {diff.resolvedConflicts.map((t) => (
            <div key={t.task_id} className="flex items-start gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-green-700">
              <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
              <span>Конфликт снят: <b>{t.description}</b>.</span>
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
      className={cn('rounded-lg border p-3', t.conflict ? 'border-red-300 bg-red-50' : 'border-gray-200', isDragging && 'ring-2 ring-accent-300')}>
      <div className="flex items-center gap-2 text-sm">
        <button {...attributes} {...listeners} className="cursor-grab text-gray-400 hover:text-gray-600" aria-label="drag">
          <GripVertical size={16} />
        </button>
        <span className="font-bold text-accent-600">{index + 1}</span>
        <Badge className="bg-accent-50 text-accent-700">Project task</Badge>
        <b className="text-gray-900">{t.description}</b>
        {t.anchor && <StatusBadge tone="danger">anchor</StatusBadge>}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span className="text-accent-700">Exact time: {t.anchor ? t.anchor_time : '—'}</span>
        <span className="text-gray-600">Travel: <b className="text-gray-900">{t.drive_minutes_from_previous}</b> min</span>
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
    mutationFn: () => sendToSlack({ schedule: days }),
    onSuccess: () => { setSent(true); setError(null) },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
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
