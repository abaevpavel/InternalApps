/**
 * Task Planner — **My Tasks**: своя сторона (BAS-1510).
 *
 * Свои задачи утверждённого расписания за период, тремя списками Uncompleted / Completed /
 * Closed, внутри — по дням. Чьи задачи:
 *  - Project Manager — созданные им; старые задачи без автора — с пометкой «no author»;
 *  - Lead Carpenter — своей бригады, и только у него есть действия исполнения
 *    (Complete, заметки, фото).
 * У кого обе роли — переключатель «As PM / My crew».
 *
 * Скоуп «своя бригада» держит RLS (миграция 0028), а не фильтр в запросе. Логика списков —
 * `domain/task-planner/own-side.ts`. Общий вид по всем PM — экран Tasks (Tracking — BAS-1433).
 */
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Info, MessageSquare, Upload, X } from 'lucide-react'
import { Badge, Button, Card, Input, Modal, PageTitle, StatusBadge, Tabs, Textarea } from '../../components/ui'
import { cn, errMsg } from '../../lib/utils'
import { hhmmToMin, minToAmPm, TIMEZONE } from '../../lib/task-planner-time'
import type { Task } from '../../domain/task-planner/types'
import {
  actorRoleLabel, addTaskNote, completeTask, describeTaskEvent, EXECUTION_LABEL, EXECUTION_TONE,
  fetchCrewCommentCounts, fetchTaskEvents, removeTaskPhoto, fetchTaskPhotos, fetchTasksInRange, uploadTaskPhoto,
} from '../../services/task-planner/execution'
import {
  groupByDay, hasNoAuthor, OWN_LISTS, ownListOf, ownTasks, presetRange, RANGE_PRESETS,
  type OwnList, type OwnMode, type RangePreset,
} from '../../domain/task-planner/own-side'
import { useAuth } from '../../auth/AuthProvider'
import { useTaskPlannerRoles } from './useTaskPlannerRole'

/* ---------------- Даты ---------------- */

/** «Сегодня» — по таймзоне компании (America/New_York), а не по часам ноутбука. */
function todayISO(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(new Date())
}

function dayHeading(iso: string, today: string): string {
  const d = new Date(`${iso}T12:00:00`)
  const label = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric' }).format(d)
  return iso === today ? `${label} · Today` : label
}

/* ---------------- Экран ---------------- */

