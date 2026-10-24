/**
 * Task Planner — **My Tasks**: своя сторона (BAS-1510).
 *
 * Свои задачи утверждённого расписания за период, тремя списками Uncompleted / Completed /
 * Closed, внутри — по дням. Чьи задачи:
 *  - Project Manager — созданные им; старые задачи без автора — с пометкой «no author»;
 *  - Lead Carpenter — своей бригады, и только у него есть действия исполнения
 *    (Complete, заметки, фото). Его вид (BAS-1511) — один день по календарю, по умолчанию
 *    завтра; ничего со стороны планирования (RLS 0039: только scheduled своей бригады).
 * PM здесь же проверяет работу (BAS-1431): открывает задачу из Completed или Uncompleted
 * и закрывает её с отметкой Task Accepted. Закрытие — финал, задача уходит в Closed.
 * Если работа не принята — предложение создать задачу на другой день (Create Task с
 * пустой формой; ссылка на исходную задачу пишется только в БД, `origin_task_id`).
 * У кого обе роли — переключатель «As PM / My crew».
 *
 * Скоуп «своя бригада» держит RLS (миграция 0028), а не фильтр в запросе. Логика списков —
 * `domain/task-planner/own-side.ts`. Общий вид по всем PM — экран Tasks (Tracking — BAS-1433).
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, ChevronLeft, ChevronRight, Info, MessageSquare, Upload, X } from 'lucide-react'
import { Badge, Button, Card, Input, Modal, PageTitle, StatusBadge, Tabs, Textarea } from '../../components/ui'
import { cn, errMsg } from '../../lib/utils'
import { hhmmToMin, minToAmPm, TIMEZONE } from '../../lib/task-planner-time'
import type { Task } from '../../domain/task-planner/types'
import {
  actorRoleLabel, addReviewComment, addTaskNote, closeTask, completeTask, describeTaskEvent, executionBadge,
  fetchCrewCommentCounts, fetchTaskEvents, removeTaskPhoto, fetchTaskPhotos, fetchTasksForDay, fetchTasksInRange,
  uploadTaskPhoto,
} from '../../services/task-planner/execution'
import {
  defaultCrewDay, groupByDay, hasNoAuthor, OWN_LISTS, ownListOf, ownTasks, shiftDay,
  type OwnList, type OwnMode,
} from '../../domain/task-planner/own-side'
import { useAuth } from '../../auth/AuthProvider'
import { useTaskPlannerRoles } from './useTaskPlannerRole'
import { RangeFilter, useRangeFilter } from './RangeFilter'
import { MoveDateModal } from './MoveDateModal'
import { useUndoableAction } from './UndoableAction'
import { moveTask } from '../../services/task-planner/data'

/* ---------------- Даты ---------------- */

/** «Сегодня» — по таймзоне компании (America/New_York), а не по часам ноутбука. */
export function todayISO(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(new Date())
}

export function dayHeading(iso: string, today: string): string {
  const d = new Date(`${iso}T12:00:00`)
  const label = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric' }).format(d)
  return iso === today ? `${label} · Today` : label
}

/* ---------------- Экран ---------------- */

