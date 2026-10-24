import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { UsTimeInput } from '../../components/UsTimeInput'
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
  Anchor, GripVertical, SquarePen, Clock, Calendar, Users, Wrench, MapPin, Loader2,
  ArrowRight, AlertTriangle, CheckCircle2, Lock, LockOpen, Trash2, Info, RefreshCw, ChevronDown, Check,
} from 'lucide-react'
import { createPortal } from 'react-dom'
import { Button, Card, Input, Badge, StatusBadge, Modal, Tabs, Select, Textarea } from '../../components/task-planner-ui'
import { cn, errMsg } from '../../lib/utils'
import {
  fetchTasks, fetchTeams, fetchSkills, fetchAvailability,
  fetchScheduleRun, applyScheduleToTasks, pullScheduleIntoTasks, applyAiRun, moveTask,
  returnScheduledToProposed,
  updateTask, deleteTask, type UpdateTaskInput, fetchPeople, setTaskPm,
  markSentToAi, clearSentToAi, setTaskAnchor,
} from '../../services/task-planner/data'
import { sendToAi, sendToSlack, buildSlackPayload } from '../../services/task-planner/n8n'
import { executionBadge } from '../../services/task-planner/execution'
import { DEFAULT_PRIORITY, PRIORITY_OPTIONS, PRIORITY_RULE, priorityLabel, toPriority, type TaskPriority } from '../../domain/task-planner/priority'
import { resolveString } from '../../services/app-settings'
import { pollScheduleRun } from '../../services/task-planner/aiPoller'
import { setPendingRequestId, getPendingRequestId, clearPendingRequestId } from '../../services/task-planner/pendingRun'
import { buildTravelMatrix, matrixProvider, edgeKey, type MatrixPoint } from '../../services/task-planner/maps'
import { recomputeTeamDay, type Point } from '../../domain/task-planner/scheduling-engine'
import { minToAmPm, hhmmToMin, minToHm, minToHoursLabel } from '../../lib/task-planner-time'
import type { ScheduledTask, TeamDay, Task, TeamAvailability } from '../../domain/task-planner/types'
import { useTaskPlannerRoles } from './useTaskPlannerRole'
import { TaskDetailsModal, dayHeading, todayISO } from './MyTasks'
import { RangeFilter, useRangeFilter } from './RangeFilter'
import { MoveDateModal } from './MoveDateModal'
import { AiRunLogButton } from './AiRunLog'
import { ConfirmModal, useUndoableAction } from './UndoableAction'
import { planningDay, tasksForView } from '../../domain/task-planner/planning-side'
import { groupByDay, ownListOf, OWN_LISTS } from '../../domain/task-planner/own-side'
import { canDeleteTask, canEditTask, editableFields, isWaitingForAi } from '../../domain/task-planner/edit-rules'
import { shiftDay } from '../../domain/task-planner/own-side'
import type { AiWarning } from '../../domain/task-planner/ai-overlay'
import { availabilityKindLabel, availableTeamsOn, periodOn, tasksWithUnavailableTeam } from '../../domain/task-planner/availability'
import { dayCategory, DEFAULT_OVERTIME_LIMIT_MIN, NORMAL_DAY_MIN, overtimeLimitLabel } from '../../domain/task-planner/overtime'

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
    ai_warnings: t.ai_warnings ?? null,
  }
}

/** Группировка задач по бригадам → дни расписания. */
function buildTeamDays(tasks: Task[], limits?: Map<string, number>): TeamDay[] {
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
      // переработка — по лимиту бригады (BAS-1445)
      day_length_category: dayCategory(working, limits?.get(key)),
      overtime: working > NORMAL_DAY_MIN, tasks: st,
      summary: { total_tasks: st.length, total_travel_in_day_minutes: totalTravel },
    })
  }
  return days.sort((a, b) => a.team_name.localeCompare(b.team_name))
}

// Today и Closed — BAS-1435: сегодняшняя работа и закрытые PM задачи на стороне планирования.
type Tab = 'requested' | 'proposed' | 'scheduled' | 'today' | 'closed'
// BAS-1433: две вкладки. Planning — рабочий поток, всегда на завтра; Tracking — любая дата, просмотр.
type Side = 'planning' | 'tracking'

export function TasksPage() {
  const [side, setSide] = useState<Side>('planning')
  const [tab, setTab] = useState<Tab>('requested')
  return (
    <div>
      <div className="mb-3 flex gap-6 border-b border-gray-200 sm:mb-4">
        {([['planning', 'Planning', 'tomorrow'], ['tracking', 'Tracking', 'any date']] as const).map(([key, label, hint]) => (
          <button key={key} type="button" onClick={() => setSide(key)}
            className={cn('-mb-px border-b-2 px-1 pb-1.5 text-sm font-semibold transition sm:pb-2 sm:text-base',
              side === key ? 'border-accent-600 text-gray-900' : 'border-transparent text-gray-400 hover:text-gray-600')}>
            {label} <span className="hidden text-xs font-normal text-gray-400 sm:inline">· {hint}</span>
          </button>
        ))}
      </div>
      {side === 'tracking' && <Tracking />}
      {side === 'planning' && <>
      <Tabs<Tab>
        className="mb-3 sm:mb-6"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'requested', label: 'Requested' },
          { key: 'proposed', label: 'Proposed' },
          { key: 'scheduled', label: 'Scheduled' },
          { key: 'today', label: 'Today' },
          { key: 'closed', label: 'Closed' },
        ]}
      />
      {tab === 'requested' && <Requested goProposed={() => setTab('proposed')} />}
      {tab === 'proposed' && <Proposed goScheduled={() => setTab('scheduled')} />}
      {tab === 'scheduled' && <Scheduled goProposed={() => setTab('proposed')} />}
      {tab === 'today' && <Today />}
      {tab === 'closed' && <Closed />}
      </>}
    </div>
  )
}

/* ---------------- Requested ---------------- */
function priorityTone(p: TaskPriority): { label: string; tone: 'danger' | 'warning' | 'neutral' } {
  const tone = p === 'high' ? 'danger' : p === 'low' ? 'neutral' : 'warning'
  return { label: priorityLabel(p), tone }
}

