import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, Copy, Mail, MapPin, Pencil, Phone, Plus, Search, Trash2, User, X } from 'lucide-react'
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
import { useAuth } from '../../auth/AuthProvider'
import { cn, errMsg } from '../../lib/utils'
import {
  assignTemplate,
  createTemplate,
  deleteTemplate,
  duplicateTemplate,
  listAllProjectLinks,
  listProjects,
  deleteProject,
  listTemplates,
  updateTemplate,
} from '../../services/production-checklist'
import { formatAddress, isCompletedStatus, type ChecklistTemplate, type Project } from '../../domain/production-checklist'

type Tab = 'projects' | 'templates'

export function ProductionChecklistsPage() {
  const [tab, setTab] = useState<Tab>('projects')
  const projectsQ = useQuery({ queryKey: ['projects'], queryFn: listProjects })

  // Счётчик у заголовка: завершённые из общего числа. Статус берём из того же
  // `isCompletedStatus`, что красит бейдж на карточке — иначе цифра в заголовке
  // и бейджи внизу могли бы расходиться.
  const projects = projectsQ.data ?? []
  const done = projects.filter((p) => isCompletedStatus(p.status)).length

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-10 sm:px-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-3 text-3xl font-bold tracking-tight text-gray-900">
            Production Checklist
            {projects.length > 0 && (
              <span
                title={`${done} completed of ${projects.length} projects · ${projects.length - done} still in progress`}
                className="cursor-default rounded-full bg-gray-100 px-3 py-1 text-base font-semibold text-gray-500"
              >
                (<span className="text-green-600">{done}</span>
                <span className="mx-0.5 text-gray-400">/</span>
                {projects.length})
              </span>
            )}
          </h1>
          <p className="mt-1.5 text-sm leading-relaxed text-gray-500">
            Manage production checklist templates and project assignments
          </p>
        </div>
      </div>
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
function ProjectsTab() {
  const qc = useQueryClient()
  const { isAdmin } = useAuth()
  const [sort, setSort] = useState<SortKey>('newest')
  // Два простых фильтра вместо конструктора условий: статус и поиск по названию.
  // Меню «добавить фильтр» требовало трёх кликов там, где нужен один.
  const [status, setStatus] = useState<'all' | 'in_progress' | 'completed'>('all')
  const [nameQuery, setNameQuery] = useState('')

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
    const q = nameQuery.trim().toLowerCase()
    if (q) list = list.filter((p) => p.name.toLowerCase().includes(q))
    if (status !== 'all') {
      list = list.filter((p) => (status === 'completed' ? isCompletedStatus(p.status) : !isCompletedStatus(p.status)))
    }
    list.sort((a, b) => {
      const d = new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      return sort === 'newest' ? -d : d
    })
    return list
  }, [projectsQ.data, nameQuery, status, sort])

  // Отложенное удаление: строка сразу исчезает со списка, а сам DELETE уходит через
  // 10 секунд. Пока таймер идёт, внизу висит плашка с «Undo» — отмена просто снимает
  // таймер, ничего не восстанавливая, потому что удалить ещё не успели.
  const [pendingDelete, setPendingDelete] = useState<{ project: Project; timer: number } | null>(null)
  // Спрашиваем до того, как запустить отсчёт: десять секунд на отмену — подстраховка,
  // а не замена подтверждения. Промах по корзине не должен ничего запускать.
  const [confirmDelete, setConfirmDelete] = useState<Project | null>(null)

  function scheduleDelete(project: Project) {
    if (pendingDelete) window.clearTimeout(pendingDelete.timer)
    const timer = window.setTimeout(async () => {
      try {
        await deleteProject(project.id)
      } finally {
        setPendingDelete(null)
        qc.invalidateQueries({ queryKey: ['projects'] })
        qc.invalidateQueries({ queryKey: ['project-links'] })
      }
    }, 10_000)
    setPendingDelete({ project, timer })
  }

  function undoDelete() {
    if (!pendingDelete) return
    window.clearTimeout(pendingDelete.timer)
    setPendingDelete(null)
  }

  // Проект, ожидающий удаления, скрываем сразу — иначе кнопка выглядит нерабочей.
  const visibleRows = rows.filter((p) => p.id !== pendingDelete?.project.id)

  if (projectsQ.isLoading) return <Loading />
  if (projectsQ.error) return <ErrBox e={projectsQ.error} />

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Dropdown
          className="w-full sm:w-48"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: 'All statuses' },
            { value: 'in_progress', label: 'In progress' },
            { value: 'completed', label: 'Completed' },
          ]}
        />
        <ProjectSearch
          projects={projectsQ.data ?? []}
          value={nameQuery}
          onChange={setNameQuery}
        />
        <Dropdown
          className="w-full sm:w-40"
          value={sort}
          onChange={setSort}
          options={[
            { value: 'newest', label: 'Newest first' },
            { value: 'oldest', label: 'Oldest first' },
          ]}
        />
        <span className="text-xs text-gray-400">
          {rows.length} of {(projectsQ.data ?? []).length}
        </span>
      </div>

      {visibleRows.length === 0 ? (
        <Card className="px-6 py-12 text-center text-sm text-gray-400">No projects yet.</Card>
      ) : (
        <div className="space-y-3">
          {visibleRows.map((p) => (
            <ProjectCard
              key={p.id}
              project={p}
              templates={templatesQ.data ?? []}
              assignedTemplate={
                templateIdByProject.get(p.id) ? templateById.get(templateIdByProject.get(p.id)!) ?? null : null
              }
              canDelete={isAdmin}
              onDelete={() => setConfirmDelete(p)}
            />
          ))}
        </div>
      )}

      <Modal
        open={!!confirmDelete}
        title="Delete project?"
        subtitle={confirmDelete?.name}
        onClose={() => setConfirmDelete(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (confirmDelete) scheduleDelete(confirmDelete)
                setConfirmDelete(null)
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        The project and its checklist progress will be removed. You will have 10 seconds to undo.
      </Modal>

      {/* Окно отмены. Пока висит — проект ещё в базе. */}
      {pendingDelete && (
        <UndoBar
          name={pendingDelete.project.name}
          onUndo={undoDelete}
        />
      )}
    </div>
  )
}

