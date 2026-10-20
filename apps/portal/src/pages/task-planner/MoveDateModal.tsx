import { useEffect, useState } from 'react'
import { Button, Input, Modal } from '../../components/task-planner-ui'
import { shiftDay } from '../../domain/task-planner/own-side'
import type { Task } from '../../domain/task-planner/types'

/** Выбор даты переноса (BAS-1437). */
export function MoveDateModal({ task, pending, onClose, onMove }: {
  task: Task | null
  pending: boolean
  onClose: () => void
  onMove: (date: string) => void
}) {
  const [date, setDate] = useState('')
  useEffect(() => { if (task) setDate(shiftDay(task.scheduled_date, 1)) }, [task])
  return (
    <Modal open={!!task} title="Push to another day" onClose={onClose}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!date || pending || date === task?.scheduled_date} onClick={() => onMove(date)}>
          {pending ? 'Moving…' : `Move to ${date || '…'}`}
        </Button>
      </>}>
      <p className="mb-3 text-sm text-gray-600">
        <b className="text-gray-900">{task?.title ?? task?.description}</b> goes back to Requested on the new day.
        The crew and time window return to what was requested; the AI placement is dropped.
      </p>
      <label className="mb-1 block text-xs font-medium text-gray-500">New day (next day by default)</label>
      <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <p className="mt-2 text-xs text-gray-400">You will have 5 seconds to undo.</p>
    </Modal>
  )
}
