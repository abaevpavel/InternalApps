/**
 * Task Planner — **My Tasks**: рабочий экран бригадира (и админа — для проверки).
 *
 * Показывает утверждённое расписание своей бригады на выбранный день (Yesterday / Today /
 * Tomorrow) и даёт единственное действие исполнения — Complete, плюс заметки и фото.
 * Табов планирования (Requested/Proposed) тут нет намеренно: это кухня планировщика.
 *
 * Скоуп «своя бригада» держит RLS (`0007_tp_task_execution.sql`), а не фильтр в запросе —
 * иначе ограничение обходилось бы прямым запросом с anon-ключом. Модель — docs/TASK-PLANNER-ROLES.md §5.
 */
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Calendar, CheckCircle2, Info, Upload } from 'lucide-react'
import { Button, Card, Input, Modal, PageTitle, StatusBadge, Textarea } from '../../components/ui'
import { errMsg } from '../../lib/utils'
import { hhmmToMin, minToAmPm, TIMEZONE } from '../../lib/task-planner-time'
import type { Task } from '../../domain/task-planner/types'
import {
  addTaskNote, completeTask, describeTaskEvent, EXECUTION_LABEL, EXECUTION_TONE,
  fetchTaskEvents, fetchTaskPhotos, fetchTasksForDay, uploadTaskPhoto,
} from '../../services/task-planner/execution'
import { useTaskPlannerRole } from './useTaskPlannerRole'

/* ---------------- Даты ---------------- */

/** «Сегодня» — по таймзоне компании (America/New_York), а не по часам ноутбука. */
function todayISO(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(new Date())
}

function shiftISO(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00`) // полдень: сдвиг не срывается на переходе DST
  d.setDate(d.getDate() + days)
  return new Intl.DateTimeFormat('en-CA').format(d)
}

function longDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00`)
  return new Intl.DateTimeFormat('en-US', { month: 'long', weekday: 'long', day: '2-digit', year: 'numeric' }).format(d)
}

/* ---------------- Экран ---------------- */