function Requested({ goProposed }: { goProposed: () => void }) {
  const qc = useQueryClient()
  // Кнопки — по ролям модуля (BAS-1509): Send to AI — Schedule Manager, удаление — PM.
  const { can } = useTaskPlannerRoles()
  // Пока задачи ждут ответа AI (BAS-1514), список перечитывается: пометку снимает тот, кто отправил,
  // а видеть, что задачи снова доступны, должны все.
  const { data: tasks } = useQuery({
    queryKey: ['tasks', 'requested'], queryFn: () => fetchTasks('requested'),
    refetchInterval: (q) => ((q.state.data ?? []).some((t) => isWaitingForAi(t)) ? 5000 : false),
  })
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Task | null>(null)
  // BAS-1433: в AI уходит строго завтрашний батч (следующий рабочий день). Задачи других дат
  // ждут своего дня в Requested и видны в Tracking.
  const date = planningDay(todayISO())
  const dayTasks = useMemo(() => (tasks ?? []).filter((t) => t.scheduled_date === date), [tasks, date])
  const otherCount = (tasks ?? []).length - dayTasks.length
  // BAS-1436: задача с якорем перенесена на другой день — время проверяют здесь.
  const [anchorFor, setAnchorFor] = useState<Task | null>(null)
  const keepAnchor = useMutation({
    mutationFn: (id: string) => setTaskAnchor(id),
    onSuccess: () => { setError(null); void qc.invalidateQueries({ queryKey: ['tasks'] }) },
    onError: (e: unknown) => setError(errMsg(e)),
  })
  // BAS-1446: недоступные бригады в AI не уходят; задачи, назначенные им, надо исправить до отправки.
  const { data: periods } = useQuery({ queryKey: ['availability'], queryFn: fetchAvailability })
  const offTasks = useMemo(() => tasksWithUnavailableTeam(dayTasks, periods ?? []), [dayTasks, periods])
  const waiting = (tasks ?? []).some((t) => isWaitingForAi(t))
  // request_ID запроса, ответ которого задачи ждут или ждали (для Pull AI result у любого пользователя)
  const aiRequestId = (tasks ?? []).find((t) => t.ai_request_id)?.ai_request_id ?? null

  // Send to AI: отправить задачи планировщику → поллить результат → перевести в proposed.
  // URL вебхука берём из app_settings (Админка), не из хардкода.
  const send = useMutation({
    mutationFn: async () => {
      // Requested перечитываем из базы прямо перед отправкой, а не берём из кэша страницы:
      // иначе в AI уходят устаревшие даты/поля, если задачи поменяли после загрузки экрана
      // (так 13.10 16 задач ушли на 07.10 вместо 14.10).
      const list = (await fetchTasks('requested')).filter((t) => t.scheduled_date === date)
      if (!list.length) throw new Error(`No requested tasks for ${date}`)
      const [teams, skills, unavailable, webhookUrl, priorityRule] = await Promise.all([
        fetchTeams(), fetchSkills(), fetchAvailability(),
        resolveString('task-planner', 'planner_webhook', import.meta.env.VITE_N8N_PLANNER_WEBHOOK as string | undefined),
        // BAS-1434: правило «High раньше в дне» — в Persistent Prompt (сценарий n8n не меняется).
        resolveString('task-planner', 'planner_priority_rule', PRIORITY_RULE),
      ])
      // BAS-1446: задачу на бригаду в отпуске не отправляем — сначала поменять бригаду или день.
      const blocked = tasksWithUnavailableTeam(list, unavailable)
      if (blocked.length) {
        throw new Error(`${blocked.length} task(s) are assigned to a crew that is unavailable on ${date}: `
          + blocked.map((t) => `${t.title ?? t.description ?? 'task'} (${t.assigned_team_name ?? 'crew'})`).join('; ')
          + '. Change the crew or move the task to another day.')
      }
      const aiTeams = availableTeamsOn(teams, unavailable, date)
      const requestId = newRequestId()
      // запоминаем запрос ДО ожидания — если поллинг прервётся (таймаут/refresh),
      // результат можно будет подтянуть кнопкой по этому id.
      setPendingRequestId(requestId)
      // BAS-1514: задачи помечаются «отправлено в AI» — у всех они недоступны до ответа.
      // 0041: помечаются только Requested этого дня, снимок уходит в журнал разработчика.
      await markSentToAi(list.map((t) => t.id), requestId, date)
      void qc.invalidateQueries({ queryKey: ['tasks', 'requested'] })
      try {
        await sendToAi({
          requestId, date, tasks: list, teams: aiTeams, skills,
          webhookUrl: webhookUrl ?? undefined,
          persistentPrompt: priorityRule || PRIORITY_RULE,
        })
        const run = await pollScheduleRun(requestId)
        if (run.status === 'error') throw new Error(run.error || 'AI returned an error')
        if (!run.output_data?.schedule) throw new Error('AI returned no schedule (empty)')
        // TP-1.1: ответ ложится на те же задачи — только поля расписания, вопросы — пометками
        await applyAiRun(run)
        clearPendingRequestId() // результат применён — запрос больше не «висит»
        return run
      } catch (e) {
        // Таймаут: ответ ещё может прийти — пометка истечёт сама, результат подтянет Pull AI result.
        // Остальное (n8n не принял, AI вернул ошибку или пусто) — ответа не будет, снимаем сразу.
        if (!(e instanceof Error && e.message.startsWith('Timed out'))) {
          await clearSentToAi(requestId).catch(() => undefined)
        }
        throw e
      }
    },
    onSuccess: () => {
      setError(null)
      qc.invalidateQueries({ queryKey: ['tasks'] })
      qc.invalidateQueries({ queryKey: ['scheduleRun'] })
      goProposed()
    },
    // НЕ чистим pending на ошибке (таймаут и т.п.) — даём шанс подтянуть результат
    onError: (e: unknown) => {
      setError(errMsg(e))
      void qc.invalidateQueries({ queryKey: ['tasks', 'requested'] })
    },
  })

  // Восстановление: подтянуть результат «висящего» запроса (после таймаута/refresh).
  // id есть и в браузере отправившего, и в самих задачах — подтянуть может любой Schedule Manager.
  const pendingId = getPendingRequestId() ?? aiRequestId
  const recover = useMutation({
    mutationFn: async () => {
      const n = await pullScheduleIntoTasks(getPendingRequestId() ?? aiRequestId ?? undefined)
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


  // Удаление из Requested: «точно?» и 5 секунд на Undo — в базу уходит только потом (Vlad 20.10.2026).
  const [deleting, setDeleting] = useState<Task | null>(null)
  const undoable = useUndoableAction(
    (e) => setError(errMsg(e)),
    () => { setError(null); void qc.invalidateQueries({ queryKey: ['tasks'] }) },
  )

  const busy = send.isPending || recover.isPending || waiting
  return (
    <div className="space-y-3 sm:space-y-6">
      <Card className="p-3 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <h2 className="whitespace-nowrap text-base font-semibold text-gray-900 sm:text-lg">Generate Schedule</h2>
          <div className="flex items-center gap-2 whitespace-nowrap">
            <span className="flex items-center gap-1.5 text-sm font-medium text-gray-700">
              <Calendar size={14} /> {dayHeading(date, todayISO())}
            </span>
            <Badge className="bg-gray-100 text-gray-600">{dayTasks.length} tasks</Badge>
          </div>
        </div>
        {otherCount > 0 && (
          <p className="mt-2 text-xs text-gray-500">
            {otherCount} more requested tasks are on other days — they wait for their day. See them in Tracking.
          </p>
        )}
        <div className="mt-2 flex items-center justify-between gap-3 sm:mt-4">
          <span className="text-sm text-gray-500">
            {busy ? 'Sent to AI, waiting for the answer…' : `${dayTasks.length} tasks for tomorrow will be analyzed`}
          </span>
          {can('send_to_ai') && (
            <div className="flex shrink-0 gap-2 whitespace-nowrap">
              <Button variant="primary" disabled={busy || !dayTasks.length || offTasks.length > 0} onClick={() => send.mutate()}
                title={offTasks.length ? 'Some tasks are assigned to an unavailable crew' : undefined}>
                {busy ? <span className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" /> Working…</span> : 'Send to AI'}
              </Button>
            </div>
          )}
        </div>
        {error && <p className="mt-3 text-sm text-red-600">⚠ {error}</p>}
      </Card>

      {offTasks.length > 0 && (
        <Card className="flex items-start gap-3 border-amber-200 bg-amber-50 p-3 sm:p-4">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600" />
          <div className="text-xs text-amber-800 sm:text-sm">
            <p className="font-medium">
              {offTasks.length} task(s) are assigned to a crew that is unavailable on this day. Send to AI is blocked until they are fixed.
            </p>
            <p className="mt-1">Change the crew (Edit task) or move the task to another day.</p>
          </div>
        </Card>
      )}

      {pendingId && !send.isPending && !waiting && can('send_to_ai') && (
        <Card className="flex flex-wrap items-center gap-3 border-amber-200 bg-amber-50 p-3 sm:p-4">
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

      {/* Две группы: с бригадой, заданной вручную (AI её не меняет), и без бригады
          (бригаду подберёт AI). Раньше все задачи шли под одной плашкой «Unassigned». */}
      {([
        ['assigned', 'Assigned crew', 'success', dayTasks.filter((t) => t.assigned_team_id)],
        ['unassigned', 'Unassigned — AI picks the crew', 'info', dayTasks.filter((t) => !t.assigned_team_id)],
      ] as const).map(([key, label, tone, list]) =>
        list.length === 0 ? null : (
          <div key={key}>
            <div className="mb-2 flex items-center gap-2 sm:mb-3">
              <StatusBadge tone={tone}>{label}</StatusBadge>
              <span className="text-sm text-gray-500">{list.length} tasks</span>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:gap-3 md:grid-cols-2">
              {list.map((t) => (
                <TaskCardCompact key={t.id} t={t} waiting={isWaitingForAi(t)}
                  offLabel={offLabelFor(periods, t)}
                  onAnchorEdit={t.anchor && can('edit_task') && canEditTask(t) ? () => setAnchorFor(t) : undefined}
                  anchorCheck={t.anchor_moved_from && can('change_task_date') && !isWaitingForAi(t)
                    ? { onKeep: () => keepAnchor.mutate(t.id), onChange: () => setAnchorFor(t), busy: keepAnchor.isPending }
                    : undefined}
                  canChangePm={can('edit_task') && canEditTask(t)}
                  onEdit={can('edit_task') && canEditTask(t) ? () => setEditing(t) : undefined}
                  onDelete={can('delete_task') && canDeleteTask(t) ? () => setDeleting(t) : undefined} />
              ))}
            </div>
          </div>
        ),
      )}
      <TaskEditModal task={editing} onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); void qc.invalidateQueries({ queryKey: ['tasks'] }) }} />
      <AnchorTimeModal task={anchorFor} onClose={() => setAnchorFor(null)}
        onSaved={() => { setAnchorFor(null); void qc.invalidateQueries({ queryKey: ['tasks'] }) }} />
      <ConfirmModal open={!!deleting} title="Delete task?" confirmLabel="Delete" danger
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const t = deleting
          setDeleting(null)
          if (t) undoable.schedule(`“${(t.title ?? t.description).trim()}” deleted`, () => deleteTask(t.id))
        }}>
        Delete <b className="text-gray-900">{deleting?.title ?? deleting?.description}</b>? This cannot be reverted after the undo time.
      </ConfirmModal>
      {undoable.toast}
    </div>
  )
}

/** «Vacation until 2026-10-30» — бригада задачи недоступна в день задачи (BAS-1446). */
function offLabelFor(periods: TeamAvailability[] | undefined, t: { assigned_team_id?: string | null; scheduled_date?: string | null }): string | null {
  const p = periodOn(periods ?? [], t.assigned_team_id, t.scheduled_date)
  return p ? `${availabilityKindLabel(p.kind)} until ${p.end_date}` : null
}

/** Компактная карточка задачи (Requested). Просмотр, правка и смена PM (PM модуля), удаление. */
function TaskCardCompact({ t, waiting, offLabel, anchorCheck, onAnchorEdit, canChangePm, onEdit, onDelete }: {
  t: Task
  /** BAS-1436: поменять или снять время якоря — это правка задачи, только PM (матрица BAS-1509). */
  onAnchorEdit?: () => void
  /** BAS-1436: якорь перенесли с другого дня — проверить время (оставить или поменять). */
  anchorCheck?: { onKeep: () => void; onChange: () => void; busy: boolean }
  /** Бригада недоступна в день задачи (BAS-1446) — задача в AI не уйдёт. */
  offLabel?: string | null
  /** Отправлена в AI и ждёт ответа (BAS-1514): карточка приглушена, действия недоступны. */
  waiting: boolean
  canChangePm: boolean
  onEdit?: () => void
  onDelete?: () => void
}) {
  const title = t.title ?? (t.description ?? '').split('\n')[0]
  const skillCount = t.required_skill_ids?.length ?? 0
  const durH = (t.estimated_duration_min ?? 0) / 60
  const prio = priorityTone(t.priority)
  return (
    <Card className={cn('p-3 sm:p-4', waiting && 'pointer-events-none select-none opacity-50')} aria-disabled={waiting}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate font-semibold text-gray-900">{title}</span>
            <Badge className="shrink-0 bg-accent-50 text-accent-700">{t.task_type}</Badge>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-gray-500">
            <span className="min-w-0 truncate">{[t.project_name, t.task_address].filter(Boolean).join(' · ')}</span>
            {canChangePm
              ? <TaskPmPicker t={t} />
              : <TaskPmName t={t} />}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onEdit && (
            <button onClick={onEdit} className="text-gray-400 hover:text-accent-600" aria-label="edit" title="Edit task"><SquarePen size={16} /></button>
          )}
          {onDelete && (
            <button onClick={onDelete} className="text-gray-400 hover:text-red-600" aria-label="delete" title="Delete task"><Trash2 size={16} /></button>
          )}
        </div>
      </div>
      {waiting && <p className="mt-1 text-xs text-gray-500">Sent to AI, waiting…</p>}
      {t.anchor_moved_from && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-accent-200 bg-accent-50 px-2.5 py-1.5 text-xs text-accent-800">
          <Anchor size={13} className="shrink-0" />
          <span className="min-w-0 flex-1">
            Moved from {t.anchor_moved_from} with exact time <b>{t.exact_time || t.anchor_time ? minToAmPm(hhmmToMin(t.exact_time || t.anchor_time || '')) : '—'}</b> — check it fits this day.
          </span>
          {anchorCheck && (
            <span className="flex shrink-0 gap-1.5">
              <button type="button" disabled={anchorCheck.busy} onClick={(e) => { e.stopPropagation(); anchorCheck.onKeep() }}
                className="rounded-md border border-accent-300 bg-white px-2 py-0.5 font-medium hover:bg-accent-100 disabled:opacity-50">Keep</button>
              <button type="button" onClick={(e) => { e.stopPropagation(); anchorCheck.onChange() }}
                className="rounded-md bg-accent-600 px-2 py-0.5 font-medium text-white hover:bg-accent-700">Change time</button>
            </span>
          )}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600 sm:mt-3 sm:gap-y-1.5">
        <StatusBadge tone={prio.tone}>{prio.label}</StatusBadge>
        <span className="flex items-center gap-1"><Clock size={13} /> {durH.toFixed(1)}h</span>
        {t.exact_time && (onAnchorEdit
          ? <button type="button" onClick={onAnchorEdit} title="Change the exact time" className="rounded-full hover:ring-2 hover:ring-accent-300">
              <AnchorBadge time={t.exact_time} editable />
            </button>
          : <AnchorBadge time={t.exact_time} />)}
        {t.scheduled_date && <span className="flex items-center gap-1"><Calendar size={13} /> {t.scheduled_date}</span>}
        <span className="flex items-center gap-1">
          <Users size={13} /> {t.assigned_team_name ?? (t.assigned_team_id ? 'assigned' : <span className="text-accent-600">N/A</span>)}
          {offLabel && <span className="flex items-center gap-1 font-medium text-amber-700"><AlertTriangle size={12} /> {offLabel}</span>}
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

/**
 * PM задачи на карточке: клик — список людей из справочника, выбор — подтверждение.
 * Меняется и задача, и её копии в расписании (tp_set_task_pm); в историю модуля
 * изменение пишет триггер в базе.
 */
/**
 * Имя PM задачи. Источник правды — `pm_email` (он решает, в чьём My Tasks задача), имя
 * берётся по нему из списка людей; `project_manager` — запасной вариант: у части задач
 * имя не записано (PM не было в списке на момент создания).
 */
function usePmName(t: Task): string {
  const people = useQuery({ queryKey: ['tp-people'], queryFn: fetchPeople, staleTime: 5 * 60_000 })
  const email = t.pm_email?.toLowerCase()
  return (email && people.data?.find((p) => p.email === email)?.full_name) || t.project_manager || email || 'not set'
}

function TaskPmName({ t }: { t: Task }) {
  const name = usePmName(t)
  return <span className="shrink-0">· PM: {name}</span>
}

function TaskPmPicker({ t }: { t: Task }) {
  const qc = useQueryClient()
  const btn = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [query, setQuery] = useState('')
  const [next, setNext] = useState<{ email: string; name: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const open = !!pos
  const people = useQuery({ queryKey: ['tp-people'], queryFn: fetchPeople, staleTime: 5 * 60_000 })
  const pmName = usePmName(t)
  const save = useMutation({
    mutationFn: (email: string) => setTaskPm(t.id, email),
    onSuccess: () => {
      setNext(null)
      qc.invalidateQueries({ queryKey: ['tasks'] })
    },
    onError: (e: unknown) => setError(errMsg(e)),
  })
  const current = t.pm_email?.toLowerCase() ?? ''
  const q = query.trim().toLowerCase()
  const shown = (people.data ?? []).filter((p) => !q || p.full_name.toLowerCase().includes(q) || p.email.includes(q))

  // Список закрывается кликом мимо, Escape и прокруткой страницы.
  useEffect(() => {
    if (!open) return
    const close = () => { setPos(null); setQuery('') }
    const onDown = (e: MouseEvent) => {
      const el = e.target as Node
      if (!btn.current?.contains(el) && !menu.current?.contains(el)) close()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    const onScroll = (e: Event) => { if (!menu.current?.contains(e.target as Node)) close() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  function toggle() {
    if (open) { setPos(null); return }
    const r = btn.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 4, left: Math.min(r.left, window.innerWidth - 272) })
  }

  function pick(p: { email: string; full_name: string }) {
    setPos(null)
    setQuery('')
    if (p.email === current) return
    setError(null)
    setNext({ email: p.email, name: p.full_name })
  }

  return (
    <>
      <button
        ref={btn}
        type="button"
        title="Change PM"
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex shrink-0 items-center gap-0.5 rounded px-1 hover:bg-gray-100 hover:text-gray-800"
        onClick={toggle}
      >
        · PM: {pmName}
        <ChevronDown size={12} className={cn('transition', open && 'rotate-180')} />
      </button>

      {pos && createPortal(
        <div
          ref={menu}
          role="listbox"
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: 264 }}
          className="z-[60] flex max-h-72 flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg"
        >
          <div className="border-b border-gray-100 p-2">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search people…"
              className="w-full rounded-md border border-gray-200 px-2.5 py-1.5 text-sm outline-none focus:border-accent-500"
            />
          </div>
          <div className="overflow-auto py-1">
            {people.isLoading && <div className="px-3 py-2 text-sm text-gray-400">Loading…</div>}
            {people.error && <div className="px-3 py-2 text-sm text-red-600">{errMsg(people.error)}</div>}
            {!people.isLoading && !people.error && shown.length === 0 && (
              <div className="px-3 py-2 text-sm text-gray-400">Nothing found</div>
            )}
            {shown.map((p) => (
              <button
                key={p.email}
                type="button"
                role="option"
                aria-selected={p.email === current}
                onClick={() => pick(p)}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50',
                  p.email === current ? 'font-medium text-gray-900' : 'text-gray-700',
                )}
              >
                <Check size={14} className={cn('shrink-0', p.email === current ? 'text-accent-600' : 'invisible')} />
                <span className="truncate">{p.full_name}</span>
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}

      <Modal
        open={!!next}
        title="Change PM?"
        subtitle={t.title ?? t.description}
        size="sm"
        onClose={() => setNext(null)}
        footer={
          <>
            <Button onClick={() => setNext(null)}>Cancel</Button>
            <Button variant="green" disabled={save.isPending} onClick={() => next && save.mutate(next.email)}>
              {save.isPending ? 'Saving…' : 'Change PM'}
            </Button>
          </>
        }
      >
        {error && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">⚠ {error}</div>}
        <p>
          Are you sure you want to change the PM from <b className="text-gray-900">{pmName}</b> to{' '}
          <b className="text-gray-900">{next?.name}</b>?
        </p>
        <p className="mt-2 text-xs text-gray-500">
          The task moves to the new PM’s My Tasks, including its copy in the schedule. The change is recorded in the history.
        </p>
      </Modal>
    </>
  )
}

/**
 * Правка задачи PM-ом (BAS-1514): Requested, Proposed, Scheduled, пока бригада её не отметила.
 * Поля — по статусу (edit-rules): в Proposed и Scheduled без длительности, дата не правится нигде
 * (перенос — BAS-1437). Правка не меняет план: тайминги не пересчитываются, в Slack ничего не уходит.
 * Удаления здесь нет — оно только в Requested, иконкой на карточке.
 */
/** Пометка якоря в списках задач (BAS-1436): видно сразу, что у задачи точное время. */
function AnchorBadge({ time, editable = false }: { time?: string | null; editable?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-accent-50 px-2 py-0.5 text-xs font-semibold text-accent-700"
      title={editable ? undefined : 'Exact time: the task must start at this time'}>
      <Anchor size={12} /> Exact {time ? minToAmPm(hhmmToMin(time)) : ''}
      {editable && <SquarePen size={11} className="opacity-70" />}
    </span>
  )
}

/** Новое время якоря или снять якорь у задачи в Requested (BAS-1436). */
function AnchorTimeModal({ task, onClose, onSaved }: { task: Task | null; onClose: () => void; onSaved: () => void }) {
  const [time, setTime] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { if (task) { setTime(task.exact_time || task.anchor_time || ''); setError(null) } }, [task])
  const save = useMutation({
    mutationFn: (anchor: string) => setTaskAnchor(task!.id, anchor),
    onSuccess: onSaved,
    onError: (e: unknown) => setError(errMsg(e)),
  })
  return (
    <Modal open={!!task} title="Exact time" onClose={onClose}
      footer={<>
        <Button variant="ghost" disabled={save.isPending} onClick={() => save.mutate('')}>No exact time</Button>
        <Button variant="primary" disabled={save.isPending || !/^\d{2}:\d{2}$/.test(time)} onClick={() => save.mutate(time)}>
          {save.isPending ? 'Saving…' : 'Save time'}
        </Button>
      </>}>
      <p className="mb-3 text-sm text-gray-600">
        <b className="text-gray-900">{task?.title ?? task?.description}</b> on {task?.scheduled_date}.
        Set the time it must start, or remove the exact time and let AI place it.
      </p>
      <UsTimeInput value={time} onChange={setTime} />
      {error && <p className="mt-3 text-sm text-red-600">⚠ {error}</p>}
    </Modal>
  )
}

function TaskEditModal({ task, onClose, onSaved }: {
  task: Task | null
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<UpdateTaskInput>({})
  const [error, setError] = useState<string | null>(null)
  const fields = task ? editableFields(task) : []
  // BAS-1446: бригада заявки правится в Requested — чтобы заменить бригаду, которая в отпуске.
  const teamEditable = fields.includes('team')
  const { data: teams } = useQuery({ queryKey: ['teams'], queryFn: fetchTeams, enabled: teamEditable })
  const { data: periods } = useQuery({ queryKey: ['availability'], queryFn: fetchAvailability, enabled: teamEditable })
  // BAS-1436: точное время якоря правится в Requested; '' — якорь снят.
  const anchorEditable = task?.status === 'requested' && !!task.anchor
  const initialAnchor = task?.anchor ? (task.exact_time || task.anchor_time || '') : ''
  const [anchorTime, setAnchorTime] = useState('')
  useEffect(() => { setAnchorTime(initialAnchor) }, [task, initialAnchor])

  useEffect(() => {
    if (!task) return
    setForm({
      title: task.title ?? '',
      description: task.description ?? '',
      estimated_duration_min: task.estimated_duration_min,
      priority: task.priority,
      address: task.task_address,
      team_id: task.assigned_team_id ?? null,
    })
    setError(null)
  }, [task])
  const offFor = (teamId: string | null | undefined) =>
    offLabelFor(periods, { assigned_team_id: teamId ?? null, scheduled_date: task?.scheduled_date ?? null })
  const teamOff = teamEditable ? offFor(form.team_id) : null

  const save = useMutation({
    mutationFn: async () => {
      // пишем только поля, которые в этом статусе правятся
      const f = form
      if (anchorEditable && anchorTime !== initialAnchor) {
        if (anchorTime && !/^\d{2}:\d{2}$/.test(anchorTime)) throw new Error('Exact time must be HH:MM')
        await setTaskAnchor(task!.id, anchorTime)
      }
      return updateTask(task!.id, {
        title: f.title, description: f.description, priority: f.priority, address: f.address,
        ...(fields.includes('duration') ? { estimated_duration_min: f.estimated_duration_min } : {}),
        ...(teamEditable ? { team_id: f.team_id ?? null } : {}),
      })
    },
    onSuccess: onSaved,
    onError: (e: unknown) => setError(errMsg(e)),
  })
  const busy = save.isPending

  const set = (patch: Partial<UpdateTaskInput>) => setForm((f) => ({ ...f, ...patch }))

  return (
    <Modal
      open={!!task}
      size="lg"
      title="Edit task"
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {task && task.status !== 'requested' && (
          <p className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500">
            The schedule stays as it is: times are not recalculated and nothing is sent to Slack.
          </p>
        )}
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">Title</label>
          <Input value={form.title ?? ''} onChange={(e) => set({ title: e.target.value })} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">Description</label>
          {/* Многострочное: однострочный Input выкидывает переносы строк, и описание сохранилось бы слитно. */}
          <Textarea rows={4} value={form.description ?? ''} onChange={(e) => set({ description: e.target.value })} />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {fields.includes('duration') && (
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">Duration (min)</label>
              <Input type="number" value={form.estimated_duration_min ?? 0}
                onChange={(e) => set({ estimated_duration_min: Math.max(0, Number(e.target.value)) })} />
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">Priority</label>
            <Select value={form.priority ?? DEFAULT_PRIORITY} onChange={(e) => set({ priority: toPriority(e.target.value) })}>
              {PRIORITY_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </Select>
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">Address</label>
          <Input value={form.address ?? ''} onChange={(e) => set({ address: e.target.value })} />
        </div>
        {anchorEditable && (
          <div>
            <label className="mb-1 flex items-center gap-1 text-xs font-medium text-gray-500"><Anchor size={12} /> Exact time</label>
            <div className="flex items-center gap-2">
              <UsTimeInput value={anchorTime} onChange={setAnchorTime} />
              {anchorTime
                ? <button type="button" className="text-xs text-gray-500 hover:text-red-600" onClick={() => setAnchorTime('')}>Remove exact time</button>
                : <span className="text-xs text-gray-500">No exact time — AI picks the time</span>}
            </div>
          </div>
        )}
        {teamEditable && (
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">Assigned crew</label>
            <Select value={form.team_id ?? ''} onChange={(e) => set({ team_id: e.target.value || null })}>
              <option value="">No preference — AI picks the crew</option>
              {(teams ?? []).map((tm) => {
                const off = offFor(tm.id)
                // бригаду в отпуске на дату задачи выбрать нельзя (Vlad 22.10.2026)
                return <option key={tm.id} value={tm.id} disabled={!!off}>{off ? `${tm.name} (${off})` : tm.name}</option>
              })}
            </Select>
            {teamOff && (
              <p className="mt-1 flex items-center gap-1 text-xs text-amber-700">
                <AlertTriangle size={12} /> Unavailable on {task?.scheduled_date} ({teamOff}). The task will not be sent to AI with this crew.
              </p>
            )}
          </div>
        )}
        {error && <p className="text-sm text-red-600">⚠ {error}</p>}
      </div>
    </Modal>
  )
}

/* ---------------- Proposed (реальные tasks со status=proposed + движок) ---------------- */
function Proposed({ goScheduled }: { goScheduled: () => void }) {
  const qc = useQueryClient()
  // Раскладка и утверждение — Schedule Manager (BAS-1509); остальным доска только для просмотра.
  const { can } = useTaskPlannerRoles()
  const canArrange = can('rearrange_proposed')
  // источник — реальные tasks (status=proposed), материализованные из AI при Send to AI
  const { data: tasks, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['tasks', 'proposed'], queryFn: () => fetchTasks('proposed'),
  })
  // последний AI-прогон — только для модалки Explain Yourself (комментарии)
  const { data: run } = useQuery({ queryKey: ['scheduleRun'], queryFn: () => fetchScheduleRun() })
  // BAS-1433: Planning всегда на завтра — доска только завтрашнего дня.
  const date = planningDay(todayISO())
  const dayTasks = useMemo(() => (tasks ?? []).filter((t) => t.scheduled_date === date), [tasks, date])
  const limits = useOvertimeLimits()
  const days = useMemo<TeamDay[]>(() => buildTeamDays(dayTasks, limits), [dayTasks, limits])
  const warned = useMemo(() => dayTasks.filter((t) => t.ai_warnings?.length), [dayTasks])
  const [confirmApprove, setConfirmApprove] = useState(false)
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

  // «Delete all» убран (BAS-1514): задачи из Proposed не удаляются; плохой результат AI
  // заменяет повторный Send to AI.
  // Правка задачи PM-ом (BAS-1514): план не меняется.
  const [editing, setEditing] = useState<Task | null>(null)
  const byTaskId = useMemo(() => new Map((tasks ?? []).map((t) => [t.id, t])), [tasks])
  const onEdit = can('edit_task')
    ? (id: string) => { const t = byTaskId.get(id); if (t && canEditTask(t)) setEditing(t) }
    : undefined

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

  // BAS-1437: перенос задачи на другой день — та же строка уходит в Requested той даты,
  // доска пересобирается, тайминги остальных пересчитывает движок.
  const [moving, setMoving] = useState<Task | null>(null)
  // перенос уходит в базу через 5 секунд — до этого его можно отменить (Vlad 20.10.2026)
  const undoable = useUndoableAction(
    (e) => setError(errMsg(e)),
    () => { setError(null); void qc.invalidateQueries({ queryKey: ['tasks'] }) },
  )
  const onPush = can('change_task_date') && canArrange
    ? (id: string) => { const t = byTaskId.get(id); if (t) setMoving(t) }
    : undefined
  const doMove = (t: Task, to: string, anchor?: string) => {
    setMoving(null)
    undoable.schedule(`“${(t.title ?? t.description).trim()}” → ${to}, back to Requested`, () => moveTask(t.id, to, anchor))
  }

  const dayPicker = (
    <span className="flex items-center gap-1.5 text-sm font-medium text-gray-700">
      <Calendar size={14} /> {dayHeading(date, todayISO())}
    </span>
  )

  if (isLoading) return <p className="text-gray-500">Loading…</p>
  if (!days.length) return (
    <div className="space-y-3">
      <Card className="flex flex-wrap items-center gap-2 p-4">{dayPicker}</Card>
      <p className="text-gray-500">No proposed tasks for tomorrow. Run Send to AI on the Requested tab.</p>
      {can('send_to_ai') && (
        <Button variant="outline" className="text-blue-600" disabled={pull.isPending} onClick={() => pull.mutate()}>
          {pull.isPending ? 'Pulling…' : 'Pull AI result'}
        </Button>
      )}
      {error && <p className="text-sm text-red-600">⚠ {error}</p>}
    </div>
  )

  const total = days.reduce((s, d) => s + d.tasks.length, 0)
  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-2 p-4">
        {dayPicker}
        <Badge className="bg-gray-100 text-gray-600">{total} tasks</Badge>
        {warned.length > 0 && (
          <Badge className="bg-amber-50 text-amber-700"><AlertTriangle size={12} className="mr-1 inline" />{warned.length} with warnings</Badge>
        )}
        <Button variant="outline" className="text-blue-600" disabled={isFetching} onClick={() => refetch()}>
          {isFetching ? 'Refreshing…' : 'Fetch AI Data'}
        </Button>
        {can('send_to_ai') && (
          <Button variant="outline" className="text-blue-600" disabled={pull.isPending} onClick={() => pull.mutate()}>
            {pull.isPending ? 'Pulling…' : 'Pull AI result'}
          </Button>
        )}
        {canArrange && (
          <Button variant="outline" className="text-blue-600" disabled={save.isPending}
            onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : saved ? '✓ Saved' : 'Save changes'}
          </Button>
        )}
        {can('approve_schedule') && (
          <Button variant="green" disabled={approve.isPending}
            onClick={() => (warned.length ? setConfirmApprove(true) : approve.mutate())}>
            {approve.isPending ? 'Approving…' : 'Approve All'}
          </Button>
        )}
        <Button variant="outline" onClick={() => setExplainOpen(true)}>💬 Explain Yourself</Button>
        <AiRunLogButton />
        {error && <span className="text-sm text-red-600">⚠ {error}</span>}
      </Card>
      <EditableBoard days={days} readOnly={!canArrange} onEdit={onEdit} onPush={onPush} onComputed={(d) => { editedRef.current = d }} />

      <Modal open={confirmApprove} title="Approve with warnings?" onClose={() => setConfirmApprove(false)}
        footer={<>
          <Button variant="ghost" onClick={() => setConfirmApprove(false)}>Cancel</Button>
          <Button variant="green" disabled={approve.isPending}
            onClick={() => { setConfirmApprove(false); approve.mutate() }}>OK, approve</Button>
        </>}>
        <p className="mb-2 text-sm text-gray-600">These tasks have warnings after the AI answer. Approve the schedule anyway?</p>
        <ul className="max-h-72 space-y-2 overflow-auto text-sm">
          {warned.map((t) => (
            <li key={t.id} className="rounded-md bg-amber-50 px-3 py-2">
              <b className="text-gray-900">{t.title ?? t.description}</b>
              <ul className="mt-0.5 list-disc pl-5 text-amber-800">{(t.ai_warnings ?? []).map((w, i) => <li key={i}>{w.message}</li>)}</ul>
            </li>
          ))}
        </ul>
      </Modal>

      <MoveDateModal task={moving} pending={false} onClose={() => setMoving(null)}
        onMove={(to, anchor) => moving && doMove(moving, to, anchor)} />
      {undoable.toast}
      <TaskEditModal task={editing} onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); void qc.invalidateQueries({ queryKey: ['tasks'] }) }} />

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

function EditableBoard({ days, readOnly = false, onEdit, onPush, onComputed }: {
  days: TeamDay[]
  /** Перенос на другой день (BAS-1437): кнопка Push открывает выбор даты. */
  onPush?: (taskId: string) => void
  /** Без права раскладки (BAS-1509): перетаскивание выключено. */
  readOnly?: boolean
  /** Правка полей задачи PM-ом (BAS-1514); без права — нет кнопки. */
  onEdit?: (taskId: string) => void
  onComputed?: (computed: TeamDay[]) => void
}) {
  const limits = useOvertimeLimits()
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
      overtime_limit_min: limits.get(tid),
    })
  }, [cols, byId, durations, overrides, matrices, seeds, meta, limits])

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

  const pointer = useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  const sensors = useSensors(...(readOnly ? [] : [pointer]))

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
            onEdit={onEdit}
            onPush={onPush}
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
  day, ids, durations, overrides, provByTask, onEdit, onPush, onDuration, onOverride,
}: {
  day: TeamDay
  ids: string[]
  durations: Record<string, number>
  overrides: Record<string, number>
  provByTask: Map<string, TaskProv>
  onEdit?: (taskId: string) => void
  onPush?: (taskId: string) => void
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
        <OvertimeBadge teamId={day.team_id} totalMin={day.total_working_minutes} />
      </div>

      <div ref={setNodeRef} className={cn('min-h-[48px] rounded-lg', isOver && 'bg-accent-50/60 ring-1 ring-accent-200')}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <div className="space-y-2">
            {day.tasks.map((t, i) => (
              <SortableTaskRow
                key={t.task_id} t={t} index={i}
                duration={durations[t.task_id] ?? t.duration_minutes}
                prov={provByTask.get(t.task_id)}
                onEdit={onEdit ? () => onEdit(t.task_id) : undefined}
                onPush={onPush ? () => onPush(t.task_id) : undefined}
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
  const limits = useOvertimeLimits()
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
      overtime_limit_min: limits.get(day.team_id),
    })
  }, [day, durations, byId, matrix, seed, overrides, limits])

  const computed = useMemo(() => computeForOrder(order), [computeForOrder, order])
  const preview = useMemo(() => (pending ? computeForOrder(pending) : null), [computeForOrder, pending])

  // сообщаем актуальный (применённый) день наверх — для Approve
  useEffect(() => { onComputed?.(computed) }, [computed, onComputed])

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
        <OvertimeBadge teamId={day.team_id} totalMin={computed.total_working_minutes} />
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
  open, loading, before, after, onCancel, onApply,
}: {
  open: boolean
  loading: boolean
  before: TeamDay
  after: TeamDay | null
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
  // BAS-1436: перестановка якоря больше не предупреждается — якорь двигают как любую задачу.
  // Остаётся только реальный конфликт: бригада не успевает к времени якоря.
  const hasAnchorRisk = (diff?.newConflicts.length ?? 0) > 0

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
          <div className="overflow-x-auto rounded-lg border border-gray-100">
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
                    <td className="whitespace-nowrap px-3 py-2 text-gray-400">
                      {b ? `${tEl(b.start_time)} – ${tEl(b.end_time)}` : '—'}
                    </td>
                    <td className={cn('whitespace-nowrap px-3 py-2', changed ? 'font-semibold text-gray-900' : 'text-gray-500')}>
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
      <div className="invisible absolute right-0 top-5 z-20 w-64 rounded-lg border border-gray-200 bg-white p-3 text-xs shadow-lg group-focus-within:visible group-hover:visible">
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

/** Оранжевый треугольник: вопросы к задаче после ответа AI, подсказка по наведению (0041). */
function AiWarningMark({ warnings }: { warnings: AiWarning[] }) {
  return (
    <span className="group relative inline-flex items-center" tabIndex={0} aria-label={`${warnings.length} warnings`}>
      <AlertTriangle size={16} className="text-orange-500" />
      <span className="pointer-events-none absolute left-1/2 top-full z-30 mt-1 hidden w-72 -translate-x-1/2 rounded-md border border-orange-200 bg-white p-2 text-xs text-gray-700 shadow-lg group-hover:block group-focus:block">
        <span className="mb-1 block font-semibold text-orange-700">Check this task</span>
        {warnings.map((w, i) => <span key={i} className="block">• {w.message}</span>)}
      </span>
    </span>
  )
}

function SortableTaskRow({
  t, index, duration, prov, onEdit, onPush, onDuration, overridden, onTravelOverride,
}: {
  t: ScheduledTask
  index: number
  duration: number
  prov?: TaskProv
  onEdit?: () => void
  onPush?: () => void
  onDuration: (v: number) => void
  overridden: boolean
  onTravelOverride: (v: number | null) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: t.task_id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }

  return (
    <div ref={setNodeRef} style={style}
      className={cn('rounded-lg border p-3', t.conflict ? 'border-red-300 bg-red-50' : 'border-gray-200', isDragging && 'ring-2 ring-accent-300')}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button {...attributes} {...listeners} className="cursor-grab text-gray-400 hover:text-gray-600" aria-label="drag">
          <GripVertical size={16} />
        </button>
        <span className="font-bold text-accent-600">{index + 1}</span>
        <Badge className="bg-accent-50 text-accent-700">Project task</Badge>
        <b className="text-gray-900">{t.description}</b>
        {t.anchor && <StatusBadge tone="danger">anchor</StatusBadge>}
        {t.ai_warnings?.length ? <AiWarningMark warnings={t.ai_warnings} /> : null}
        {(prov?.teamChanged || prov?.orderChanged) && <span className="text-[10px] font-medium text-blue-500">moved</span>}
        <div className="ml-auto flex items-center gap-2">
          {onPush && (
            <button type="button" onClick={onPush}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-gray-500 hover:bg-gray-100 hover:text-accent-700"
              title="Move the task to another day (back to Requested)">
              <Calendar size={13} /> Push
            </button>
          )}
          {onEdit && (
            <button type="button" onClick={onEdit} className="text-gray-400 hover:text-accent-600" aria-label="edit" title="Edit task">
              <SquarePen size={15} />
            </button>
          )}
          <TaskInfo prov={prov} />
        </div>
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

/* ---------------- Scheduled (утверждённое расписание на завтра, read-only) ---------------- */
function Scheduled({ goProposed }: { goProposed: () => void }) {
  const qc = useQueryClient()
  // Send Tasks (рассылка в Slack) и Back to Proposed — Schedule Manager (BAS-1509).
  const { can } = useTaskPlannerRoles()
  // BAS-1435: Planning всегда на завтра (BAS-1433). Сегодняшние задачи — во вкладке Today,
  // закрытые PM — в Closed, другие даты — в Tracking.
  const today = todayISO()
  const day = planningDay(today)
  const { data, isLoading } = useQuery({
    queryKey: ['tasks', 'scheduled', day],
    queryFn: () => fetchTasks('scheduled', { date: day }),
  })
  const tasks = useMemo(() => tasksForView(data ?? [], 'scheduled', today), [data, today])
  const limits = useOvertimeLimits()
  const days = useMemo(() => buildTeamDays(tasks, limits), [tasks, limits])
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks])
  const [openTask, setOpenTask] = useState<Task | null>(null)
  // Правка PM-ом (BAS-1514): план не меняется, в Slack повторно не уходит.
  const [editing, setEditing] = useState<Task | null>(null)
  const canEdit = (t?: Task) => !!t && can('edit_task') && canEditTask(t)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const send = useMutation({
    // Дата рассылки — день Planning, а не дата первой бригады.
    mutationFn: () => sendToSlack(buildSlackPayload(days, newRequestId(), day)),
    onSuccess: () => { setSent(true); setError(null) },
    onError: (e: unknown) => setError(errMsg(e)),
  })
  // Откат утверждения: задачи дня, которые бригада ещё не трогала, — обратно в Proposed.
  const backCount = tasks.filter((t) => t.execution_status === 'pending').length
  const back = useMutation({
    mutationFn: () => returnScheduledToProposed(day),
    onSuccess: () => {
      setError(null)
      void qc.invalidateQueries({ queryKey: ['tasks'] })
      goProposed()
    },
    onError: (e: unknown) => setError(errMsg(e)),
  })
  if (isLoading) return <p className="text-gray-500">Loading…</p>
  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center justify-between gap-2 p-4">
        <span className="font-semibold text-gray-900">Scheduled · {dayHeading(day, today)}</span>
        <div className="flex flex-wrap items-center gap-2">
          {error && <span className="text-sm text-red-600">⚠ {error}</span>}
          {sent && <span className="flex items-center gap-1 text-sm text-green-600"><CheckCircle2 size={14} /> Sent</span>}
          {can('approve_schedule') && backCount > 0 && (
            <Button variant="outline" disabled={back.isPending}
              onClick={() => { if (confirm(`Move all ${backCount} tasks of ${day} back to Proposed?`)) back.mutate() }}>
              {back.isPending ? 'Moving…' : 'Back to Proposed'}
            </Button>
          )}
          {can('send_tasks') && days.length > 0 && (
            <Button variant="primary" disabled={send.isPending} onClick={() => send.mutate()}>
              {send.isPending ? 'Sending…' : 'Send tasks'}
            </Button>
          )}
          <Badge className="bg-gray-100 text-gray-600">{tasks.length} tasks</Badge>
        </div>
      </Card>
      {!days.length && <p className="text-gray-500">No approved tasks for tomorrow yet.</p>}
      {days.map((d) => (
        <Card key={d.team_id} className="p-4">
          <TeamDayHeader day={d} />
          <div className="space-y-2">
            {d.tasks.map((t, i) => {
              const full = byId.get(t.task_id)
              return (
                <div key={t.task_id} className="flex items-center gap-2 rounded-lg border border-gray-200 hover:bg-gray-50">
                  <button
                    type="button"
                    onClick={() => { if (full) setOpenTask(full) }}
                    className="min-w-0 flex-1 p-3 text-left text-sm"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-bold text-accent-600">{i + 1}</span> <b className="text-gray-900">{t.description}</b>
                      {t.anchor && <AnchorBadge time={t.anchor_time} />}
                    </div>
                    <div className="text-gray-600">
                      Time: {minToAmPm(hhmmToMin(t.start_time))} – {minToAmPm(hhmmToMin(t.end_time))} · {t.duration_minutes}m
                    </div>
                  </button>
                  {canEdit(full) && <EditIconButton onClick={() => setEditing(full!)} />}
                </div>
              )
            })}
          </div>
        </Card>
      ))}
      {openTask && <ReadOnlyTask task={openTask} onClose={() => setOpenTask(null)} />}
      <TaskEditModal task={editing} onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); void qc.invalidateQueries({ queryKey: ['tasks'] }) }} />
    </div>
  )
}

