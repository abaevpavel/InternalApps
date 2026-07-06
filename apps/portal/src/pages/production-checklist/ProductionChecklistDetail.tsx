import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArrowLeft, Eye, GripVertical, ImagePlus, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button, Card, Modal } from '../../components/ui'
import { cn, errMsg } from '../../lib/utils'
import { ItemEditDialog, type ItemPatch } from './ItemEditDialog'
import { ChecklistPreview } from './ProductionChecklistPreview'
import {
  createItem,
  deleteItemSubtree,
  extractChecklistFromImage,
  getTemplate,
  listItems,
  reorderItems,
  updateItem,
} from '../../services/production-checklist'
import { DEFAULT_ANSWERS, buildTree, type ChecklistItem, type ItemNode } from '../../domain/production-checklist'

/** Уникальный (в рамках шаблона) task_id из label + случайный хвост. */
function makeTaskId(label: string, existing: Set<string>): string {
  const slug = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item'
  let id = `${slug}-${crypto.randomUUID().slice(0, 4)}`
  while (existing.has(id)) id = `${slug}-${crypto.randomUUID().slice(0, 4)}`
  return id
}

export function TemplateEditorPage() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const qc = useQueryClient()

  const templateQ = useQuery({ queryKey: ['template', id], queryFn: () => getTemplate(id) })
  const itemsQ = useQuery({ queryKey: ['items', id], queryFn: () => listItems(id) })

  const items = itemsQ.data ?? []
  const tree = useMemo(() => buildTree(items), [items])
  const existingTaskIds = useMemo(() => new Set(items.map((i) => i.task_id)), [items])

  const [editing, setEditing] = useState<ChecklistItem | null>(null)
  const [preview, setPreview] = useState(false)
  const [importing, setImporting] = useState(false)

  const invalidate = () => qc.invalidateQueries({ queryKey: ['items', id] })

  const addBlockM = useMutation({
    mutationFn: () =>
      createItem({
        checklist_id: id,
        task_id: makeTaskId('block', existingTaskIds),
        label: 'New block',
        parent_id: null,
        sort_order: tree.length,
      }),
    onSuccess: invalidate,
  })

  const addQuestionM = useMutation({
    mutationFn: (block: ItemNode) =>
      createItem({
        checklist_id: id,
        task_id: makeTaskId('question', existingTaskIds),
        label: 'New question',
        parent_id: block.id,
        sort_order: block.children.length,
        answer_options: [...DEFAULT_ANSWERS],
      }),
    onSuccess: invalidate,
  })

  const saveM = useMutation({
    mutationFn: ({ itemId, patch }: { itemId: string; patch: ItemPatch }) => updateItem(itemId, patch),
    onSuccess: () => {
      invalidate()
      setEditing(null)
    },
  })

  const deleteM = useMutation({
    mutationFn: (itemId: string) => deleteItemSubtree(itemId, items),
    onSuccess: invalidate,
  })

  const reorderM = useMutation({
    mutationFn: (updates: { id: string; parent_id: string | null; sort_order: number }[]) => reorderItems(updates),
    onSuccess: invalidate,
  })

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  function onDragEnd(e: DragEndEvent, list: ItemNode[], parentId: string | null) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const oldIdx = list.findIndex((x) => x.id === active.id)
    const newIdx = list.findIndex((x) => x.id === over.id)
    if (oldIdx < 0 || newIdx < 0) return
    const reordered = arrayMove(list, oldIdx, newIdx)
    reorderM.mutate(reordered.map((x, i) => ({ id: x.id, parent_id: parentId, sort_order: i })))
  }

  if (templateQ.isLoading || itemsQ.isLoading) return <div className="p-10 text-gray-400">Loading…</div>

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <button onClick={() => nav('/production-checklist')} className="mb-6 inline-flex items-center gap-2 text-sm text-gray-500 hover:text-gray-800">
        <ArrowLeft size={16} /> Back
      </button>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{templateQ.data?.name ?? 'Template'}</h1>
          {templateQ.data?.description && <p className="mt-0.5 text-sm text-gray-500">{templateQ.data.description}</p>}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="subtle" onClick={() => setPreview(true)}>
            <Eye size={16} /> Preview
          </Button>
          <Button variant="subtle" onClick={() => setImporting(true)}>
            <ImagePlus size={16} /> Import from image
          </Button>
        </div>
      </div>

      <div className="mt-6 space-y-3">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => onDragEnd(e, tree, null)}>
          <SortableContext items={tree.map((b) => b.id)} strategy={verticalListSortingStrategy}>
            {tree.map((block) => (
              <BlockEditor
                key={block.id}
                block={block}
                sensors={sensors}
                onEdit={setEditing}
                onDelete={(itemId) => deleteM.mutate(itemId)}
                onAddQuestion={() => addQuestionM.mutate(block)}
                onDragEndQuestions={(e) => onDragEnd(e, block.children, block.id)}
              />
            ))}
          </SortableContext>
        </DndContext>

        {tree.length === 0 && (
          <Card className="px-6 py-10 text-center text-sm text-gray-400">No items yet. Add a block to start.</Card>
        )}

        <Button variant="blue" onClick={() => addBlockM.mutate()} disabled={addBlockM.isPending}>
          <Plus size={16} /> Add block
        </Button>
      </div>

      {editing && (
        <ItemEditDialog
          item={editing}
          onClose={() => setEditing(null)}
          onSave={(patch) => saveM.mutate({ itemId: editing.id, patch })}
        />
      )}

      {preview && <PreviewModal tree={tree} name={templateQ.data?.name ?? ''} onClose={() => setPreview(false)} />}

      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onImported={invalidate}
          checklistId={id}
          existingTaskIds={existingTaskIds}
          rootOrderStart={tree.length}
        />
      )}

      {(deleteM.error || saveM.error || reorderM.error) && (
        <p className="mt-4 text-sm text-red-600">{errMsg(deleteM.error || saveM.error || reorderM.error)}</p>
      )}
    </div>
  )
}