export function MyTasksPage() {
  const { role, teamName } = useTaskPlannerRole()
  const today = todayISO()
  const [date, setDate] = useState(today)
  const [openTask, setOpenTask] = useState<Task | null>(null)

  const { data: tasks, isLoading, error } = useQuery({
    queryKey: ['tp-my-tasks', date],
    queryFn: () => fetchTasksForDay(date),
  })

  const shortcut = date === today ? 'today' : date === shiftISO(today, -1) ? 'yesterday' : date === shiftISO(today, 1) ? 'tomorrow' : null

  return (
    <>
      <PageTitle
        title="My Tasks"
        subtitle={
          role === 'admin'
            ? 'Approved schedule for the selected day. As a portal admin you see every crew.'
            : teamName
              ? `Approved schedule for ${teamName}.`
              : 'Approved schedule for your crew.'
        }
      />

      <div className="mb-6 flex flex-col items-center gap-3">
        <label className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800">
          <Calendar size={16} className="text-gray-500" />
          <span className="hidden sm:inline">{longDate(date)}</span>
          <Input
            type="date"
            className="w-40 border-0 py-0 focus:ring-0"
            value={date}
            onChange={(e) => setDate(e.target.value || today)}
          />
        </label>
        <div className="flex overflow-hidden rounded-lg border border-gray-200">
          {([
            ['yesterday', shiftISO(today, -1), 'Yesterday'],
            ['today', today, 'Today'],
            ['tomorrow', shiftISO(today, 1), 'Tomorrow'],
          ] as const).map(([key, iso, label]) => (
            <button
              key={key}
              onClick={() => setDate(iso)}
              className={`px-5 py-2 text-sm font-medium transition ${
                shortcut === key ? 'bg-brand-amber text-black' : 'bg-gray-50 text-gray-600 hover:bg-gray-100'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {error && <Card className="p-4 text-sm text-red-600">⚠ {errMsg(error)}</Card>}
      {isLoading && <Card className="p-8 text-center text-gray-500">Loading…</Card>}
      {!isLoading && !error && (tasks ?? []).length === 0 && (
        <Card className="p-8 text-center text-gray-500">No scheduled tasks found for {date}</Card>
      )}

      <div className="space-y-3">
        {(tasks ?? []).map((t, i) => (
          <TaskRow key={t.id} task={t} index={i + 1} onOpen={() => setOpenTask(t)} />
        ))}
      </div>

      {openTask && (
        <TaskDetailsModal
          task={openTask}
          date={date}
          onClose={() => setOpenTask(null)}
        />
      )}
    </>
  )
}

/* ---------------- Карточка задачи ---------------- */

function TaskRow({ task, index, onOpen }: { task: Task; index: number; onOpen: () => void }) {
  const time = task.sched_start && task.sched_end
    ? `${minToAmPm(hhmmToMin(task.sched_start))} – ${minToAmPm(hhmmToMin(task.sched_end))}`
    : '—'
  const done = task.execution_status === 'approved' || task.execution_status === 'completed'

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
              <StatusBadge tone={EXECUTION_TONE[task.execution_status]}>
                {EXECUTION_LABEL[task.execution_status]}
              </StatusBadge>
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
        <Button variant={done ? 'subtle' : 'amber'} onClick={onOpen}>
          {done ? 'Details' : 'Complete'}
        </Button>
      </div>
    </Card>
  )
}

/* ---------------- Модалка задачи ---------------- */

function TaskDetailsModal({ task, date, onClose }: { task: Task; date: string; onClose: () => void }) {
  const qc = useQueryClient()
  const [note, setNote] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const { data: photos } = useQuery({ queryKey: ['tp-task-photos', task.id], queryFn: () => fetchTaskPhotos(task.id) })

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['tp-my-tasks', date] })
    void qc.invalidateQueries({ queryKey: ['tp-task-events', task.id] })
    void qc.invalidateQueries({ queryKey: ['tp-task-photos', task.id] })
  }
  const onError = (e: unknown) => setErr(errMsg(e))

  const addNote = useMutation({
    mutationFn: () => addTaskNote(task.id, note),
    onSuccess: () => { setNote(''); setErr(null); invalidate() },
    onError,
  })
  const upload = useMutation({
    mutationFn: (files: FileList) => Promise.all(Array.from(files).map((f) => uploadTaskPhoto(task.id, f))).then(() => undefined),
    onSuccess: () => { setErr(null); invalidate() },
    onError,
  })
  const complete = useMutation({
    mutationFn: () => completeTask(task.id),
    onSuccess: () => { setErr(null); invalidate(); onClose() },
    onError,
  })

  const canComplete = task.execution_status === 'pending' || task.execution_status === 'rework'

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
            <h4 className="mb-2 font-semibold text-gray-900">Notes</h4>
            <Textarea rows={3} placeholder="Add a note…" value={note} onChange={(e) => setNote(e.target.value)} />
            <Button
              variant="amber"
              className="mt-2 w-full"
              disabled={!note.trim() || addNote.isPending}
              onClick={() => addNote.mutate()}
            >
              {addNote.isPending ? 'Saving…' : 'Add Note'}
            </Button>
          </div>

          <div>
            <h4 className="mb-2 font-semibold text-gray-900">Photos</h4>
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-brand-amber px-3.5 py-2 text-sm font-medium text-black transition hover:brightness-95">
              <Upload size={16} />
              {upload.isPending ? 'Uploading…' : 'Upload Photos'}
              <input
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                disabled={upload.isPending}
                onChange={(e) => { if (e.target.files?.length) upload.mutate(e.target.files); e.target.value = '' }}
              />
            </label>
            {(photos ?? []).length === 0 ? (
              <p className="mt-2 text-sm text-gray-500">No photos yet</p>
            ) : (
              <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
                {(photos ?? []).map((p) => (
                  <a key={p.id} href={p.url ?? undefined} target="_blank" rel="noreferrer">
                    {p.url
                      ? <img src={p.url} alt="" className="h-24 w-full rounded-lg object-cover" />
                      : <div className="flex h-24 w-full items-center justify-center rounded-lg bg-gray-100 text-xs text-gray-500">no preview</div>}
                  </a>
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