export function MyTasksPage() {
  const { authUser, profile } = useAuth()
  const { roles, teamName, can } = useTaskPlannerRoles()
  const nav = useNavigate()
  const qc = useQueryClient()
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
  // Период PM; null — без фильтра по датам (кнопка All dates). Тот же фильтр — во вкладке Closed.
  const rangeFilter = useRangeFilter(today)
  const range = rangeFilter.range
  // Бригада (BAS-1511) смотрит один день; по умолчанию завтра. null — без фильтра (All dates).
  const [day, setDay] = useState<string | null>(() => defaultCrewDay(today))
  const isCrew = mode === 'crew'
  const badRange = !isCrew && rangeFilter.badRange
  const [list, setList] = useState<OwnList>('uncompleted')
  const [openTask, setOpenTask] = useState<Task | null>(null)
  // Закрытие задачи PM (BAS-1431) и вопрос о задаче на другой день после «не принято».
  const [closeFor, setCloseFor] = useState<Task | null>(null)
  const [followUpFor, setFollowUpFor] = useState<Task | null>(null)
  const canReview = mode === 'pm' && can('review_task')
  // BAS-1437: PM переносит свою невыполненную задачу на день, когда работа будет сделана
  const canMove = mode === 'pm' && can('change_task_date')
  const [moveFor, setMoveFor] = useState<Task | null>(null)
  const [moveError, setMoveError] = useState<string | null>(null)
  // перенос уходит в базу через 5 секунд — до этого его можно отменить
  const undoable = useUndoableAction(
    (e) => setMoveError(errMsg(e)),
    () => {
      setMoveError(null)
      void qc.invalidateQueries({ queryKey: ['tp-own-tasks'] })
      void qc.invalidateQueries({ queryKey: ['tasks'] })
    },
  )

  const { data, isLoading, error } = useQuery({
    queryKey: isCrew ? ['tp-own-tasks', 'day', day] : ['tp-own-tasks', range?.from ?? null, range?.to ?? null],
    queryFn: () =>
      isCrew ? (day ? fetchTasksForDay(day) : fetchTasksInRange()) : fetchTasksInRange(range?.from, range?.to),
    enabled: !badRange,
  })

  const mine = useMemo(
    () => ownTasks(data ?? [], mode, authUser?.id ?? null, authUser?.email ?? null),
    [data, mode, authUser?.id, authUser?.email],
  )
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

  const subtitle =
    mode === 'pm'
      ? 'Tasks where you are the PM, from the approved schedule. Older tasks without a PM or author are shown to every PM.'
      : teamName
        ? day || !isCrew
          ? `Tasks of ${teamName} for the selected day.`
          : `All tasks of ${teamName}.`
        : 'No crew is linked to your email, so there are no tasks to show.'

  return (
    <>
      <PageTitle title={viewerName ? `My Tasks (${viewerName})` : 'My Tasks'} subtitle={subtitle} />

      <div className="mb-3 flex flex-col gap-2 sm:mb-4 sm:gap-3">
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

        {/* Бригада — один день по календарю; PM — период: быстрые варианты или свои границы. */}
        {isCrew ? (
          <DayPicker day={day} today={today} onChange={setDay} />
        ) : (
          <RangeFilter f={rangeFilter} />
        )}

        <Tabs
          className="max-w-md"
          tabs={OWN_LISTS.map((l) => ({
            key: l.key,
            label: (
              <span className="whitespace-nowrap">
                {l.label} <span className="text-gray-400">{counts[l.key]}</span>
              </span>
            ),
          }))}
          value={list}
          onChange={setList}
        />
      </div>

      {badRange && <Card className="p-4 text-sm text-red-600">The start date is after the end date.</Card>}
      {moveError && <Card className="p-4 text-sm text-red-600">⚠ {moveError}</Card>}
      {error && <Card className="p-4 text-sm text-red-600">⚠ {errMsg(error)}</Card>}
      {isLoading && <Card className="p-8 text-center text-gray-500">Loading…</Card>}
      {!isLoading && !error && days.length === 0 && !badRange && (
        <Card className="p-8 text-center text-gray-500">
          No {list} tasks {isCrew ? (day ? 'for this day' : 'yet') : range ? 'in this period' : 'yet'}.
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
                <TaskRow key={t.id} task={t} index={i + 1} mode={mode} canReview={canReview}
                  comments={commentsQ.data?.get(t.id) ?? 0} onOpen={() => setOpenTask(t)}
                  onMove={canMove && t.execution_status === 'pending' && !t.request_task_id ? () => setMoveFor(t) : undefined} />
              ))}
            </div>
          </section>
        ))}
      </div>

      <MoveDateModal task={moveFor} pending={false} onClose={() => setMoveFor(null)}
        onMove={(to, anchor) => {
          const t = moveFor
          setMoveFor(null)
          if (t) undoable.schedule(`“${(t.title || t.description).trim()}” → ${to}, back to Requested`, () => moveTask(t.id, to, anchor))
        }} />
      {undoable.toast}

      {openTask && (
        <TaskDetailsModal
          task={openTask}
          canAct={mode === 'crew'}
          canReview={canReview}
          onClose={() => setOpenTask(null)}
          onCloseTask={() => { setCloseFor(openTask); setOpenTask(null) }}
        />
      )}
      {closeFor && (
        <CloseTaskModal
          task={closeFor}
          onCancel={() => setCloseFor(null)}
          onClosed={(accepted) => {
            void qc.invalidateQueries({ queryKey: ['tp-own-tasks'] })
            void qc.invalidateQueries({ queryKey: ['tp-task-events', closeFor.id] })
            void qc.invalidateQueries({ queryKey: ['tasks'] })
            if (!accepted) setFollowUpFor(closeFor)
            setCloseFor(null)
          }}
        />
      )}
      {followUpFor && (
        <Modal
          open
          title="Create a task for another day?"
          subtitle={followUpFor.title || followUpFor.description}
          onClose={() => setFollowUpFor(null)}
          size="sm"
          footer={
            <>
              <Button onClick={() => setFollowUpFor(null)}>Not now</Button>
              <Button variant="amber" onClick={() => nav(`/task-planner/create?from=${followUpFor.id}`)}>
                Create task
              </Button>
            </>
          }
        >
          <p>The work was not accepted and the task is closed. Create a new task now, while you remember what was wrong?</p>
        </Modal>
      )}
    </>
  )
}