/* ======================= Block ======================= */

function BlockEditor({
  block,
  sensors,
  onEdit,
  onDelete,
  onAddQuestion,
  onDragEndQuestions,
}: {
  block: ItemNode
  sensors: ReturnType<typeof useSensors>
  onEdit: (item: ChecklistItem) => void
  onDelete: (id: string) => void
  onAddQuestion: () => void
  onDragEndQuestions: (e: DragEndEvent) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 }

  return (
    <div ref={setNodeRef} style={style} className="overflow-hidden rounded-xl border border-gray-100 bg-white shadow-card">
      <div className="flex items-center gap-2 bg-gray-50 px-4 py-3">
        <button {...attributes} {...listeners} className="cursor-grab text-gray-400 hover:text-gray-600" title="Drag">
          <GripVertical size={16} />
        </button>
        <span className="flex-1 font-semibold text-gray-900">{block.label}</span>
        <RowActions onEdit={() => onEdit(block)} onDelete={() => onDelete(block.id)} />
      </div>

      <div className="px-4 py-2">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEndQuestions}>
          <SortableContext items={block.children.map((q) => q.id)} strategy={verticalListSortingStrategy}>
            {block.children.map((q) => (
              <QuestionRow key={q.id} q={q} onEdit={() => onEdit(q)} onDelete={() => onDelete(q.id)} />
            ))}
          </SortableContext>
        </DndContext>
        <button
          onClick={onAddQuestion}
          className="mt-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-blue-600 hover:bg-blue-50"
        >
          <Plus size={14} /> Add question
        </button>
      </div>
    </div>
  )
}

