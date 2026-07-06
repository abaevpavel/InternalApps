import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, Copy, Filter, Mail, MapPin, Pencil, Phone, Plus, Trash2, User, X } from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Modal,
  PageTitle,
  StatusBadge,
  Tabs,
  Textarea,
} from '../../components/ui'
import { cn, errMsg } from '../../lib/utils'
import {
  assignTemplate,
  createTemplate,
  deleteTemplate,
  duplicateTemplate,
  listAllProjectLinks,
  listProjects,
  listTemplates,
  updateTemplate,
} from '../../services/production-checklist'
import { formatAddress, isCompletedStatus, type ChecklistTemplate, type Project } from '../../domain/production-checklist'

type Tab = 'projects' | 'templates'

export function ProductionChecklistsPage() {
  const [tab, setTab] = useState<Tab>('projects')

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <PageTitle
        title="Production Checklist"
        subtitle="Manage production checklist templates and project assignments"
      />
      <Tabs
        className="mb-6 max-w-sm"
        tabs={[
          { key: 'projects', label: 'Projects' },
          { key: 'templates', label: 'Templates' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'projects' ? <ProjectsTab /> : <TemplatesTab />}
    </div>
  )
}

/* ======================= Projects ======================= */

type SortKey = 'newest' | 'oldest'
type FilterType = 'name' | 'status'
interface ActiveFilter {
  type: FilterType
  value: string
}

function ProjectsTab() {
  const [sort, setSort] = useState<SortKey>('newest')
  const [filters, setFilters] = useState<ActiveFilter[]>([])

  const projectsQ = useQuery({ queryKey: ['projects'], queryFn: listProjects })
  const templatesQ = useQuery({ queryKey: ['templates'], queryFn: listTemplates })
  const linksQ = useQuery({ queryKey: ['project-links'], queryFn: listAllProjectLinks })

  const templateById = useMemo(
    () => new Map((templatesQ.data ?? []).map((t) => [t.id, t])),
    [templatesQ.data],
  )
  const templateIdByProject = useMemo(() => {
    const m = new Map<string, string>()
    for (const l of linksQ.data ?? []) if (!m.has(l.project_id)) m.set(l.project_id, l.checklist_id)
    return m
  }, [linksQ.data])

  const rows = useMemo(() => {
    let list = [...(projectsQ.data ?? [])]
    for (const f of filters) {
      if (f.type === 'name' && f.value.trim()) {
        const q = f.value.trim().toLowerCase()
        list = list.filter((p) => p.name.toLowerCase().includes(q))
      }
      if (f.type === 'status' && f.value) {
        list = list.filter((p) =>
          f.value === 'Completed' ? isCompletedStatus(p.status) : !isCompletedStatus(p.status),
        )
      }
    }
    list.sort((a, b) => {
      const d = new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      return sort === 'newest' ? -d : d
    })
    return list
  }, [projectsQ.data, filters, sort])

  if (projectsQ.isLoading) return <Loading />
  if (projectsQ.error) return <ErrBox e={projectsQ.error} />

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <FiltersButton filters={filters} setFilters={setFilters} />
        <Dropdown
          className="w-40"
          value={sort}
          onChange={setSort}
          options={[
            { value: 'newest', label: 'Newest first' },
            { value: 'oldest', label: 'Oldest first' },
          ]}
        />
      </div>

      {rows.length === 0 ? (
        <Card className="px-6 py-12 text-center text-sm text-gray-400">No projects yet.</Card>
      ) : (
        <div className="space-y-3">
          {rows.map((p) => (
            <ProjectCard
              key={p.id}
              project={p}
              templates={templatesQ.data ?? []}
              assignedTemplate={
                templateIdByProject.get(p.id) ? templateById.get(templateIdByProject.get(p.id)!) ?? null : null
              }
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ProjectCard({
  project,
  templates,
  assignedTemplate,
}: {
  project: Project
  templates: ChecklistTemplate[]
  assignedTemplate: ChecklistTemplate | null
}) {
  const nav = useNavigate()
  const qc = useQueryClient()
  const completed = isCompletedStatus(project.status)
  const sent = !!project.checklist_sent_at

  const assignM = useMutation({
    mutationFn: (checklistId: string) => assignTemplate(project.id, checklistId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project-links'] }),
  })

  const addr = formatAddress(project.address)
  const contact = project.primary_contact

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-bold text-gray-900">{project.name}</h3>
            <StatusBadge tone={completed ? 'success' : 'pending'}>{project.status ?? 'In Progress'}</StatusBadge>
            {sent && (
              <Badge className="bg-purple-50 text-purple-700">Sent</Badge>
            )}
          </div>
          <div className="mt-1 font-mono text-xs text-gray-400">ID: {project.id}</div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
            <span>Created: {new Date(project.created_at).toLocaleDateString()}</span>
            {addr && (
              <span className="inline-flex items-center gap-1">
                <MapPin size={12} /> {addr}
              </span>
            )}
            {contact?.name && (
              <span className="inline-flex items-center gap-1">
                <User size={12} /> {contact.name}
              </span>
            )}
            {contact?.email && (
              <span className="inline-flex items-center gap-1">
                <Mail size={12} /> {contact.email}
              </span>
            )}
            {contact?.phone_number && (
              <span className="inline-flex items-center gap-1">
                <Phone size={12} /> {contact.phone_number}
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Dropdown
            className="w-52"
            value={assignedTemplate?.id ?? null}
            placeholder="Select template…"
            disabled={assignM.isPending}
            onChange={(id) => assignM.mutate(id)}
            options={templates.map((t) => ({ value: t.id, label: t.name }))}
          />
          <Button variant="subtle" onClick={() => nav(`/production-checklist/project/${project.id}`)}>
            Open
          </Button>
        </div>
      </div>
      {assignM.error && <p className="mt-2 text-xs text-red-600">{errMsg(assignM.error)}</p>}
    </Card>
  )
}

/* ======================= Templates ======================= */

function TemplatesTab() {
  const nav = useNavigate()
  const qc = useQueryClient()
  const templatesQ = useQuery({ queryKey: ['templates'], queryFn: listTemplates })
  const [editing, setEditing] = useState<ChecklistTemplate | null>(null)
  const [creating, setCreating] = useState(false)
  const [confirmDel, setConfirmDel] = useState<ChecklistTemplate | null>(null)

  const dupM = useMutation({
    mutationFn: (id: string) => duplicateTemplate(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['templates'] }),
  })
  const delM = useMutation({
    mutationFn: (id: string) => deleteTemplate(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['templates'] })
      setConfirmDel(null)
    },
  })

  if (templatesQ.isLoading) return <Loading />
  if (templatesQ.error) return <ErrBox e={templatesQ.error} />

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button variant="blue" onClick={() => setCreating(true)}>
          <Plus size={16} /> New Template
        </Button>
      </div>

      {(templatesQ.data ?? []).length === 0 ? (
        <Card className="px-6 py-12 text-center text-sm text-gray-400">No templates yet.</Card>
      ) : (
        <div className="space-y-3">
          {(templatesQ.data ?? []).map((t) => (
            <Card key={t.id} className="flex items-center justify-between p-5">
              <div className="min-w-0">
                <div className="font-bold uppercase tracking-wide text-gray-900">{t.name}</div>
                {t.description && <div className="mt-0.5 truncate text-sm text-gray-500">{t.description}</div>}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button variant="subtle" onClick={() => nav(`/production-checklist/${t.id}`)}>
                  Edit Items
                </Button>
                <Button variant="ghost" onClick={() => setEditing(t)} title="Rename">
                  <Pencil size={16} />
                </Button>
                <Button variant="ghost" onClick={() => dupM.mutate(t.id)} title="Duplicate" disabled={dupM.isPending}>
                  <Copy size={16} />
                </Button>
                <Button variant="ghost" className="text-red-600" onClick={() => setConfirmDel(t)} title="Delete">
                  <Trash2 size={16} />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {(creating || editing) && (
        <TemplateDialog
          template={editing}
          onClose={() => {
            setCreating(false)
            setEditing(null)
          }}
        />
      )}

      <Modal
        open={!!confirmDel}
        title="Delete template?"
        subtitle={confirmDel?.name}
        onClose={() => setConfirmDel(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDel(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => confirmDel && delM.mutate(confirmDel.id)} disabled={delM.isPending}>
              Delete
            </Button>
          </>
        }
      >
        This removes the template and all its items. Project progress rows are kept (matched by task_id).
        {delM.error && <p className="mt-2 text-sm text-red-600">{errMsg(delM.error)}</p>}
      </Modal>
    </div>
  )
}

function TemplateDialog({ template, onClose }: { template: ChecklistTemplate | null; onClose: () => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState(template?.name ?? '')
  const [description, setDescription] = useState(template?.description ?? '')

  const saveM = useMutation({
    mutationFn: () =>
      template ? updateTemplate(template.id, { name, description }) : createTemplate({ name, description }).then(() => {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['templates'] })
      onClose()
    },
  })

  return (
    <Modal
      open
      title={template ? 'Edit template' : 'New template'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => saveM.mutate()} disabled={!name.trim() || saveM.isPending}>
            {template ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="BASE PRICE CHECKLIST" autoFocus />
        </Field>
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
        </Field>
        {saveM.error && <p className="text-sm text-red-600">{errMsg(saveM.error)}</p>}
      </div>
    </Modal>
  )
}

/* ======================= misc ======================= */

/** Панель фильтров как в оригинале: кнопка Filters → поповер с «Add filter» (Name / Status). */
function FiltersButton({
  filters,
  setFilters,
}: {
  filters: ActiveFilter[]
  setFilters: React.Dispatch<React.SetStateAction<ActiveFilter[]>>
}) {
  const [open, setOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false)
        setAddOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const usedTypes = new Set(filters.map((f) => f.type))
  const addable = (['name', 'status'] as FilterType[]).filter((t) => !usedTypes.has(t))

  function addFilter(type: FilterType) {
    setFilters((f) => [...f, { type, value: type === 'status' ? 'In Progress' : '' }])
    setAddOpen(false)
  }
  function updateFilter(i: number, value: string) {
    setFilters((f) => f.map((x, j) => (j === i ? { ...x, value } : x)))
  }
  function removeFilter(i: number) {
    setFilters((f) => f.filter((_, j) => j !== i))
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3.5 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50',
          open && 'border-accent-500 ring-1 ring-accent-500',
        )}
      >
        <Filter size={15} className="text-gray-400" />
        Filters
        {filters.length > 0 && (
          <span className="ml-0.5 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-accent-600 px-1.5 text-xs font-semibold text-white">
            {filters.length}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute left-0 top-full z-40 mt-2 w-80 rounded-xl border border-gray-200 bg-white p-4 shadow-lg">
          {filters.length === 0 ? (
            <p className="text-sm text-gray-500">No filters applied. Add one to narrow down projects.</p>
          ) : (
            <div className="space-y-2">
              {filters.map((f, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-14 shrink-0 text-xs font-semibold uppercase tracking-wide text-gray-400">
                    {f.type}
                  </span>
                  {f.type === 'name' ? (
                    <Input
                      className="flex-1"
                      autoFocus
                      placeholder="Name contains…"
                      value={f.value}
                      onChange={(e) => updateFilter(i, e.target.value)}
                    />
                  ) : (
                    <Dropdown
                      className="flex-1"
                      value={f.value}
                      onChange={(v) => updateFilter(i, v)}
                      options={[
                        { value: 'In Progress', label: 'In Progress' },
                        { value: 'Completed', label: 'Completed' },
                      ]}
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => removeFilter(i)}
                    className="shrink-0 rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
                    title="Remove filter"
                  >
                    <X size={15} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="my-3 border-t border-gray-100" />

          <div className="relative">
            <Button variant="subtle" disabled={addable.length === 0} onClick={() => setAddOpen((v) => !v)}>
              <Plus size={14} /> Add filter
            </Button>
            {addOpen && addable.length > 0 && (
              <div className="absolute left-0 top-full z-50 mt-1 w-44 overflow-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                {addable.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => addFilter(t)}
                    className="flex w-full items-center px-3 py-2 text-left text-sm capitalize text-gray-700 hover:bg-gray-50"
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** Кастомный дропдаун в стиле приложения (нативный <select> нельзя стилизовать в раскрытом виде). */
function Dropdown<T extends string>({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  className,
}: {
  value: T | null
  onChange: (v: T) => void
  options: { value: T; label: string }[]
  placeholder?: string
  disabled?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const current = options.find((o) => o.value === value)

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center justify-between gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 transition hover:bg-gray-50',
          'focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        <span className={cn('truncate', !current && 'text-gray-400')}>{current?.label ?? placeholder ?? 'Select…'}</span>
        <ChevronDown size={15} className={cn('shrink-0 text-gray-400 transition', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute z-40 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
          {options.length === 0 && <div className="px-3 py-2 text-sm text-gray-400">No options</div>}
          {options.map((o) => {
            const selected = o.value === value
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  onChange(o.value)
                  setOpen(false)
                }}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50',
                  selected ? 'font-medium text-gray-900' : 'text-gray-700',
                )}
              >
                <Check size={14} className={cn('shrink-0', selected ? 'text-accent-600' : 'invisible')} />
                <span className="truncate">{o.label}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Loading() {
  return <div className="py-16 text-center text-gray-400">Loading…</div>
}
function ErrBox({ e }: { e: unknown }) {
  return <Card className="px-6 py-10 text-center text-sm text-red-600">{errMsg(e)}</Card>
}