function TeamDayHeader({ day }: { day: TeamDay }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-accent-50 px-3 py-2">
      <span className="font-semibold text-accent-700">👥 {day.team_name}</span>
      <Badge className="bg-gray-800 text-white">{day.tasks.length} tasks</Badge>
      <Badge className="bg-blue-50 text-blue-700">Total: {minToHm(day.total_working_minutes)}</Badge>
      <OvertimeBadge teamId={day.team_id} totalMin={day.total_working_minutes} />
    </div>
  )
}

/** Кнопка правки задачи в строке списка (BAS-1514). */
function EditIconButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="shrink-0 px-3 text-gray-400 hover:text-accent-600" aria-label="edit" title="Edit task">
      <SquarePen size={16} />
    </button>
  )
}

/** Карточка задачи только на чтение: история, комментарии, фото — без действий исполнения и проверки. */
function ReadOnlyTask({ task, onClose }: { task: Task; onClose: () => void }) {
  return <TaskDetailsModal task={task} canAct={false} canReview={false} onClose={onClose} onCloseTask={() => undefined} />
}

const OWN_LABEL = Object.fromEntries(OWN_LISTS.map((l) => [l.key, l.label])) as Record<string, string>

/** Список задач по бригадам: строка — время, задача, проект и бейдж статуса; клик — карточка. */
function TeamTaskList({ tasks, badge, onOpen, onEdit, onPush }: {
  tasks: Task[]
  badge: (t: Task) => { label: string; tone: 'neutral' | 'warning' | 'success' | 'danger' }
  onOpen: (t: Task) => void
  /** Правка (BAS-1514); кнопка только у задач, которые можно править. */
  onEdit?: (t: Task) => void
  /** Перенос на другой день (BAS-1437); null — у этой задачи кнопки нет. */
  onPush?: (t: Task) => (() => void) | null
}) {
  const limits = useOvertimeLimits()
  const days = useMemo(() => buildTeamDays(tasks, limits), [tasks, limits])
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks])
  return (
    <div className="space-y-3">
      {days.map((d) => (
        <Card key={d.team_id} className="p-4">
          <TeamDayHeader day={d} />
          <div className="space-y-2">
            {d.tasks.map((st, i) => {
              const t = byId.get(st.task_id)!
              const b = badge(t)
              return (
                <div key={st.task_id} className="flex items-center rounded-lg border border-gray-200 hover:bg-gray-50">
                <button
                  type="button"
                  onClick={() => onOpen(t)}
                  className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-2 p-3 text-left text-sm"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-bold text-accent-600">{i + 1}</span> <b className="text-gray-900">{st.description}</b>
                      {st.anchor && <AnchorBadge time={st.anchor_time} />}
                    </div>
                    <div className="text-gray-600">
                      {st.start_time && <>Time: {minToAmPm(hhmmToMin(st.start_time))} – {minToAmPm(hhmmToMin(st.end_time))} · </>}
                      {st.duration_minutes}m{st.project_name ? ` · ${st.project_name}` : ''}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <StatusBadge tone={b.tone}>{b.label}</StatusBadge>
                    {t.execution_status === 'closed' && t.closed_at && (
                      <span className="text-xs text-gray-500">
                        Closed {new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(t.closed_at))}
                      </span>
                    )}
                  </div>
                </button>
                {onEdit && canEditTask(t) && <EditIconButton onClick={() => onEdit(t)} />}
                {(() => {
                  const push = onPush?.(t)
                  return push ? (
                    <button type="button" onClick={push} title="Push to another day" aria-label="Push to another day"
                      className="mr-2 flex shrink-0 items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-white">
                      <Calendar size={13} /> Push
                    </button>
                  ) : null
                })()}
                </div>
              )
            })}
          </div>
        </Card>
      ))}
    </div>
  )
}