function QuestionRow({ q, onEdit, onDelete }: { q: ItemNode; onEdit: () => void; onDelete: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: q.id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 }

  return (
    <div ref={setNodeRef} style={style} className="flex items-center gap-2 border-b border-gray-50 py-2 last:border-0">
      <button {...attributes} {...listeners} className="cursor-grab text-gray-300 hover:text-gray-500" title="Drag">
        <GripVertical size={14} />
      </button>
      <span className="flex-1 text-sm text-gray-700">{q.label}</span>
      {(q.answer_options?.length ?? 0) > 0 && (
        <span className="hidden text-xs text-gray-300 sm:inline">{q.answer_options!.join(' / ')}</span>
      )}
      <RowActions onEdit={onEdit} onDelete={onDelete} small />
    </div>
  )
}

function RowActions({ onEdit, onDelete, small }: { onEdit: () => void; onDelete: () => void; small?: boolean }) {
  const sz = small ? 14 : 16
  return (
    <span className="flex items-center gap-1">
      <button onClick={onEdit} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700" title="Edit">
        <Pencil size={sz} />
      </button>
      <button onClick={onDelete} className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600" title="Delete">
        <Trash2 size={sz} />
      </button>
    </span>
  )
}

/* ======================= Preview ======================= */

function PreviewModal({ tree, name, onClose }: { tree: ItemNode[]; name: string; onClose: () => void }) {
  return (
    <Modal open size="lg" title={`Preview — ${name}`} onClose={onClose} footer={<Button variant="ghost" onClick={onClose}>Close</Button>}>
      <ChecklistPreview tree={tree} />
    </Modal>
  )
}

/* ======================= AI Import ======================= */

function ImportDialog({
  onClose,
  onImported,
  checklistId,
  existingTaskIds,
  rootOrderStart,
}: {
  onClose: () => void
  onImported: () => void
  checklistId: string
  existingTaskIds: Set<string>
  rootOrderStart: number
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [status, setStatus] = useState<string>('')

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy(true)
    setErr(null)
    try {
      setStatus('Reading image…')
      const dataUrl = await new Promise<string>((res, rej) => {
        const r = new FileReader()
        r.onload = () => res(String(r.result))
        r.onerror = rej
        r.readAsDataURL(file)
      })
      setStatus('Extracting checklist (AI)…')
      const extracted = await extractChecklistFromImage(dataUrl)
      if (!extracted.length) throw new Error('No items detected in the image.')

      setStatus('Saving items…')
      const seen = new Set(existingTaskIds)
      let rootOrder = rootOrderStart
      for (const top of extracted) {
        const blockTaskId = makeTaskId(top.label, seen)
        seen.add(blockTaskId)
        const block = await createItem({
          checklist_id: checklistId,
          task_id: blockTaskId,
          label: top.label,
          description: top.description ?? null,
          parent_id: null,
          sort_order: rootOrder++,
        })
        const children = top.children ?? []
        let qOrder = 0
        for (const child of children) {
          const qTaskId = makeTaskId(child.label, seen)
          seen.add(qTaskId)
          await createItem({
            checklist_id: checklistId,
            task_id: qTaskId,
            label: child.label,
            description: child.description ?? null,
            parent_id: block.id,
            sort_order: qOrder++,
            answer_options: [...DEFAULT_ANSWERS],
          })
        }
      }
      onImported()
      onClose()
    } catch (x) {
      setErr(errMsg(x))
    } finally {
      setBusy(false)
      setStatus('')
    }
  }

  return (
    <Modal
      open
      title="Import from image"
      subtitle="Upload a screenshot of a checklist — AI extracts blocks and questions."
      onClose={busy ? () => {} : onClose}
      footer={
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Close
        </Button>
      }
    >
      <label
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-gray-300 px-6 py-10 text-sm text-gray-500 hover:bg-gray-50',
          busy && 'pointer-events-none opacity-60',
        )}
      >
        <ImagePlus size={24} />
        {busy ? status || 'Working…' : 'Click to choose an image'}
        <input type="file" accept="image/*" className="hidden" onChange={onFile} disabled={busy} />
      </label>
      {err && <p className="mt-3 text-sm text-red-600">{err}</p>}
    </Modal>
  )
}