/* ---------------- День бригады ---------------- */

/**
 * Календарь бригады (BAS-1511): стрелки на день назад / вперёд, дата, быстрые Yesterday / Today /
 * Tomorrow и All dates — сбросить фильтр (`null`). Стрелки без выбранного дня считают от завтра.
 */
function DayPicker({ day, today, onChange }: { day: string | null; today: string; onChange: (d: string | null) => void }) {
  const base = day ?? shiftDay(today, 1)
  const quick = [
    { label: 'Yesterday', value: shiftDay(today, -1) },
    { label: 'Today', value: today },
    { label: 'Tomorrow', value: shiftDay(today, 1) },
  ]
  const chip = (active: boolean) =>
    cn(
      'whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium transition sm:px-3',
      active ? 'border-brand-blue bg-brand-blue text-white' : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300',
    )
  // Две строки: календарь со стрелками, под ним быстрые кнопки одной строкой. На телефоне — по центру.
  return (
    <div className="flex flex-col items-center gap-2 sm:items-start">
      <div className="flex items-center gap-1">
        <Button variant="outline" className="px-2 py-1" aria-label="Previous day" onClick={() => onChange(shiftDay(base, -1))}>
          <ChevronLeft size={16} />
        </Button>
        <Input type="date" className="w-40 py-1" value={day ?? ''} onChange={(e) => e.target.value && onChange(e.target.value)} />
        <Button variant="outline" className="px-2 py-1" aria-label="Next day" onClick={() => onChange(shiftDay(base, 1))}>
          <ChevronRight size={16} />
        </Button>
      </div>
      <div className="flex flex-nowrap items-center gap-1.5 sm:gap-2">
        {quick.map((q) => (
          <button key={q.label} type="button" onClick={() => onChange(q.value)} className={chip(day === q.value)}>
            {q.label}
          </button>
        ))}
        <button type="button" onClick={() => onChange(null)} className={chip(day === null)}>
          All dates
        </button>
      </div>
    </div>
  )
}

/* ---------------- Карточка задачи ---------------- */

