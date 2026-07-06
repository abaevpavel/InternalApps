import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, MessageSquare, Pencil, Trash2, Upload } from 'lucide-react'
import { Button, Card, Modal, Textarea } from '../../components/ui'
import { cn, errMsg } from '../../lib/utils'
import { ThreeStateCheckbox } from './ThreeStateCheckbox'
import {
  itemPhotoUrl,
  listItems,
  setManyTaskStates,
  unassignChecklist,
  updateAssignmentNotes,
  uploadItemPhoto,
  upsertProgress,
} from '../../services/hr-checklists'
import {
  buildTree,
  collectLeaves,
  nextTriState,
  type Checklist,
  type EmployeeChecklist,
  type ItemNode,
  type ProgressRow,
  type TriState,
} from '../../domain/hr-checklists'

/** Локальное состояние задачи (подмножество ProgressRow). */
interface TaskState {
  completed: boolean
  is_not_applicable: boolean
  selected_answer: string | null
  notes: string | null
  photos: string[]
}

export function AssignedChecklistSection({
  employeeId,
  assignment,
  checklist,
  allProgress,
  onProgressChanged,
  onUnassigned,
}: {
  employeeId: string
  assignment: EmployeeChecklist
  checklist: Checklist | null
  allProgress: ProgressRow[]
  onProgressChanged: () => void
  onUnassigned: () => void
}) {
  const nav = useNavigate()
  const phase = assignment.checklist_id // для динамических чек-листов phase = checklistId

  const itemsQ = useQuery({ queryKey: ['hr-items', assignment.checklist_id], queryFn: () => listItems(assignment.checklist_id) })
  const tree = useMemo(() => buildTree(itemsQ.data ?? []), [itemsQ.data])
  const leaves = useMemo(() => tree.flatMap(collectLeaves), [tree])

  // локальная карта прогресса task_id → TaskState (сид из БД по фазе этого чек-листа)
  const [states, setStates] = useState<Record<string, TaskState>>({})
  useEffect(() => {
    const map: Record<string, TaskState> = {}
    for (const p of allProgress) {
      if (p.phase !== phase) continue
      map[p.task_id] = {
        completed: !!p.completed,
        is_not_applicable: !!p.is_not_applicable,
        selected_answer: p.selected_answer,
        notes: p.notes,
        photos: p.photos ?? [],
      }
    }
    setStates(map)
  }, [allProgress, phase])

  const triOf = (taskId: string): TriState => {
    const s = states[taskId]
    if (!s) return 'unchecked'
    if (s.is_not_applicable) return 'not_applicable'
    if (s.completed) return 'checked'
    return 'unchecked'
  }

  /** Отображаемое состояние узла: лист = своё; родитель = производное от листьев. */
  const displayState = (node: ItemNode): TriState => {
    if (!node.children.length) return triOf(node.task_id)
    const ls = collectLeaves(node)
    const stt = ls.map((l) => triOf(l.task_id))
    if (stt.every((s) => s === 'not_applicable')) return 'not_applicable'
    if (stt.every((s) => s !== 'unchecked') && stt.some((s) => s === 'checked')) return 'checked'
    return 'unchecked'
  }

  const doneCount = leaves.filter((l) => triOf(l.task_id) !== 'unchecked').length
  const percent = leaves.length ? Math.round((doneCount / leaves.length) * 100) : 0

  // авто-сворачивание при 100% (одноразово)
  const [open, setOpen] = useState(true)
  const autoCollapsed = useRef(false)
  useEffect(() => {
    if (percent === 100 && !autoCollapsed.current) {
      autoCollapsed.current = true
      setOpen(false)
    }
  }, [percent])

  const [err, setErr] = useState<string | null>(null)
  const [notesTask, setNotesTask] = useState<ItemNode | null>(null)

  // каскад: клик по узлу → состояние всех листьев поддерева
  async function toggle(node: ItemNode) {
    const next = nextTriState(displayState(node))
    const targets = collectLeaves(node)
    const ids = targets.map((t) => t.task_id)
    setStates((prev) => {
      const n = { ...prev }
      for (const id of ids)
        n[id] = {
          completed: next === 'checked',
          is_not_applicable: next === 'not_applicable',
          selected_answer: n[id]?.selected_answer ?? null,
          notes: n[id]?.notes ?? null,
          photos: n[id]?.photos ?? [],
        }
      return n
    })
    try {
      await setManyTaskStates(employeeId, phase, ids, next)
      onProgressChanged()
    } catch (e) {
      setErr(errMsg(e))
    }
  }

  async function setAnswer(node: ItemNode, answer: string) {
    setStates((prev) => ({ ...prev, [node.task_id]: { ...blank(prev[node.task_id]), selected_answer: answer } }))
    try {
      await upsertProgress(employeeId, node.task_id, phase, { selected_answer: answer })
      onProgressChanged()
    } catch (e) {
      setErr(errMsg(e))
    }
  }

  async function saveTaskNotes(taskId: string, notes: string, photos: string[]) {
    setStates((prev) => ({ ...prev, [taskId]: { ...blank(prev[taskId]), notes, photos } }))
    try {
      await upsertProgress(employeeId, taskId, phase, { notes, photos })
      onProgressChanged()
    } catch (e) {
      setErr(errMsg(e))
    }
  }

  return (
    <Card className={cn('overflow-hidden', percent === 100 && 'border-green-200')}>
      <div className={cn('flex items-center gap-3 px-5 py-3', percent === 100 ? 'bg-green-50/60' : 'bg-gray-50')}>
        <button onClick={() => setOpen((v) => !v)} className="text-gray-400 hover:text-gray-700">
          {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-gray-900">{checklist?.name ?? 'Checklist'}</div>
          <div className="text-xs text-gray-500">
            {doneCount}/{leaves.length} · {percent}%
          </div>
        </div>
        <div className="h-1.5 w-28 overflow-hidden rounded-full bg-gray-200">
          <div className="h-full rounded-full bg-green-500 transition-all" style={{ width: `${percent}%` }} />
        </div>
        <Button variant="ghost" title="Edit template" onClick={() => nav(`/checklist/${assignment.checklist_id}`)}>
          <Pencil size={16} />
        </Button>
        <Button
          variant="ghost"
          className="text-red-600"
          title="Remove assignment"
          onClick={async () => {
            try {
              await unassignChecklist(assignment.id)
              onUnassigned()
            } catch (e) {
              setErr(errMsg(e))
            }
          }}
        >
          <Trash2 size={16} />
        </Button>
      </div>

      {open && (
        <div className="px-5 py-3">
          {itemsQ.isLoading ? (
            <div className="py-4 text-center text-sm text-gray-400">Loading…</div>
          ) : tree.length === 0 ? (
            <div className="py-4 text-center text-sm text-gray-400">This checklist has no items.</div>
          ) : (
            <div>
              {tree.map((n) => (
                <TaskRow
                  key={n.id}
                  node={n}
                  depth={0}
                  displayState={displayState}
                  triOf={triOf}
                  states={states}
                  onToggle={toggle}
                  onAnswer={setAnswer}
                  onNotes={setNotesTask}
                />
              ))}
            </div>
          )}

          {/* заметки на уровне назначения */}
          <div className="mt-4 border-t border-gray-100 pt-3">
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-400">
              Checklist notes
            </label>
            <AssignmentNotes assignmentId={assignment.id} initial={assignment.notes ?? ''} />
          </div>

          {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
        </div>
      )}

      {notesTask && (
        <TaskNotesDialog
          node={notesTask}
          state={states[notesTask.task_id]}
          onClose={() => setNotesTask(null)}
          onSave={(notes, photos) => {
            saveTaskNotes(notesTask.task_id, notes, photos)
            setNotesTask(null)
          }}
        />
      )}
    </Card>
  )
}

function blank(s?: TaskState): TaskState {
  return {
    completed: s?.completed ?? false,
    is_not_applicable: s?.is_not_applicable ?? false,
    selected_answer: s?.selected_answer ?? null,
    notes: s?.notes ?? null,
    photos: s?.photos ?? [],
  }
}

/* ---------------- recursive task row ---------------- */

function TaskRow({
  node,
  depth,
  displayState,
  triOf,
  states,
  onToggle,
  onAnswer,
  onNotes,
}: {
  node: ItemNode
  depth: number
  displayState: (n: ItemNode) => TriState
  triOf: (taskId: string) => TriState
  states: Record<string, TaskState>
  onToggle: (n: ItemNode) => void
  onAnswer: (n: ItemNode, a: string) => void
  onNotes: (n: ItemNode) => void
}) {
  const isLeaf = node.children.length === 0
  const st = states[node.task_id]
  const hasNote = !!(st?.notes || (st?.photos?.length ?? 0) > 0)
  const options = isLeaf ? node.answer_options ?? [] : []

  return (
    <div>
      <div className="flex items-start gap-2 py-1.5" style={{ paddingLeft: depth * 20 }}>
        <div className="mt-0.5">
          <ThreeStateCheckbox state={displayState(node)} onClick={() => onToggle(node)} />
        </div>
        <div className="min-w-0 flex-1">
          <div className={cn('text-sm', isLeaf ? 'text-gray-800' : 'font-semibold text-gray-900')}>{node.label}</div>
          {node.description && <div className="text-xs text-gray-500">{node.description}</div>}
          {options.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {options.map((opt, i) => {
                const sel = st?.selected_answer === opt
                return (
                  <button
                    key={opt}
                    onClick={() => onAnswer(node, opt)}
                    className={cn(
                      'rounded-md border px-2.5 py-0.5 text-xs font-medium transition',
                      sel
                        ? i === 0
                          ? 'border-green-500 bg-green-500 text-white'
                          : i === 1
                            ? 'border-red-500 bg-red-500 text-white'
                            : 'border-gray-500 bg-gray-500 text-white'
                        : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50',
                    )}
                  >
                    {opt}
                  </button>
                )
              })}
            </div>
          )}
          {node.links && node.links.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-3">
              {node.links.map((l, i) => (
                <a key={i} href={l.url} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline">
                  {l.label || l.url}
                </a>
              ))}
            </div>
          )}
        </div>
        {isLeaf && (
          <button
            onClick={() => onNotes(node)}
            className={cn('shrink-0 rounded p-1 hover:bg-gray-100', hasNote ? 'text-accent-600' : 'text-gray-300 hover:text-gray-500')}
            title="Notes & photos"
          >
            <MessageSquare size={15} />
          </button>
        )}
      </div>
      {node.children.map((c) => (
        <TaskRow
          key={c.id}
          node={c}
          depth={depth + 1}
          displayState={displayState}
          triOf={triOf}
          states={states}
          onToggle={onToggle}
          onAnswer={onAnswer}
          onNotes={onNotes}
        />
      ))}
    </div>
  )
}

