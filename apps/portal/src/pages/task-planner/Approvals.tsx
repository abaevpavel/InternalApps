/**
 * Task Planner — **Approvals**: очередь задач, которые бригадиры отметили выполненными.
 * Апрувер подтверждает (`approved` — задача закрыта) или возвращает на доработку
 * (`rework` — обязательно с комментарием, иначе бригадир не поймёт, что переделывать).
 *
 * Кто апрувит — решает БД (`tp_can_approve_task()`, сейчас портальный админ), UI лишь
 * зеркалит это гейтом роута. Когда заказчик определится (PM задачи / Planner Admin /
 * отдельная роль) — правится функция в БД и гейт здесь. См. docs/TASK-PLANNER-ROLES.md §5.4.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Info } from 'lucide-react'
import { Button, Card, Modal, PageTitle, Textarea } from '../../components/ui'
import { errMsg } from '../../lib/utils'
import { hhmmToMin, minToAmPm } from '../../lib/task-planner-time'
import type { Task } from '../../domain/task-planner/types'
import { approveTask, fetchTasksAwaitingApproval, reworkTask } from '../../services/task-planner/execution'
import { TaskHistoryModal } from './MyTasks'

export function ApprovalsPage() {
  const qc = useQueryClient()
  const [reworkFor, setReworkFor] = useState<Task | null>(null)
  const [historyFor, setHistoryFor] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const { data: tasks, isLoading, error } = useQuery({
    queryKey: ['tp-approvals'],
    queryFn: fetchTasksAwaitingApproval,
  })

  const refresh = () => qc.invalidateQueries({ queryKey: ['tp-approvals'] })

  const approve = useMutation({
    mutationFn: (id: string) => approveTask(id),
    onSuccess: () => { setErr(null); void refresh() },
    onError: (e: unknown) => setErr(errMsg(e)),
  })

  return (
    <>
      <PageTitle
        title="Approvals"
        subtitle="Tasks marked complete by crews. Approve to close them, or send them back with a comment."
      />

      {(err || error) && <Card className="mb-4 p-4 text-sm text-red-600">⚠ {err ?? errMsg(error)}</Card>}
      {isLoading && <Card className="p-8 text-center text-gray-500">Loading…</Card>}
      {!isLoading && (tasks ?? []).length === 0 && (
        <Card className="p-8 text-center text-gray-500">Nothing is waiting for approval.</Card>
      )}

      <div className="space-y-3">
        {(tasks ?? []).map((t) => (
          <Card key={t.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
            <div className="min-w-0">
              <div className="font-semibold text-gray-900">{t.title || t.description || 'Untitled task'}</div>
              <div className="mt-1 text-sm text-gray-600">
                {t.assigned_team_name && <>Crew: <b className="text-gray-900">{t.assigned_team_name}</b> · </>}
                Date: {t.scheduled_date}
                {t.sched_start && t.sched_end && (
                  <> · {minToAmPm(hhmmToMin(t.sched_start))} – {minToAmPm(hhmmToMin(t.sched_end))}</>
                )}
              </div>
              <div className="mt-1 text-xs text-gray-500">
                {t.project_name && <>Project: {t.project_name} · </>}
                {t.completed_at && <>Completed: {new Date(t.completed_at).toLocaleString('en-US')}</>}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={() => setHistoryFor(t.id)}>
                <Info size={16} /> History
              </Button>
              <Button variant="outline" className="text-red-600" onClick={() => setReworkFor(t)}>
                Send to rework
              </Button>
              <Button variant="green" disabled={approve.isPending} onClick={() => approve.mutate(t.id)}>
                Approve
              </Button>
            </div>
          </Card>
        ))}
      </div>

      {historyFor && <TaskHistoryModal taskId={historyFor} limit={10} onClose={() => setHistoryFor(null)} />}
      {reworkFor && (
        <ReworkModal
          task={reworkFor}
          onClose={() => setReworkFor(null)}
          onDone={() => { setReworkFor(null); void refresh() }}
        />
      )}
    </>
  )
}

function ReworkModal({ task, onClose, onDone }: { task: Task; onClose: () => void; onDone: () => void }) {
  const [comment, setComment] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const send = useMutation({
    mutationFn: () => reworkTask(task.id, comment),
    onSuccess: onDone,
    onError: (e: unknown) => setErr(errMsg(e)),
  })

  return (
    <Modal
      open
      title="Send back for rework"
      subtitle={task.title || task.description}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={!comment.trim() || send.isPending} onClick={() => send.mutate()}>
            {send.isPending ? 'Sending…' : 'Send to rework'}
          </Button>
        </>
      }
    >
      {err && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">⚠ {err}</div>}
      <p className="mb-2">Explain what has to be redone — the crew sees this comment in the task history.</p>
      <Textarea rows={4} placeholder="What needs to be fixed…" value={comment} onChange={(e) => setComment(e.target.value)} />
    </Modal>
  )
}