function TaskRow({ task, index, mode, canReview, comments, onOpen, onMove }: {
  task: Task
  /** Перенос на другой день (BAS-1437): PM, только невыполненная задача. */
  onMove?: () => void
  index: number
  mode: OwnMode
  /** PM может закрыть задачу (BAS-1431). */
  canReview: boolean
  /** Сколько комментариев оставил Lead Carpenter (BAS-1513). */
  comments: number
  onOpen: () => void
}) {
  const time = task.sched_start && task.sched_end
    ? `${minToAmPm(hhmmToMin(task.sched_start))} – ${minToAmPm(hhmmToMin(task.sched_end))}`
    : '—'
  const done = task.execution_status === 'closed' || task.execution_status === 'completed'
  const badge = executionBadge(task)
  // Complete — действие Lead Carpenter; Review — PM открывает задачу, чтобы проверить и закрыть.
  const actionLabel =
    mode === 'crew' && !done ? 'Complete' : canReview && task.execution_status !== 'closed' ? 'Review' : 'Details'

  return (
    <Card className="p-3 sm:p-4">
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
              {mode === 'pm' && !task.pm_email && hasNoAuthor(task) && <Badge className="bg-gray-100 text-gray-500">no author</Badge>}
              <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
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
        <div className="flex items-center gap-2">
          {onMove && (
            <Button variant="outline" onClick={onMove} title="Carry the task to the day the work will be done">
              Push to another day
            </Button>
          )}
          <Button variant={actionLabel === 'Details' ? 'subtle' : 'amber'} onClick={onOpen}>
            {actionLabel}
          </Button>
        </div>
      </div>
    </Card>
  )
}

/* ---------------- Модалка задачи ---------------- */

/**
 * Детали задачи. `canAct` — действия исполнения (Complete, заметка, фото): только Lead Carpenter
 * своей бригады. `canReview` — PM: комментарии и закрытие задачи (BAS-1431). Окончательный
 * запрет — в функциях БД.
 */