/* ---------------- Tracking (BAS-1433) ---------------- */
/**
 * Все задачи всех PM на выбранную дату в тех же колонках, что и Planning. Только просмотр.
 *
 * ВРЕМЕННОЕ РЕШЕНИЕ до ответа клиента (Vlad 22.10.2026). В BAS 1433 «Proposed and Scheduled
 * exist only for tomorrow… never populated» спорит с «see what was or will be scheduled for a
 * given date», а случай «Proposed не утвердили до наступления дня» не описан нигде. Пока:
 *  - Tracking показывает все статусы на выбранную дату, серых вкладок нет;
 *  - Proposed с датой раньше завтрашней — «Not approved», Schedule Manager переносит его
 *    в Requested на другой день (как Push в Proposed, BAS-1437);
 *  - Scheduled прошлых дней — со статусом выполнения (Uncompleted / Completed / Closed).
 */
function Tracking() {
  const qc = useQueryClient()
  const { can } = useTaskPlannerRoles()
  const today = todayISO()
  const tomorrow = planningDay(today)
  const [date, setDate] = useState(tomorrow)
  const { data, isLoading, error } = useQuery({
    queryKey: ['tasks', 'tracking', date],
    queryFn: () => fetchTasks(undefined, { date }),
  })
  const isTomorrow = date === tomorrow
  // день уже наступил или прошёл, а утвердить уже некому — Proposed «завис»
  const isStale = date < tomorrow
  const by = (st: Task['status']) => (data ?? []).filter((t) => t.status === st)
  const requested = by('requested')
  const proposed = by('proposed')
  const scheduled = by('scheduled')
  const [openTask, setOpenTask] = useState<Task | null>(null)
  // те же вкладки, что в Planning: каждая — на всю ширину
  const [tab, setTab] = useState<'requested' | 'proposed' | 'scheduled'>('requested')
  const count = (n: number) => (
    <span className="ml-1.5 rounded-full bg-gray-200 px-1.5 text-xs text-gray-600">{n}</span>
  )

  // Перенос зависшего Proposed: та же строка уходит в Requested выбранного дня, 5 секунд на Undo.
  const [moveError, setMoveError] = useState<string | null>(null)
  const [moving, setMoving] = useState<Task | null>(null)
  const undoable = useUndoableAction(
    (e) => setMoveError(errMsg(e)),
    () => { setMoveError(null); void qc.invalidateQueries({ queryKey: ['tasks'] }) },
  )
  // Копии старого режима тестов перенести нельзя (база не даст) — у них кнопки нет.
  const onPush = isStale && can('rearrange_proposed')
    ? (t: Task) => (t.request_task_id ? null : () => setMoving(t))
    : undefined
  const doMove = (t: Task, to: string, anchor?: string) => {
    setMoving(null)
    undoable.schedule(`“${(t.title ?? t.description).trim()}” → ${to}, back to Requested`, () => moveTask(t.id, to, anchor))
  }
  // BAS-1436: якорь, перенесённый на день дальше завтрашнего, виден только здесь — проверить время
  // можно и отсюда (часть переноса, поэтому и у Schedule Manager).
  const [anchorFor, setAnchorFor] = useState<Task | null>(null)
  const keepAnchor = useMutation({
    mutationFn: (id: string) => setTaskAnchor(id),
    onSuccess: () => { setMoveError(null); void qc.invalidateQueries({ queryKey: ['tasks'] }) },
    onError: (e: unknown) => setMoveError(errMsg(e)),
  })

  return (
    <div className="space-y-4">
      <Tabs<'requested' | 'proposed' | 'scheduled'>
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'requested', label: <>Requested{count(requested.length)}</> },
          { key: 'proposed', label: <>Proposed{count(proposed.length)}</> },
          { key: 'scheduled', label: <>Scheduled{count(scheduled.length)}</> },
        ]}
      />
      <Card className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3 sm:p-4">
        <label className="flex items-center gap-1.5 text-sm text-gray-600">
          <Calendar size={14} /> Date
          <Input type="date" className="w-40 py-1" value={date} onChange={(e) => { if (e.target.value) setDate(e.target.value) }} />
        </label>
        <span className="font-semibold text-gray-900">{dayHeading(date, today)}</span>
        {!isTomorrow && (
          <Button variant="ghost" onClick={() => setDate(tomorrow)}>Tomorrow</Button>
        )}
        <span className="text-xs text-gray-500 sm:ml-auto">All PMs · view only</span>
      </Card>
      {error && <p className="text-sm text-red-600">⚠ {errMsg(error)}</p>}
      {moveError && <p className="text-sm text-red-600">⚠ {moveError}</p>}
      {isStale && proposed.length > 0 && (
        <Card className="flex items-start gap-3 border-amber-200 bg-amber-50 p-3 sm:p-4">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-600" />
          <p className="text-sm text-amber-800">
            {proposed.length} proposed task(s) were never approved for this day.
            {can('rearrange_proposed') ? ' Push them to another day — they go back to Requested.' : ' The Schedule Manager can push them to another day.'}
          </p>
        </Card>
      )}
      {isLoading && <p className="text-gray-500">Loading…</p>}
      {!isLoading && !error && tab === 'requested' && (
        requested.length === 0
          ? <p className="text-gray-500">No requested tasks for this date.</p>
          : (
            <div className="grid grid-cols-1 gap-2 sm:gap-3 md:grid-cols-2">
              {requested.map((t) => (
                <div key={t.id} role="button" tabIndex={0} className="min-w-0 cursor-pointer"
                  onClick={() => setOpenTask(t)} onKeyDown={(e) => { if (e.key === 'Enter') setOpenTask(t) }}>
                  <TaskCardCompact t={t} waiting={isWaitingForAi(t)} canChangePm={false}
                    anchorCheck={t.anchor_moved_from && can('change_task_date') && !isWaitingForAi(t)
                      ? { onKeep: () => keepAnchor.mutate(t.id), onChange: () => setAnchorFor(t), busy: keepAnchor.isPending }
                      : undefined} />
                </div>
              ))}
            </div>
          )
      )}
      {!isLoading && !error && tab === 'proposed' && (
        proposed.length === 0 ? <p className="text-gray-500">No proposed tasks for this date.</p>
          : <TeamTaskList tasks={proposed} onOpen={setOpenTask} onPush={onPush}
              badge={(t) => (isStale ? { label: 'Not approved', tone: 'danger' }
                : t.ai_warnings?.length ? { label: 'Has warnings', tone: 'warning' } : { label: 'Proposed', tone: 'neutral' })} />
      )}
      {!isLoading && !error && tab === 'scheduled' && (
        scheduled.length === 0 ? <p className="text-gray-500">No scheduled tasks for this date.</p>
          : <TeamTaskList tasks={scheduled} badge={executionBadge} onOpen={setOpenTask} />
      )}
      {openTask && <ReadOnlyTask task={openTask} onClose={() => setOpenTask(null)} />}
      <AnchorTimeModal task={anchorFor} onClose={() => setAnchorFor(null)}
        onSaved={() => { setAnchorFor(null); void qc.invalidateQueries({ queryKey: ['tasks'] }) }} />
      <MoveDateModal task={moving} pending={false} defaultDate={tomorrow} onClose={() => setMoving(null)}
        onMove={(to, anchor) => moving && doMove(moving, to, anchor)} />
      {undoable.toast}
    </div>
  )
}

