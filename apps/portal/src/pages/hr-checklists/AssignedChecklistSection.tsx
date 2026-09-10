import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  ChevronDown, ChevronRight, ExternalLink, Eye, FileText, Image as ImageIcon,
  FileDown, Pencil, SquarePlus, Target, Trash2, Upload,
} from 'lucide-react'
import { Button, Card, Modal, Textarea } from '../../components/ui'
import { generateEmployeeChecklistPdf } from './ChecklistPDF'
import { PdfDialog } from './EmployeeChecklists'
import { cn, errMsg } from '../../lib/utils'
import { useUnsavedGuard } from '../../lib/useUnsavedGuard'
import { ThreeStateCheckbox } from './ThreeStateCheckbox'
import {
  addChecklistPhoto,
  assignmentPhotoUrl,
  deleteChecklistPhoto,
  itemPhotoUrl,
  listChecklistPhotos,
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
  flatten,
  nextTriState,
  type Checklist,
  type Employee,
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
  standalone = false,
  employee,
}: {
  employeeId: string
  assignment: EmployeeChecklist
  checklist: Checklist | null
  allProgress: ProgressRow[]
  onProgressChanged: () => void
  onUnassigned: () => void
  /**
   * Развёрнутый вид на собственной странице: крупная шапка с прогрессом и тумблерами
   * вместо строки-аккордеона. В списке назначенных чек-листов секция остаётся свёрнутой —
   * там их несколько, и разворачивать все сразу нечитаемо.
   */
  standalone?: boolean
  /** Нужен для PDF по этому чек-листу (кнопка в шапке standalone-вида). */
  employee?: Employee
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

  /**
   * Прогресс — как в исходной версии, сверено по данным (34 узла → «17 of 32 · 53%»):
   *
   *  1. считаем ВСЕ узлы дерева, а не только листья: родительский пункт — такая же
   *     строка, у него есть собственная запись прогресса;
   *  2. статус берём из СВОЕЙ строки узла (`triOf`), а не производный от детей
   *     (`displayState`) — иначе отмеченный вручную родитель не попадёт в числитель;
   *  3. N/A убираем из знаменателя: «неприменимо» — это не задача, которую можно
   *     выполнить. Отсюда 32 вместо 34;
   *  4. выполненным считается только `completed`, N/A выполнением не является.
   */
  const allNodes = useMemo(() => tree.flatMap(flatten), [tree])
  const countedNodes = allNodes.filter((n) => triOf(n.task_id) !== 'not_applicable')
  const doneCount = countedNodes.filter((n) => triOf(n.task_id) === 'checked').length
  const percent = countedNodes.length ? Math.round((doneCount / countedNodes.length) * 100) : 0

  // «Hide N/A Items» — убрать с глаз пункты, помеченные как неприменимые: в длинном
  // чек-листе они шумят, но остаются в прогрессе (N/A считается пройденным).
  const [hideNA, setHideNA] = useState(false)
  // «Hide Checklist» — свернуть список, оставив только прогресс.
  const [hideList, setHideList] = useState(false)

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
  const [showPdf, setShowPdf] = useState(false)

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

  const body = (
    <>
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
              hideNA={hideNA}
            />
          ))}
        </div>
      )}

      {!standalone && (
        <div className="mt-4 border-t border-gray-100 pt-3">
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-400">
            Checklist notes
          </label>
          <AssignmentNotes assignmentId={assignment.id} initial={assignment.notes ?? ''} />
        </div>
      )}

      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
    </>
  )

  if (standalone) {
    return (
      <>
        <Card className="mb-4 p-6">
          <div className="mb-1 flex flex-wrap items-start justify-between gap-4">
            <h1 className="text-2xl font-bold text-gray-900">{checklist?.name ?? 'Checklist'}</h1>
            <div className="flex items-center gap-5">
              <Toggle label="Hide N/A Items" icon value={hideNA} onChange={setHideNA} />
              <Toggle label="Hide Checklist" value={hideList} onChange={setHideList} />
              {employee && (
                <Button variant="subtle" onClick={() => setShowPdf(true)} title="PDF for this checklist only">
                  <FileDown size={15} /> PDF
                </Button>
              )}
            </div>
          </div>
          {checklist?.description && <p className="mb-5 text-sm text-gray-500">{checklist.description}</p>}

          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-sm font-medium text-gray-700">
              <Target size={16} className="text-brand-blue" /> Checklist Progress
            </span>
            <span className="text-sm text-gray-500">
              {doneCount} of {countedNodes.length} tasks{' '}
              <span className="ml-1 text-base font-bold text-brand-blue">{percent}%</span>
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
            <div
              className={cn('h-full rounded-full transition-all', percent === 100 ? 'bg-green-500' : 'bg-brand-blue')}
              style={{ width: `${percent}%` }}
            />
          </div>
        </Card>

        {!hideList && (
          <Card className="overflow-hidden">
            <div className="px-5 py-4">{body}</div>
            <NotesAndPhotos assignmentId={assignment.id} initialNotes={assignment.notes ?? ''} />
          </Card>
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

        {/* PDF по ОДНОМУ чек-листу: общий отчёт по сотруднику остаётся в PDF-кнопке
            на списке, а здесь выгружается только этот. */}
        {showPdf && employee && checklist && (
          <PdfDialog
            onClose={() => setShowPdf(false)}
            onGenerate={async (completedBy) => {
              await generateEmployeeChecklistPdf({
                employee,
                assignments: [{ checklist_id: assignment.checklist_id }],
                checklistById: new Map([[checklist.id, checklist]]),
                progress: allProgress,
                completedBy,
                dateStr: new Date().toLocaleDateString('en-US'),
              })
              setShowPdf(false)
            }}
          />
        )}
      </>
    )
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
            {doneCount}/{countedNodes.length} · {percent}%
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
  hideNA = false,
}: {
  node: ItemNode
  depth: number
  displayState: (n: ItemNode) => TriState
  triOf: (taskId: string) => TriState
  states: Record<string, TaskState>
  onToggle: (n: ItemNode) => void
  onAnswer: (n: ItemNode, a: string) => void
  onNotes: (n: ItemNode) => void
  hideNA?: boolean
}) {
  // Скрываем целиком узел, помеченный N/A: для родителя displayState = not_applicable
  // только когда ВСЕ его листья неприменимы, так что ветка с живыми пунктами не пропадёт.
  // N/A — это `is_not_applicable` в собственной строке прогресса пункта: тот же признак,
  // по которому он отображается серым и вычитается из знаменателя. Прячем по нему же,
  // а не по производному состоянию, иначе ветка со «своими» живыми пунктами исчезала бы
  // целиком только потому, что все её дети неприменимы.
  if (hideNA && triOf(node.task_id) === 'not_applicable') return null
  const isLeaf = node.children.length === 0
  const st = states[node.task_id]
  const state = displayState(node)
  const ownState = triOf(node.task_id)
  const hasNote = !!(st?.notes || (st?.photos?.length ?? 0) > 0)
  const options = isLeaf ? node.answer_options ?? [] : []

  return (
    <div>
      <div className="flex items-start gap-2 py-1.5" style={{ paddingLeft: depth * 20 }}>
        <div className="mt-0.5">
          <ThreeStateCheckbox state={state} onClick={() => onToggle(node)} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span
              className={cn(
                'text-sm',
                isLeaf ? 'text-gray-800' : 'font-semibold text-gray-900',
                // выполненное и неприменимое зачёркиваем — так же, как в исходной версии
                state !== 'unchecked' && 'text-gray-400 line-through',
                ownState === 'not_applicable' && 'text-gray-400',
              )}
            >
              {node.label}
            </span>

            {/* Кнопка заметок стоит сразу за текстом, а не у правого края: в исходной
                версии она часть строки, и глаз не бегает через всю ширину. */}
            {isLeaf && (
              <button
                onClick={() => onNotes(node)}
                className={cn(
                  'shrink-0 rounded transition',
                  hasNote ? 'text-accent-600' : 'text-gray-300 hover:text-gray-500',
                )}
                title="Notes & photos"
              >
                <SquarePlus size={16} />
              </button>
            )}

            {/* Индикаторы: у пункта есть заметка или фото. */}
            {isLeaf && (st?.notes || (st?.photos?.length ?? 0) > 0) && (
              <span className="flex shrink-0 items-center gap-1.5">
                {st?.notes && <FileText size={14} className="text-red-500" />}
                {(st?.photos?.length ?? 0) > 0 && <ImageIcon size={14} className="text-red-500" />}
              </span>
            )}

            {/* Ссылки пункта (`links` в модели) — были в данных, но на экран не выводились. */}
            {(node.links ?? []).map((l, i) => (
              <a
                key={i}
                href={l.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex shrink-0 items-center gap-1 text-sm font-medium uppercase text-red-500 hover:text-red-700 hover:underline"
              >
                {l.label}
                <ExternalLink size={13} />
              </a>
            ))}
          </div>
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
        </div>
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
          hideNA={hideNA}
        />
      ))}
    </div>
  )
}