export function TaskDetailsModal({ task, canAct, canReview, onClose, onCloseTask }: {
  task: Task
  canAct: boolean
  canReview: boolean
  onClose: () => void
  /** Открыть окно закрытия (Task Accepted). */
  onCloseTask: () => void
}) {
  const qc = useQueryClient()
  const [note, setNote] = useState('')
  const [reviewNote, setReviewNote] = useState('')
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

  // Комментарий PM: отдельной записью журнала, без смены статуса; бригада видит его здесь же.
  const addReview = useMutation({
    mutationFn: () => addReviewComment(task.id, reviewNote),
    onSuccess: () => { setReviewNote(''); setErr(null); invalidate() },
    onError,
  })
  const addNote = useMutation({
    mutationFn: () => addTaskNote(task.id, note),
    onSuccess: () => { setNote(''); setErr(null); invalidate() },
    onError,
  })
  // BAS-1442: фото грузятся по одному — на телефоне 10 фото разом съедают память; прогресс
  // «2 of 5», ошибка по конкретному файлу, остальные всё равно загружаются.
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null)
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const failed: string[] = []
      setUploadProgress({ done: 0, total: files.length })
      for (const [i, f] of files.entries()) {
        try {
          await uploadTaskPhoto(task.id, f)
        } catch (e) {
          failed.push(`${f.name}: ${errMsg(e)}`)
        }
        setUploadProgress({ done: i + 1, total: files.length })
        // каждое загруженное фото видно сразу, не дожидаясь остальных
        void qc.invalidateQueries({ queryKey: ['tp-task-photos', task.id] })
      }
      if (failed.length) {
        throw new Error(`${failed.length} of ${files.length} photo(s) were not uploaded — ${failed.join('; ')}`)
      }
    },
    onSuccess: () => { setErr(null); invalidate() },
    onError: (e: unknown) => { onError(e); invalidate() },
    onSettled: () => setUploadProgress(null),
  })
  // Удалить фото — бригада, пока задача не закрыта; проверка ещё и в БД (0033).
  const canRemovePhotos = canAct && task.execution_status !== 'closed'
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

  const canComplete = canAct && task.execution_status === 'pending'
  const canClose = canReview && task.execution_status !== 'closed'
  const badge = executionBadge(task)

  return (
    <>
      <Modal
        open
        title="Task Details"
        subtitle={task.title || task.description}
        onClose={onClose}
        // Кнопки «Close» нет: рядом с Close task она путала («закрыть окно» или «закрыть задачу»).
        // Окно закрывается крестиком или кликом вне него.
        closeIcon
        footer={
          canComplete || canClose ? (
          <>
            {canComplete && (
              <Button variant="amber" disabled={complete.isPending} onClick={() => complete.mutate()}>
                {complete.isPending ? 'Saving…' : 'Complete'}
              </Button>
            )}
            {canClose && (
              <Button variant="green" onClick={onCloseTask}>
                Close task
              </Button>
            )}
          </>
          ) : undefined
        }
      >
        <div className="space-y-5">
          <div className="flex items-center gap-2">
            <Button variant="outline" className="text-gray-600" onClick={() => setHistoryOpen(true)}>
              <Info size={16} /> info
            </Button>
            <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
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
            {canReview && (
              <>
                <Textarea className="mt-3" rows={3} placeholder="Comment for the crew…"
                  value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} />
                <Button
                  variant="outline"
                  className="mt-2 w-full"
                  disabled={!reviewNote.trim() || addReview.isPending}
                  onClick={() => addReview.mutate()}
                >
                  {addReview.isPending ? 'Saving…' : 'Add comment'}
                </Button>
                <p className="mt-1 text-xs text-gray-500">Comments cannot be edited or deleted. The crew sees them on the task.</p>
              </>
            )}
          </div>

          <div>
            <h4 className="mb-2 font-semibold text-gray-900">Photos</h4>
            {canAct && task.execution_status !== 'closed' && (
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-brand-amber px-3.5 py-2 text-sm font-medium text-black transition hover:brightness-95">
              <Upload size={16} />
              {upload.isPending
                ? `Uploading${uploadProgress && uploadProgress.total > 1 ? ` ${Math.min(uploadProgress.done + 1, uploadProgress.total)} of ${uploadProgress.total}` : ''}…`
                : 'Upload Photos'}
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

/* ---------------- Закрытие задачи (PM) ---------------- */

/**
 * Закрытие задачи PM (BAS-1431): отметка Task Accepted (по умолчанию стоит) и необязательный
 * комментарий. Исход один — задача закрыта; «не принято» дальше предлагает новую задачу.
 */
function CloseTaskModal({ task, onCancel, onClosed }: {
  task: Task
  onCancel: () => void
  onClosed: (accepted: boolean) => void
}) {
  const [accepted, setAccepted] = useState(true)
  const [comment, setComment] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const send = useMutation({
    mutationFn: () => closeTask(task.id, accepted, comment.trim() || undefined),
    onSuccess: () => onClosed(accepted),
    onError: (e: unknown) => setErr(errMsg(e)),
  })

  return (
    <Modal
      open
      title="Close task"
      subtitle={task.title || task.description}
      onClose={onCancel}
      size="sm"
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="green" disabled={send.isPending} onClick={() => send.mutate()}>
            {send.isPending ? 'Closing…' : 'Close task'}
          </Button>
        </>
      }
    >
      {err && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">⚠ {err}</div>}
      {task.execution_status === 'pending' && (
        <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-amber-800">
          The crew has not marked this task as complete.
        </p>
      )}
      <label className="mb-3 flex cursor-pointer items-center gap-2 font-medium text-gray-900">
        <input type="checkbox" className="h-4 w-4" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
        Task Accepted
      </label>
      <Textarea rows={3} placeholder="Comment for the crew (optional)…" value={comment} onChange={(e) => setComment(e.target.value)} />
      <p className="mt-2 text-xs text-gray-500">
        A closed task cannot be reopened.{!accepted && ' Next you can create a task for another day.'}
      </p>
    </Modal>
  )
}

/* ---------------- История ---------------- */

/**
 * Лента `tp_task_events`: отметка бригадира, закрытие PM, комментарии обеих сторон и фото —
 * в одном месте и в одном порядке.
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