/* ---------------- Today (BAS-1435) ---------------- */
/** Задачи сегодняшнего дня, ещё не закрытые PM: Uncompleted (бригада не отметила) и Completed (ждут PM). */
function Today() {
  const today = todayISO()
  const { data, isLoading, error } = useQuery({
    queryKey: ['tasks', 'today', today],
    queryFn: () => fetchTasks('scheduled', { date: today, executionStatus: ['pending', 'completed'] }),
  })
  const tasks = useMemo(() => tasksForView(data ?? [], 'today', today), [data, today])
  const [openTask, setOpenTask] = useState<Task | null>(null)
  // Правка PM-ом (BAS-1514) — у задач, которые бригада ещё не отметила.
  const qc = useQueryClient()
  const { can } = useTaskPlannerRoles()
  const [editing, setEditing] = useState<Task | null>(null)
  const done = tasks.filter((t) => t.execution_status === 'completed').length
  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center justify-between gap-2 p-4">
        <span className="font-semibold text-gray-900">Today · {dayHeading(today, today)}</span>
        <div className="flex flex-wrap items-center gap-2">
          <Badge className="bg-gray-100 text-gray-600">{tasks.length - done} uncompleted</Badge>
          <Badge className="bg-amber-50 text-amber-700">{done} completed</Badge>
        </div>
      </Card>
      {error && <p className="text-sm text-red-600">⚠ {errMsg(error)}</p>}
      {isLoading && <p className="text-gray-500">Loading…</p>}
      {!isLoading && !error && !tasks.length && <p className="text-gray-500">No open tasks for today.</p>}
      <TeamTaskList
        tasks={tasks}
        badge={(t) => ({ label: OWN_LABEL[ownListOf(t)], tone: t.execution_status === 'completed' ? 'warning' : 'neutral' })}
        onOpen={setOpenTask}
        onEdit={can('edit_task') ? setEditing : undefined}
      />
      {openTask && <ReadOnlyTask task={openTask} onClose={() => setOpenTask(null)} />}
      <TaskEditModal task={editing} onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); void qc.invalidateQueries({ queryKey: ['tasks'] }) }} />
    </div>
  )
}