export function MyTasksPage() {
  const { authUser, profile } = useAuth()
  const { roles, teamName } = useTaskPlannerRoles()
  // Чей это вид — в заголовке (имя залогиненного, иначе email).
  const viewerName =
    [profile?.first_name, profile?.last_name].filter(Boolean).join(' ').trim() || authUser?.email || ''
  const modes: OwnMode[] = [
    ...(roles.includes('pm') ? (['pm'] as const) : []),
    ...(roles.includes('lead_carpenter') ? (['crew'] as const) : []),
  ]
  const [modeChoice, setModeChoice] = useState<OwnMode | null>(null)
  const mode: OwnMode = modeChoice && modes.includes(modeChoice) ? modeChoice : modes[0] ?? 'crew'

  const today = todayISO()
  const [preset, setPreset] = useState<RangePreset | null>('this_week')
  // null — без фильтра по датам (кнопка All dates).
  const [range, setRange] = useState<{ from: string; to: string } | null>(() => presetRange('this_week', today))
  const badRange = !!range && range.from > range.to
  const [list, setList] = useState<OwnList>('uncompleted')
  const [openTask, setOpenTask] = useState<Task | null>(null)

  const { data, isLoading, error } = useQuery({
    queryKey: ['tp-own-tasks', range?.from ?? null, range?.to ?? null],
    queryFn: () => fetchTasksInRange(range?.from, range?.to),
    enabled: !badRange,
  })

  const mine = useMemo(() => ownTasks(data ?? [], mode, authUser?.id ?? null), [data, mode, authUser?.id])
  // BAS-1513: у задачи с комментарием Lead Carpenter — маркер в списке.
  const mineIds = mine.map((t) => t.id).sort().join(',')
  const commentsQ = useQuery({
    queryKey: ['tp-task-comments', mineIds],
    queryFn: () => fetchCrewCommentCounts(mineIds ? mineIds.split(',') : []),
    enabled: !!mineIds,
  })
  const counts = useMemo(() => {
    const c: Record<OwnList, number> = { uncompleted: 0, completed: 0, closed: 0 }
    for (const t of mine) c[ownListOf(t)]++
    return c
  }, [mine])
  const days = useMemo(() => groupByDay(mine.filter((t) => ownListOf(t) === list)), [mine, list])

  function pickPreset(p: RangePreset) {
    setPreset(p)
    setRange(presetRange(p, today))
  }
  function setBound(key: 'from' | 'to', v: string) {
    if (!v) return
    setPreset(null)
    setRange((r) => ({ ...(r ?? { from: v, to: v }), [key]: v }))
  }
  function clearDates() {
    setPreset(null)
    setRange(null)
  }

  const subtitle =
    mode === 'pm'
      ? 'Tasks you created, from the approved schedule. Older tasks without an author are shown to every PM.'
      : teamName
        ? `Approved schedule for ${teamName}.`
        : 'No crew is linked to your email, so there are no tasks to show.'

  return (
    <>
      <PageTitle title={viewerName ? `My Tasks (${viewerName})` : 'My Tasks'} subtitle={subtitle} />

      <div className="mb-4 flex flex-col gap-3">
        {modes.length > 1 && (
          <Tabs
            className="max-w-xs"
            tabs={[
              { key: 'pm' as OwnMode, label: 'As PM' },
              { key: 'crew' as OwnMode, label: 'My crew' },
            ]}
            value={mode}
            onChange={setModeChoice}
          />
        )}

        {/* Период: быстрые варианты или свои границы. */}
        <div className="flex flex-wrap items-center gap-2">
          {RANGE_PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => pickPreset(p.key)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition',
                preset === p.key
                  ? 'border-brand-blue bg-brand-blue text-white'
                  : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300',
              )}
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            onClick={clearDates}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium transition',
              range === null
                ? 'border-brand-blue bg-brand-blue text-white'
                : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300',
            )}
          >
            All dates
          </button>
          <div className="flex items-center gap-1.5 text-sm text-gray-500">
            <Input type="date" className="w-36 py-1" value={range?.from ?? ''} onChange={(e) => setBound('from', e.target.value)} />
            <span>–</span>
            <Input type="date" className="w-36 py-1" value={range?.to ?? ''} onChange={(e) => setBound('to', e.target.value)} />
          </div>
        </div>

        <Tabs
          className="max-w-md"
          tabs={OWN_LISTS.map((l) => ({
            key: l.key,
            label: (
              <span>
                {l.label} <span className="text-gray-400">{counts[l.key]}</span>
              </span>
            ),
          }))}
          value={list}
          onChange={setList}
        />
      </div>

      {badRange && <Card className="p-4 text-sm text-red-600">The start date is after the end date.</Card>}
      {error && <Card className="p-4 text-sm text-red-600">⚠ {errMsg(error)}</Card>}
      {isLoading && <Card className="p-8 text-center text-gray-500">Loading…</Card>}
      {!isLoading && !error && days.length === 0 && !badRange && (
        <Card className="p-8 text-center text-gray-500">
          No {list} tasks {range ? 'in this period' : 'yet'}.
        </Card>
      )}

      <div className="space-y-5">
        {days.map((day) => (
          <section key={day.date}>
            <h3 className="mb-2 text-sm font-semibold text-gray-700">
              {day.date ? dayHeading(day.date, today) : 'No date'}{' '}
              <span className="font-normal text-gray-400">· {day.tasks.length}</span>
            </h3>
            <div className="space-y-2">
              {day.tasks.map((t, i) => (
                <TaskRow key={t.id} task={t} index={i + 1} mode={mode}
                  comments={commentsQ.data?.get(t.id) ?? 0} onOpen={() => setOpenTask(t)} />
              ))}
            </div>
          </section>
        ))}
      </div>

      {openTask && (
        <TaskDetailsModal task={openTask} canAct={mode === 'crew'} onClose={() => setOpenTask(null)} />
      )}
    </>
  )
}

