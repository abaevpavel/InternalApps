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
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  ArrowLeft,
  ChevronsLeft,
  ChevronsRight,
  Copy,
  Eye,
  GripVertical,
  ImagePlus,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react'
import { Button, Card, Dropdown, Modal } from '../../components/ui'
import { cn, errMsg } from '../../lib/utils'
import { ItemEditDialog, type ItemPatch } from './ItemEditDialog'
import { ChecklistPreview } from './ChecklistPreview'
import {
  createItem,
  deleteChecklist,
  deleteItemSubtree,
  duplicateChecklist,
  extractChecklistFromImage,
  getChecklist,
  listChecklists,
  listItems,
  makeTaskId,
  reorderItems,
  updateItem,
} from '../../services/hr-checklists'
import { DEFAULT_ANSWERS, buildTree, type ChecklistItem, type ItemNode } from '../../domain/hr-checklists'

interface EditorApi {
  onEdit: (item: ChecklistItem) => void
  onDelete: (id: string) => void
  onAddChild: (parentId: string, childrenCount: number) => void
  onIndent: (node: ItemNode, siblings: ItemNode[]) => void
  onOutdent: (node: ItemNode) => void
  reorder: (e: DragEndEvent, siblings: ItemNode[], parentId: string | null) => void
  byId: Map<string, ChecklistItem>
  sensors: ReturnType<typeof useSensors>
}