/* ---------------- Closed (BAS-1435) ---------------- */
/** Закрытые PM задачи (принятые и нет) за период по дате задачи — тот же фильтр, что у PM. */
function Closed() {
  const today = todayISO()
  const f = useRangeFilter(today)
  const { data, isLoading, error } = useQuery({
    queryKey: ['tasks', 'closed', f.range?.from ?? null, f.range?.to ?? null],
    queryFn: () => fetchTasks('scheduled', { dateFrom: f.range?.from, dateTo: f.range?.to, executionStatus: 'closed' }),
    enabled: !f.badRange,
  })
  const tasks = useMemo(() => tasksForView(data ?? [], 'closed', today), [data, today])
  const byDay = useMemo(() => groupByDay(tasks), [tasks])
  const [openTask, setOpenTask] = useState<Task | null>(null)
  const notAccepted = tasks.filter((t) => t.task_accepted === false).length
  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <RangeFilter f={f} />
        <div className="flex flex-wrap items-center gap-2">
          <Badge className="bg-green-50 text-green-700">{tasks.length - notAccepted} accepted</Badge>
          <Badge className="bg-red-50 text-red-700">{notAccepted} not accepted</Badge>
        </div>
      </Card>
      {f.badRange && <p className="text-sm text-red-600">The start date is after the end date.</p>}
      {error && <p className="text-sm text-red-600">⚠ {errMsg(error)}</p>}
      {isLoading && <p className="text-gray-500">Loading…</p>}
      {!isLoading && !error && !f.badRange && !tasks.length && (
        <p className="text-gray-500">No closed tasks {f.range ? 'in this period' : 'yet'}.</p>
      )}
      {byDay.map((d) => (
        <section key={d.date}>
          <h3 className="mb-2 text-sm font-semibold text-gray-700">
            {d.date ? dayHeading(d.date, today) : 'No date'} <span className="font-normal text-gray-400">· {d.tasks.length}</span>
          </h3>
          <TeamTaskList tasks={d.tasks} badge={executionBadge} onOpen={setOpenTask} />
        </section>
      ))}
      {openTask && <ReadOnlyTask task={openTask} onClose={() => setOpenTask(null)} />}
    </div>
  )
}