/* ---------------- assignment-level notes ---------------- */

function AssignmentNotes({ assignmentId, initial }: { assignmentId: string; initial: string }) {
  const [notes, setNotes] = useState(initial)
  const [saving, setSaving] = useState(false)
  return (
    <Textarea
      rows={2}
      value={notes}
      onChange={(e) => setNotes(e.target.value)}
      disabled={saving}
      placeholder="General notes for this checklist…"
      onBlur={async () => {
        if (notes === initial) return
        setSaving(true)
        try {
          await updateAssignmentNotes(assignmentId, notes)
        } finally {
          setSaving(false)
        }
      }}
    />
  )
}

/* ---------------- per-task notes & photos ---------------- */

function TaskNotesDialog({
  node,
  state,
  onClose,
  onSave,
}: {
  node: ItemNode
  state: TaskState | undefined
  onClose: () => void
  onSave: (notes: string, photos: string[]) => void
}) {
  const [notes, setNotes] = useState(state?.notes ?? '')
  const [photos, setPhotos] = useState<string[]>(state?.photos ?? [])
  const [uploading, setUploading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true)
    setErr(null)
    try {
      const name = await uploadItemPhoto(file, node.task_id)
      setPhotos((p) => [...p, name])
    } catch (x) {
      setErr(errMsg(x))
    } finally {
      setUploading(false)
    }
  }

  return (
    <Modal
      open
      title="Notes & photos"
      subtitle={node.label}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onSave(notes.trim(), photos)}>
            Save Changes
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes…" autoFocus />
        <div className="flex flex-wrap gap-3">
          {photos.map((name, i) => (
            <div key={i} className="relative">
              <img src={itemPhotoUrl(name)} alt="" className="h-20 w-20 rounded-lg border border-gray-200 object-cover" />
              <button
                onClick={() => setPhotos((arr) => arr.filter((_, j) => j !== i))}
                className="absolute -right-2 -top-2 rounded-full bg-red-500 p-1 text-white"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          <label className="flex h-20 w-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-gray-300 text-xs text-gray-400 hover:bg-gray-50">
            <Upload size={16} />
            {uploading ? 'Uploading…' : 'Add'}
            <input type="file" accept="image/*" className="hidden" onChange={pick} disabled={uploading} />
          </label>
        </div>
        {err && <p className="text-sm text-red-600">{err}</p>}
      </div>
    </Modal>
  )
}