/** Плашка с обратным отсчётом и кнопкой отмены. */
function UndoBar({ name, onUndo }: { name: string; onUndo: () => void }) {
  const [left, setLeft] = useState(10)
  useEffect(() => {
    const t = window.setInterval(() => setLeft((v) => (v > 0 ? v - 1 : 0)), 1000)
    return () => window.clearInterval(t)
  }, [])
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-5">
      <div className="flex items-center gap-4 rounded-lg bg-gray-900 px-5 py-3 text-sm text-white shadow-lg">
        <span>
          Project <span className="font-semibold">{name}</span> will be deleted in {left}s
        </span>
        <button onClick={onUndo} className="font-semibold text-blue-300 underline-offset-2 hover:underline">
          Undo
        </button>
      </div>
    </div>
  )
}

function ProjectCard({
  project,
  templates,
  assignedTemplate,
  canDelete,
  onDelete,
}: {
  project: Project
  templates: ChecklistTemplate[]
  assignedTemplate: ChecklistTemplate | null
  /** Удаление проекта — только админ портала. */
  canDelete: boolean
  onDelete: () => void
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
        <div className="min-w-0 flex-1 basis-full sm:basis-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-bold text-gray-900">{project.name}</h3>
            <StatusBadge tone={completed ? 'success' : 'pending'}>{project.status ?? 'In Progress'}</StatusBadge>
            {sent && (
              <Badge className="bg-purple-50 text-purple-700">Sent</Badge>
            )}
          </div>
          <div className="mt-1 font-mono text-xs text-gray-400">ID: {project.id}</div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
            <span>Created: {new Date(project.created_at).toLocaleDateString('en-US')}</span>
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

        <div className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto">
          <Dropdown
            className="w-full sm:w-52"
            value={assignedTemplate?.id ?? null}
            placeholder="Select template…"
            disabled={assignM.isPending}
            onChange={(id) => assignM.mutate(id)}
            options={templates.map((t) => ({ value: t.id, label: t.name }))}
          />
          <Button
            variant="subtle"
            className="flex-1 sm:flex-none"
            onClick={() => nav(`/production-checklist/project/${project.id}`)}
          >
            Open
          </Button>
          {canDelete && (
            <Button
              variant="ghost"
              className="text-gray-400 hover:text-red-600"
              title="Delete project"
              onClick={onDelete}
            >
              <Trash2 size={16} />
            </Button>
          )}
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

/**
 * Поиск проекта по названию: инпут плюс выпадающий список совпадений.
 *
 * Список подсказок нужен, потому что имена длинные и однотипные
 * («20-12-11 Allred-Takoma Park, MD») — набрав пару символов, проще выбрать из
 * совпадений, чем дописывать вручную. Выбор подставляет имя целиком, то есть
 * фильтрует ровно по одному проекту.
 */
function ProjectSearch({
  projects, value, onChange,
}: { projects: Project[]; value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const q = value.trim().toLowerCase()
  const matches = q
    ? projects.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 8)
    : []

  return (
    <div ref={ref} className="relative w-full sm:w-72">
      <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
      <Input
        className="pl-9 pr-8"
        placeholder="Search by project name…"
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
      />
      {value && (
        <button
          type="button"
          aria-label="Clear"
          onClick={() => { onChange(''); setOpen(false) }}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-700"
        >
          <X size={14} />
        </button>
      )}
      {open && matches.length > 0 && (
        <div className="absolute left-0 top-full z-40 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
          {matches.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => { onChange(p.name); setOpen(false) }}
              className="block w-full truncate px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
            >
              {p.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