/* ---------------- Карточка задачи ---------------- */

function TaskRow({ task, index, mode, comments, onOpen }: {
  task: Task
  index: number
  mode: OwnMode
  /** Сколько комментариев оставил Lead Carpenter (BAS-1513). */
  comments: number
  onOpen: () => void
}) {
  const time = task.sched_start && task.sched_end
    ? `${minToAmPm(hhmmToMin(task.sched_start))} – ${minToAmPm(hhmmToMin(task.sched_end))}`
    : '—'
  const done = task.execution_status === 'approved' || task.execution_status === 'completed'
  // Complete — действие Lead Carpenter; PM на своей стороне задачу только смотрит.
  const actionLabel = mode === 'crew' && !done ? 'Complete' : 'Details'

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-amber-50 text-sm font-bold text-amber-700">
            {index}
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
              <span className="rounded bg-amber-50 px-2 py-0.5 font-medium text-amber-700">{task.task_type}</span>
              {task.project_manager && <span>PM: {task.project_manager}</span>}
              {mode === 'pm' && task.assigned_team_name && <span>Crew: {task.assigned_team_name}</span>}
              {mode === 'pm' && hasNoAuthor(task) && <Badge className="bg-gray-100 text-gray-500">no author</Badge>}
              <StatusBadge tone={EXECUTION_TONE[task.execution_status]}>
                {EXECUTION_LABEL[task.execution_status]}
              </StatusBadge>
              {comments > 0 && (
                <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-0.5 font-medium text-amber-800">
                  <MessageSquare size={12} /> {comments} {comments === 1 ? 'comment' : 'comments'}
                </span>
              )}
            </div>
            <button onClick={onOpen} className="mt-1 block text-left font-semibold text-gray-900 hover:text-accent-700">
              {task.title || task.description || 'Untitled task'}
            </button>
            <div className="mt-1 text-sm text-gray-600">
              {task.anchor && <span className="font-medium text-red-600">Exact time · </span>}
              Travel: <b className="text-gray-900">{task.travel_time ?? 0} min</b> · Time:{' '}
              <b className="text-gray-900">{time}</b> · Duration:{' '}
              <b className="text-gray-900">{task.estimated_duration_min} min</b>
            </div>
            <div className="mt-1 text-xs text-gray-500">
              {task.project_name && <>Project: <b className="text-gray-700">{task.project_name}</b> · </>}
              Date: {task.scheduled_date}
              {task.task_address && (
                <>
                  {' · '}
                  <a
                    className="text-blue-600 hover:underline"
                    href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(task.task_address)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {task.task_address}
                  </a>
                </>
              )}
            </div>
          </div>
        </div>
        <Button variant={actionLabel === 'Complete' ? 'amber' : 'subtle'} onClick={onOpen}>
          {actionLabel}
        </Button>
      </div>
    </Card>
  )
}

/* ---------------- Модалка задачи ---------------- */

/**
 * Детали задачи. `canAct` — действия исполнения (Complete, заметка, фото): только Lead Carpenter
 * своей бригады. PM видит описание, фото и историю. Окончательный запрет — в функциях БД.
 */