/* ---------------- assignment-level notes ---------------- */

/**
 * Заметки по назначению. Сохраняются по `onBlur` — но если человек печатает и сразу
 * закрывает вкладку или жмёт F5, blur не случается и текст пропадает. Поэтому: следим
 * за несохранённым, при уходе со страницы дописываем сами, при перезагрузке спрашиваем.
 */
function AssignmentNotes({ assignmentId, initial }: { assignmentId: string; initial: string }) {
  const [notes, setNotes] = useState(initial)
  const [saving, setSaving] = useState(false)
  const savedRef = useRef(initial)
  const notesRef = useRef(initial)
  notesRef.current = notes

  const save = async () => {
    if (notesRef.current === savedRef.current) return
    setSaving(true)
    try {
      await updateAssignmentNotes(assignmentId, notesRef.current)
      savedRef.current = notesRef.current
    } finally {
      setSaving(false)
    }
  }

  useUnsavedGuard(
    () => notesRef.current !== savedRef.current,
    () => void save(),
  )

  // Уход со страницы — дописываем молча, спрашивать не о чем.
  useEffect(() => () => void save(), [])

  return (
    <Textarea
      rows={2}
      value={notes}
      onChange={(e) => setNotes(e.target.value)}
      disabled={saving}
      placeholder="General notes for this checklist…"
      onBlur={() => void save()}
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

/** Переключатель как в оригинале: подпись слева, тумблер справа. */
function Toggle({
  label, value, onChange, icon,
}: { label: string; value: boolean; onChange: (v: boolean) => void; icon?: boolean }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-gray-600">
      {icon && <Eye size={15} className="text-gray-400" />}
      {label}
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className={cn(
          'relative inline-flex h-5 w-9 items-center rounded-full transition',
          value ? 'bg-brand-blue' : 'bg-gray-200',
        )}
      >
        <span className={cn('inline-block h-3.5 w-3.5 rounded-full bg-white transition', value ? 'translate-x-5' : 'translate-x-1')} />
      </button>
    </label>
  )
}

/**
 * Блок «Notes & Photos» под чек-листом: общие заметки по назначению и фото.
 *
 * Данные для этого были в сервисе с самого начала (`checklist_photos` + бакет
 * `checklist-photos`), но на экран не выводились — виден был только текст заметок.
 */
function NotesAndPhotos({ assignmentId, initialNotes }: { assignmentId: string; initialNotes: string }) {
  const [hidden, setHidden] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const photosQ = useQuery({
    queryKey: ['hr-assignment-photos', assignmentId],
    queryFn: () => listChecklistPhotos(assignmentId),
  })

  async function upload(file: File) {
    setBusy(true)
    setErr(null)
    try {
      await addChecklistPhoto(assignmentId, file)
      await photosQ.refetch()
    } catch (e) {
      setErr(errMsg(e))
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const photos = photosQ.data ?? []

  return (
    <div className="border-t border-gray-100 bg-gray-50/60 px-5 py-4">
      <div className="flex items-center justify-between gap-4">
        <h3 className="font-semibold text-gray-900">Notes &amp; Photos</h3>
        <Toggle label="Hide Notes & Photos" icon value={hidden} onChange={setHidden} />
      </div>

      {!hidden && (
        <>
          <div className="mt-3">
            <AssignmentNotes assignmentId={assignmentId} initial={initialNotes} />
          </div>

          <div className="mt-4 flex items-center justify-between gap-3 border-t border-gray-200 pt-3">
            <span className="flex items-center gap-2 text-sm font-medium text-gray-700">
              <ImageIcon size={15} className="text-gray-400" /> Photos ({photos.length})
            </span>
            <Button variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>
              <Upload size={15} /> {busy ? 'Uploading…' : 'Upload Photo'}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) upload(f)
              }}
            />
          </div>

          {err && <p className="mt-2 text-sm text-red-600">{err}</p>}

          {photos.length === 0 ? (
            <p className="py-4 text-center text-sm text-gray-400">No photos uploaded yet</p>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              {photos.map((ph) => (
                <div key={ph.id} className="group relative">
                  <a href={assignmentPhotoUrl(ph.file_path)} target="_blank" rel="noreferrer">
                    <img
                      src={assignmentPhotoUrl(ph.file_path)}
                      alt={ph.file_name}
                      className="h-20 w-20 rounded-md border border-gray-200 object-cover"
                    />
                  </a>
                  <button
                    type="button"
                    aria-label="Delete photo"
                    onClick={async () => {
                      await deleteChecklistPhoto(ph.id, ph.file_path)
                      photosQ.refetch()
                    }}
                    className="absolute -right-1.5 -top-1.5 hidden rounded-full bg-red-500 p-0.5 text-white group-hover:block"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
