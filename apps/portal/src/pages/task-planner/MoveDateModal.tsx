import { useEffect, useState } from 'react'
import { UsTimeInput } from '../../components/UsTimeInput'
import { Anchor } from 'lucide-react'
import { Button, Input, Modal } from '../../components/task-planner-ui'
import { shiftDay } from '../../domain/task-planner/own-side'
import { hhmmToMin, minToAmPm } from '../../lib/task-planner-time'
import type { Task } from '../../domain/task-planner/types'

type AnchorChoice = 'keep' | 'change' | 'remove'

/**
 * Выбор даты переноса (BAS-1437). У задачи с якорем (Exact time) сразу предлагаем решить, что с
 * временем на новом дне (BAS-1436): оставить, поменять или снять. «Оставить» — задача придёт
 * в Requested с пометкой «проверить время».
 * onMove: anchor не передан — время прежнее; '' — снять якорь; 'HH:MM' — новое время.
 */
export function MoveDateModal({ task, pending, defaultDate, onClose, onMove }: {
  task: Task | null
  pending: boolean
  /** Дата по умолчанию; без неё — следующий день после даты задачи. */
  defaultDate?: string
  onClose: () => void
  onMove: (date: string, anchor?: string) => void
}) {
  const [date, setDate] = useState('')
  const [choice, setChoice] = useState<AnchorChoice>('keep')
  const [time, setTime] = useState('')
  const anchorTime = task?.anchor ? (task.anchor_time || task.exact_time || '') : ''
  useEffect(() => {
    if (!task) return
    setDate(defaultDate ?? shiftDay(task.scheduled_date, 1))
    setChoice('keep')
    setTime(task.anchor ? (task.anchor_time || task.exact_time || '') : '')
  }, [task, defaultDate])

  const timeOk = choice !== 'change' || /^\d{2}:\d{2}$/.test(time)
  const submit = () => {
    if (choice === 'change') onMove(date, time)
    else if (choice === 'remove') onMove(date, '')
    else onMove(date)
  }
  const option = (value: AnchorChoice, label: string) => (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700">
      <input type="radio" name="anchor-choice" checked={choice === value} onChange={() => setChoice(value)} />
      {label}
    </label>
  )

  return (
    <Modal open={!!task} title="Push to another day" onClose={onClose}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!date || pending || date === task?.scheduled_date || !timeOk} onClick={submit}>
          {pending ? 'Moving…' : `Move to ${date || '…'}`}
        </Button>
      </>}>
      <p className="mb-3 text-sm text-gray-600">
        <b className="text-gray-900">{task?.title ?? task?.description}</b> goes back to Requested on the new day.
        The crew and time window return to what was requested; the AI placement is dropped.
      </p>
      <label className="mb-1 block text-xs font-medium text-gray-500">New day{defaultDate ? '' : ' (next day by default)'}</label>
      <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />

      {task?.anchor && (
        <div className="mt-4 rounded-lg border border-accent-200 bg-accent-50 p-3">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-medium text-accent-800">
            <Anchor size={14} /> This task has an exact time{anchorTime ? `: ${minToAmPm(hhmmToMin(anchorTime))}` : ''}. Does it still fit the new day?
          </p>
          <div className="space-y-1.5">
            {option('keep', 'Keep the time — check it later in Requested')}
            <div className="flex flex-wrap items-center gap-2">
              {option('change', 'New time')}
              {choice === 'change' && <UsTimeInput value={time} onChange={setTime} />}
            </div>
            {option('remove', 'No exact time — AI picks the time')}
          </div>
        </div>
      )}
      <p className="mt-2 text-xs text-gray-400">You will have 5 seconds to undo.</p>
    </Modal>
  )
}