function TaskDetailsModal({ task, canAct, onClose }: { task: Task; canAct: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const [note, setNote] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const { data: photos } = useQuery({ queryKey: ['tp-task-photos', task.id], queryFn: () => fetchTaskPhotos(task.id) })
  // Комментарии обеих сторон: Lead Carpenter (заметки, комментарий к выполнению) и PM (проверка).
  const { data: events } = useQuery({ queryKey: ['tp-task-events', task.id], queryFn: () => fetchTaskEvents(task.id, 50) })
  const comments = (events ?? []).filter((e) => e.comment)

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['tp-own-tasks'] })
    void qc.invalidateQueries({ queryKey: ['tp-task-events', task.id] })
    void qc.invalidateQueries({ queryKey: ['tp-task-photos', task.id] })
    void qc.invalidateQueries({ queryKey: ['tp-task-comments'] })
  }
  const onError = (e: unknown) => setErr(errMsg(e))

  const addNote = useMutation({
    mutationFn: () => addTaskNote(task.id, note),
    onSuccess: () => { setNote(''); setErr(null); invalidate() },
    onError,
  })
  const upload = useMutation({
    mutationFn: (files: File[]) => Promise.all(files.map((f) => uploadTaskPhoto(task.id, f))).then(() => undefined),
    onSuccess: () => { setErr(null); invalidate() },
    onError,
  })
  // Удалить фото — бригада, пока задача не закрыта (approved); проверка ещё и в БД (0031).
  const canRemovePhotos = canAct && task.execution_status !== 'approved'
  const removePhoto = useMutation({
    mutationFn: (photoId: string) => removeTaskPhoto(photoId),
    onSuccess: () => { setErr(null); invalidate() },
    onError,
  })
  // Комментарий необязателен: если он набран, уходит вместе с отметкой о выполнении.
  const complete = useMutation({
    mutationFn: () => completeTask(task.id, note.trim() || undefined),
    onSuccess: () => { setNote(''); setErr(null); invalidate(); onClose() },
    onError,
  })

  const canComplete = canAct && (task.execution_status === 'pending' || task.execution_status === 'rework')

  return (
    <>
      <Modal
        open
        title="Task Details"
        subtitle={task.title || task.description}
        onClose={onClose}
        footer={
          <>
            <Button onClick={onClose}>Close</Button>
            {canComplete && (
              <Button variant="amber" disabled={complete.isPending} onClick={() => complete.mutate()}>
                {complete.isPending ? 'Saving…' : 'Complete'}
              </Button>
            )}
          </>
        }
      >
        <div className="space-y-5">
          <div className="flex items-center gap-2">
            <Button variant="outline" className="text-gray-600" onClick={() => setHistoryOpen(true)}>
              <Info size={16} /> info
            </Button>
            <StatusBadge tone={EXECUTION_TONE[task.execution_status]}>
              {EXECUTION_LABEL[task.execution_status]}
            </StatusBadge>
          </div>

          {err && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">⚠ {err}</div>}

          {task.description && <p className="whitespace-pre-line text-gray-700">{task.description}</p>}

          <div>
            <h4 className="mb-2 font-semibold text-gray-900">Comments</h4>
            {comments.length === 0 ? (
              <p className="text-sm text-gray-500">No comments yet</p>
            ) : (
              <ul className="space-y-2">
                {comments.map((e) => (
                  <li key={e.id} className="rounded-lg bg-gray-50 px-3 py-2">
                    <div className="whitespace-pre-line text-sm text-gray-800">{e.comment}</div>
                    <div className="mt-1 text-xs text-gray-400">
                      {actorRoleLabel(e.actor_role)} · {e.actor_email ?? 'unknown'} · {describeTaskEvent(e)} ·{' '}
                      {new Date(e.created_at).toLocaleString('en-US', { timeZone: TIMEZONE })}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {canAct && (
              <>
                <Textarea className="mt-3" rows={3} placeholder="Comment for the PM — e.g. why the task is not finished…"
                  value={note} onChange={(e) => setNote(e.target.value)} />
                <Button
                  variant="amber"
                  className="mt-2 w-full"
                  disabled={!note.trim() || addNote.isPending}
                  onClick={() => addNote.mutate()}
                >
                  {addNote.isPending ? 'Saving…' : 'Add comment'}
                </Button>
                {canComplete && note.trim() && (
                  <p className="mt-1 text-xs text-gray-500">Or press Complete — the comment is attached to the completion.</p>
                )}
              </>
            )}
          </div>

          <div>
            <h4 className="mb-2 font-semibold text-gray-900">Photos</h4>
            {canAct && (
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-brand-amber px-3.5 py-2 text-sm font-medium text-black transition hover:brightness-95">
              <Upload size={16} />
              {upload.isPending ? 'Uploading…' : 'Upload Photos'}
              <input
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                disabled={upload.isPending}
                onChange={(e) => {
                  // Копия до очистки поля: FileList «живой» и обнуляется вместе с value, а загрузка
                  // читает его уже после — раньше уходило 0 файлов без ошибки.
                  const files = Array.from(e.target.files ?? [])
                  e.target.value = ''
                  if (files.length) upload.mutate(files)
                }}
              />
            </label>
            )}
            {(photos ?? []).length === 0 ? (
              <p className="mt-2 text-sm text-gray-500">No photos yet</p>
            ) : (
              <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
                {(photos ?? []).map((p) => (
                  <div key={p.id} className="relative">
                    <a href={p.url ?? undefined} target="_blank" rel="noreferrer">
                      {p.url
                        ? <img src={p.url} alt="" className="h-24 w-full rounded-lg object-cover" />
                        : <div className="flex h-24 w-full items-center justify-center rounded-lg bg-gray-100 text-xs text-gray-500">no preview</div>}
                    </a>
                    {canRemovePhotos && (
                      <button
                        type="button"
                        aria-label="Remove photo"
                        title="Remove photo"
                        disabled={removePhoto.isPending}
                        onClick={() => { if (confirm('Remove this photo?')) removePhoto.mutate(p.id) }}
                        className="absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-white text-gray-600 shadow ring-1 ring-gray-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </Modal>

      {historyOpen && <TaskHistoryModal taskId={task.id} onClose={() => setHistoryOpen(false)} />}
    </>
  )
}

/* ---------------- История ---------------- */

/**
 * Лента `tp_task_events`: отметка бригадира, комментарий апрувера, возврат на доработку,
 * заметки и фото — в одном месте и в одном порядке.
 */
export function TaskHistoryModal({ taskId, onClose, limit = 3 }: { taskId: string; onClose: () => void; limit?: number }) {
  const [showAll, setShowAll] = useState(false)
  const { data: events, isLoading } = useQuery({
    queryKey: ['tp-task-events', taskId],
    queryFn: () => fetchTaskEvents(taskId, 50),
  })
  const shown = useMemo(() => (showAll ? events ?? [] : (events ?? []).slice(0, limit)), [events, showAll, limit])

  return (
    <Modal
      open
      title={<span className="flex items-center gap-2"><CheckCircle2 size={18} className="text-green-600" /> Task Completion Details</span>}
      onClose={onClose}
      size="sm"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <h4 className="mb-3 font-semibold text-gray-900">
        Recent History {showAll ? '' : `(Last ${limit} changes)`}
      </h4>
      {isLoading && <p className="text-gray-500">Loading…</p>}
      {!isLoading && shown.length === 0 && <p className="text-gray-500">No history available</p>}
      <ul className="space-y-3">
        {shown.map((e) => (
          <li key={e.id} className="border-l-2 border-gray-200 pl-3">
            <div className="text-sm font-medium text-gray-900">{describeTaskEvent(e)}</div>
            {e.comment && <div className="mt-0.5 whitespace-pre-line text-sm text-gray-600">{e.comment}</div>}
            <div className="mt-0.5 text-xs text-gray-400">
              {e.actor_email ?? 'unknown'} · {new Date(e.created_at).toLocaleString('en-US', { timeZone: TIMEZONE })}
            </div>
          </li>
        ))}
      </ul>
      {!showAll && (events ?? []).length > limit && (
        <Button variant="ghost" className="mt-3 px-0" onClick={() => setShowAll(true)}>
          Show all {(events ?? []).length} events
        </Button>
      )}
    </Modal>
  )
}