/** Лимиты переработки бригад: id бригады → минут сверх 8 часов (BAS-1445). */
function useOvertimeLimits(): Map<string, number> {
  const { data } = useQuery({ queryKey: ['teams'], queryFn: fetchTeams, staleTime: 5 * 60 * 1000 })
  return useMemo(() => new Map((data ?? []).map((t) => [t.id, t.overtime_limit_min])), [data])
}

/**
 * Переработка дня бригады (BAS-1445): в пределах её лимита — жёлтая, сверх лимита — красная
 * «over limit». До 8 часов — ничего.
 */
function OvertimeBadge({ teamId, totalMin }: { teamId: string; totalMin: number }) {
  const limits = useOvertimeLimits()
  if (totalMin <= NORMAL_DAY_MIN) return null
  const limit = limits.get(teamId) ?? DEFAULT_OVERTIME_LIMIT_MIN
  const over = dayCategory(totalMin, limit) === 'overtime_over_10'
  const extra = minToHm(totalMin - NORMAL_DAY_MIN)
  return (
    <span title={`Crew overtime limit: ${overtimeLimitLabel(limit)}`}>
      {over
        ? <StatusBadge tone="danger">over limit · +{extra} (max {overtimeLimitLabel(limit)})</StatusBadge>
        : <StatusBadge tone="warning">overtime +{extra}</StatusBadge>}
    </span>
  )
}