export function ChecklistDetailPage() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const qc = useQueryClient()

  const checklistQ = useQuery({ queryKey: ['hr-checklist', id], queryFn: () => getChecklist(id) })
  const itemsQ = useQuery({ queryKey: ['hr-items', id], queryFn: () => listItems(id) })

  const items = itemsQ.data ?? []
  const tree = useMemo(() => buildTree(items), [items])
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])

  const [editing, setEditing] = useState<ChecklistItem | null>(null)
  const [preview, setPreview] = useState(false)
  const [importing, setImporting] = useState(false)

  const invalidate = () => qc.invalidateQueries({ queryKey: ['hr-items', id] })

  const addRootM = useMutation({
    mutationFn: () => createItem({ checklist_id: id, task_id: makeTaskId(), label: 'New item', parent_id: null, sort_order: tree.length }),
    onSuccess: invalidate,
  })
  const addChildM = useMutation({
    mutationFn: ({ parentId, count }: { parentId: string; count: number }) =>
      createItem({ checklist_id: id, task_id: makeTaskId(), label: 'New item', parent_id: parentId, sort_order: count, answer_options: [...DEFAULT_ANSWERS] }),
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

  const allChecklistsQ = useQuery({ queryKey: ['hr-checklists'], queryFn: listChecklists })
  const dupM = useMutation({ mutationFn: () => duplicateChecklist(id), onSuccess: (copy) => nav(`/checklist/${copy.id}`) })
  const delM = useMutation({ mutationFn: () => deleteChecklist(id), onSuccess: () => nav('/checklists') })
  const [confirmDel, setConfirmDel] = useState(false)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const api: EditorApi = {
    onEdit: setEditing,
    onDelete: (itemId) => deleteM.mutate(itemId),
    onAddChild: (parentId, count) => addChildM.mutate({ parentId, count }),
    onIndent: (node, siblings) => {
      const idx = siblings.findIndex((s) => s.id === node.id)
      if (idx <= 0) return // нет предыдущего соседа — вкладывать некуда
      const prev = siblings[idx - 1]
      reorderM.mutate([{ id: node.id, parent_id: prev.id, sort_order: prev.children.length }])
    },
    onOutdent: (node) => {
      if (!node.parent_id) return // уже корень
      const parent = byId.get(node.parent_id)
      const newParentId = parent?.parent_id ?? null
      const targetSiblings = items.filter((x) => x.parent_id === newParentId)
      reorderM.mutate([{ id: node.id, parent_id: newParentId, sort_order: targetSiblings.length }])
    },
    reorder: (e, siblings, parentId) => {
      const { active, over } = e
      if (!over || active.id === over.id) return
      const oldIdx = siblings.findIndex((x) => x.id === active.id)
      const newIdx = siblings.findIndex((x) => x.id === over.id)
      if (oldIdx < 0 || newIdx < 0) return
      const reordered = arrayMove(siblings, oldIdx, newIdx)
      reorderM.mutate(reordered.map((x, i) => ({ id: x.id, parent_id: parentId, sort_order: i })))
    },
    byId,
    sensors,
  }

  if (checklistQ.isLoading || itemsQ.isLoading) return <div className="p-10 text-gray-400">Loading…</div>

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <button onClick={() => nav('/checklists')} className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-gray-800">
          <ArrowLeft size={16} /> Back to Checklists
        </button>
        <Dropdown
          className="w-72"
          value={id}
          onChange={(cid) => nav(`/checklist/${cid}`)}
          options={(allChecklistsQ.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
        />
      </div>

      {/* summary + actions */}
      <Card className="mb-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{checklistQ.data?.name ?? 'Checklist'}</h1>
            {checklistQ.data?.description && <p className="mt-0.5 text-sm text-gray-500">{checklistQ.data.description}</p>}
            <p className="mt-2 text-sm text-gray-400">{items.length} items</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="subtle" onClick={() => dupM.mutate()} disabled={dupM.isPending}>
              <Copy size={16} /> Duplicate
            </Button>
            <Button variant="danger" onClick={() => setConfirmDel(true)}>
              <Trash2 size={16} /> Delete
            </Button>
          </div>
        </div>
      </Card>

      <div className="mb-2 flex items-center justify-end gap-2">
        <Button variant="subtle" onClick={() => setPreview(true)}>
          <Eye size={16} /> Preview
        </Button>
        <Button variant="subtle" onClick={() => setImporting(true)}>
          <ImagePlus size={16} /> Import from image
        </Button>
      </div>

      <Card className="p-4">
        {tree.length === 0 ? (
          <div className="px-2 py-8 text-center text-sm text-gray-400">No items yet. Add one to start.</div>
        ) : (
          <Group nodes={tree} parentId={null} depth={0} api={api} />
        )}
        <div className="mt-3">
          <Button variant="blue" onClick={() => addRootM.mutate()} disabled={addRootM.isPending}>
            <Plus size={16} /> Add item
          </Button>
        </div>
      </Card>

      {editing && (
        <ItemEditDialog item={editing} onClose={() => setEditing(null)} onSave={(patch) => saveM.mutate({ itemId: editing.id, patch })} />
      )}
      {preview && (
        <Modal open size="lg" title={`Preview — ${checklistQ.data?.name ?? ''}`} onClose={() => setPreview(false)} footer={<Button variant="ghost" onClick={() => setPreview(false)}>Close</Button>}>
          <ChecklistPreview tree={tree} />
        </Modal>
      )}
      {importing && (
        <ImportDialog checklistId={id} onClose={() => setImporting(false)} onImported={invalidate} />
      )}

      <Modal
        open={confirmDel}
        title="Delete checklist?"
        subtitle={checklistQ.data?.name}
        onClose={() => setConfirmDel(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDel(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => delM.mutate()} disabled={delM.isPending}>
              Delete
            </Button>
          </>
        }
      >
        This removes the checklist template and all its items. Employee progress rows (matched by task_id) are kept.
        {delM.error && <p className="mt-2 text-sm text-red-600">{errMsg(delM.error)}</p>}
      </Modal>

      {(deleteM.error || saveM.error || reorderM.error) && (
        <p className="mt-4 text-sm text-red-600">{errMsg(deleteM.error || saveM.error || reorderM.error)}</p>
      )}
    </div>
  )
}

/* ======================= recursive tree ======================= */

function Group({
  nodes,
  parentId,
  depth,
  api,
}: {
  nodes: ItemNode[]
  parentId: string | null
  depth: number
  api: EditorApi
}) {
  return (
    <DndContext sensors={api.sensors} collisionDetection={closestCenter} onDragEnd={(e) => api.reorder(e, nodes, parentId)}>
      <SortableContext items={nodes.map((n) => n.id)} strategy={verticalListSortingStrategy}>
        {nodes.map((n) => (
          <NodeRow key={n.id} node={n} siblings={nodes} depth={depth} api={api} />
        ))}
      </SortableContext>
    </DndContext>
  )
}

function NodeRow({ node, siblings, depth, api }: { node: ItemNode; siblings: ItemNode[]; depth: number; api: EditorApi }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: node.id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 }
  const idx = siblings.findIndex((s) => s.id === node.id)

  return (
    <div ref={setNodeRef} style={style}>
      <div
        className="group flex items-center gap-2 rounded-md py-1.5 hover:bg-gray-50"
        style={{ paddingLeft: depth * 20 }}
      >
        <button {...attributes} {...listeners} className="cursor-grab text-gray-300 hover:text-gray-500" title="Drag">
          <GripVertical size={15} />
        </button>
        <span className="flex-1 truncate text-sm text-gray-800">{node.label}</span>

        <span className="flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
          <IconBtn title="Outdent" onClick={() => api.onOutdent(node)} disabled={depth === 0}>
            <ChevronsLeft size={15} />
          </IconBtn>
          <IconBtn title="Indent" onClick={() => api.onIndent(node, siblings)} disabled={idx <= 0}>
            <ChevronsRight size={15} />
          </IconBtn>
          <IconBtn title="Add sub-item" onClick={() => api.onAddChild(node.id, node.children.length)}>
            <Plus size={15} />
          </IconBtn>
          <IconBtn title="Edit" onClick={() => api.onEdit(node)}>
            <Pencil size={15} />
          </IconBtn>
          <IconBtn title="Delete" className="hover:text-red-600" onClick={() => api.onDelete(node.id)}>
            <Trash2 size={15} />
          </IconBtn>
        </span>
      </div>

      {node.children.length > 0 && <Group nodes={node.children} parentId={node.id} depth={depth + 1} api={api} />}
    </div>
  )
}

function IconBtn({
  children,
  onClick,
  title,
  disabled,
  className,
}: {
  children: React.ReactNode
  onClick: () => void
  title: string
  disabled?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cn('rounded p-1 text-gray-400 hover:bg-gray-100 disabled:opacity-30', className)}
    >
      {children}
    </button>
  )
}

/* ======================= AI import ======================= */

function ImportDialog({ checklistId, onClose, onImported }: { checklistId: string; onClose: () => void; onImported: () => void }) {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [err, setErr] = useState<string | null>(null)

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
      const count = await extractChecklistFromImage(dataUrl, checklistId)
      onImported()
      onClose()
      if (count === 0) setErr('No items detected.')
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
      subtitle="Upload a screenshot of a checklist — AI extracts the item tree into this template."
      onClose={busy ? () => {} : onClose}
      footer={<Button variant="ghost" onClick={onClose} disabled={busy}>Close</Button>}
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
