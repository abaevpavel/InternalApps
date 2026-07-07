import { requireSupabase } from '../lib/supabase'
import { resolveString } from './app-settings'
import type {
  ChecklistItem,
  ChecklistTemplate,
  ItemLink,
  Project,
  ProgressRow,
  ProjectChecklistLink,
} from '../domain/production-checklist'

/**
 * Сервисный слой Production-Checklist под реальную схему Lovable-Supabase.
 * Единственное место с именами таблиц/колонок. «Перенос как есть»: без серверных
 * edge для Send (прямой fetch на Make), public-бакет, без опоры на UNIQUE-констрейнты
 * (upsert прогресса делаем read-then-write, чтобы не зависеть от onConflict).
 */

const PHOTO_BUCKET = 'production-checklist-photos'
const MAKE_WEBHOOK = import.meta.env.VITE_MAKE_SEND_WEBHOOK as string | undefined

/* ================= Projects ================= */

export async function listProjects(): Promise<Project[]> {
  const sb = requireSupabase()
  const { data, error } = await sb.from('projects').select('*').order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as Project[]
}

export async function getProject(id: string): Promise<Project | null> {
  const sb = requireSupabase()
  const { data, error } = await sb.from('projects').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return (data as Project) ?? null
}

/* ================= Templates (production_checklists) ================= */

export async function listTemplates(): Promise<ChecklistTemplate[]> {
  const sb = requireSupabase()
  const { data, error } = await sb.from('production_checklists').select('*').order('created_at')
  if (error) throw error
  return (data ?? []) as ChecklistTemplate[]
}

export async function getTemplate(id: string): Promise<ChecklistTemplate | null> {
  const sb = requireSupabase()
  const { data, error } = await sb.from('production_checklists').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return (data as ChecklistTemplate) ?? null
}

export async function createTemplate(input: { name: string; description: string }): Promise<ChecklistTemplate> {
  const sb = requireSupabase()
  const { data, error } = await sb
    .from('production_checklists')
    .insert({ name: input.name.trim(), description: input.description.trim() || null })
    .select('*')
    .single()
  if (error) throw error
  return data as ChecklistTemplate
}

export async function updateTemplate(id: string, input: { name: string; description: string }): Promise<void> {
  const sb = requireSupabase()
  const { error } = await sb
    .from('production_checklists')
    .update({ name: input.name.trim(), description: input.description.trim() || null })
    .eq('id', id)
  if (error) throw error
}

export async function deleteTemplate(id: string): Promise<void> {
  const sb = requireSupabase()
  // сначала пункты (на случай отсутствия ON DELETE CASCADE), потом сам шаблон
  await sb.from('production_checklist_items').delete().eq('checklist_id', id)
  const { error } = await sb.from('production_checklists').delete().eq('id', id)
  if (error) throw error
}

/** Дублировать шаблон вместе с деревом пунктов (task_id сохраняем — они уникальны в рамках нового шаблона). */
export async function duplicateTemplate(id: string): Promise<ChecklistTemplate> {
  const src = await getTemplate(id)
  if (!src) throw new Error('Template not found')
  const items = await listItems(id)
  const copy = await createTemplate({ name: `${src.name} (copy)`, description: src.description ?? '' })

  if (items.length) {
    const sb = requireSupabase()
    // маппинг старый id → новый id, чтобы пересобрать parent_id
    const idMap = new Map<string, string>()
    // вставляем без parent_id, собираем новые id
    const inserted: ChecklistItem[] = []
    for (const it of items) {
      const { data, error } = await sb
        .from('production_checklist_items')
        .insert({
          checklist_id: copy.id,
          task_id: it.task_id,
          label: it.label,
          description: it.description,
          links: it.links ?? [],
          photos: it.photos ?? [],
          answer_options: it.answer_options ?? null,
          parent_id: null,
          sort_order: it.sort_order,
        })
        .select('*')
        .single()
      if (error) throw error
      idMap.set(it.id, (data as ChecklistItem).id)
      inserted.push(data as ChecklistItem)
    }
    // проставляем parent_id по маппингу
    for (const it of items) {
      if (!it.parent_id) continue
      const newId = idMap.get(it.id)!
      const newParent = idMap.get(it.parent_id)
      if (newParent) await sb.from('production_checklist_items').update({ parent_id: newParent }).eq('id', newId)
    }
  }
  return copy
}

/* ================= Items (production_checklist_items) ================= */

export async function listItems(checklistId: string): Promise<ChecklistItem[]> {
  const sb = requireSupabase()
  const { data, error } = await sb
    .from('production_checklist_items')
    .select('*')
    .eq('checklist_id', checklistId)
    .order('sort_order')
  if (error) throw error
  return (data ?? []) as ChecklistItem[]
}

export interface ItemInput {
  checklist_id: string
  task_id: string
  label: string
  description?: string | null
  links?: ItemLink[]
  photos?: string[]
  answer_options?: string[] | null
  parent_id?: string | null
  sort_order?: number
}

export async function createItem(input: ItemInput): Promise<ChecklistItem> {
  const sb = requireSupabase()
  const { data, error } = await sb
    .from('production_checklist_items')
    .insert({
      checklist_id: input.checklist_id,
      task_id: input.task_id,
      label: input.label.trim(),
      description: input.description ?? null,
      links: input.links ?? [],
      photos: input.photos ?? [],
      answer_options: input.answer_options ?? null,
      parent_id: input.parent_id ?? null,
      sort_order: input.sort_order ?? 0,
    })
    .select('*')
    .single()
  if (error) throw error
  return data as ChecklistItem
}

export async function updateItem(
  id: string,
  patch: Partial<Omit<ChecklistItem, 'id' | 'checklist_id' | 'created_at' | 'updated_at'>>,
): Promise<void> {
  const sb = requireSupabase()
  const { error } = await sb.from('production_checklist_items').update(patch).eq('id', id)
  if (error) throw error
}

/** Удалить пункт и всё его поддерево (на случай отсутствия ON DELETE CASCADE self-FK). */
export async function deleteItemSubtree(id: string, allItems: ChecklistItem[]): Promise<void> {
  const sb = requireSupabase()
  const ids: string[] = []
  const collect = (pid: string) => {
    ids.push(pid)
    allItems.filter((x) => x.parent_id === pid).forEach((c) => collect(c.id))
  }
  collect(id)
  const { error } = await sb.from('production_checklist_items').delete().in('id', ids)
  if (error) throw error
}

/** Массовое обновление порядка/родителя после drag-and-drop. */
export async function reorderItems(updates: { id: string; parent_id: string | null; sort_order: number }[]): Promise<void> {
  const sb = requireSupabase()
  for (const u of updates) {
    const { error } = await sb
      .from('production_checklist_items')
      .update({ parent_id: u.parent_id, sort_order: u.sort_order })
      .eq('id', u.id)
    if (error) throw error
  }
}

/* ================= Assignments (project_checklists) ================= */

export async function listProjectLinks(projectId: string): Promise<ProjectChecklistLink[]> {
  const sb = requireSupabase()
  const { data, error } = await sb.from('project_checklists').select('*').eq('project_id', projectId)
  if (error) throw error
  return (data ?? []) as ProjectChecklistLink[]
}

/** Все назначения (для списка проектов: показать назначенный шаблон в дропдауне). */
export async function listAllProjectLinks(): Promise<ProjectChecklistLink[]> {
  const sb = requireSupabase()
  const { data, error } = await sb.from('project_checklists').select('*')
  if (error) throw error
  return (data ?? []) as ProjectChecklistLink[]
}

/** Назначенный проекту шаблон (первый из линков). */
export async function getAssignedTemplateId(projectId: string): Promise<string | null> {
  const links = await listProjectLinks(projectId)
  return links[0]?.checklist_id ?? null
}

/** Назначить проекту шаблон (заменяет существующие линки). */
export async function assignTemplate(projectId: string, checklistId: string, assignedBy?: string): Promise<void> {
  const sb = requireSupabase()
  await sb.from('project_checklists').delete().eq('project_id', projectId)
  const { error } = await sb.from('project_checklists').insert({
    project_id: projectId,
    checklist_id: checklistId,
    assigned_by: assignedBy ?? null,
    assigned_at: new Date().toISOString(),
  })
  if (error) throw error
}

/* ================= Progress (project_checklist_progress) ================= */

export async function listProgress(projectId: string): Promise<ProgressRow[]> {
  const sb = requireSupabase()
  const { data, error } = await sb.from('project_checklist_progress').select('*').eq('project_id', projectId)
  if (error) throw error
  return (data ?? []) as ProgressRow[]
}

/**
 * Upsert прогресса по (project_id, task_id) без опоры на UNIQUE-констрейнт:
 * читаем существующую строку, затем update или insert.
 */
export async function upsertProgress(
  projectId: string,
  taskId: string,
  patch: Partial<Pick<ProgressRow, 'completed' | 'is_not_applicable' | 'selected_answer' | 'notes' | 'completed_at'>>,
): Promise<void> {
  const sb = requireSupabase()
  const { data: existing, error: findErr } = await sb
    .from('project_checklist_progress')
    .select('id')
    .eq('project_id', projectId)
    .eq('task_id', taskId)
    .limit(1)
    .maybeSingle()
  if (findErr) throw findErr

  if (existing?.id) {
    const { error } = await sb.from('project_checklist_progress').update(patch).eq('id', existing.id)
    if (error) throw error
  } else {
    // is_not_applicable — NOT NULL в схеме: даём дефолт false на случай вставки
    // строки без ответа (например, заметка к блоку до кликов Y/N/NA). patch перекрывает.
    const { error } = await sb
      .from('project_checklist_progress')
      .insert({ project_id: projectId, task_id: taskId, is_not_applicable: false, ...patch })
    if (error) throw error
  }
}

/* ================= Storage (фото пунктов шаблона) ================= */

export async function uploadItemPhoto(file: File): Promise<string> {
  const sb = requireSupabase()
  const ext = file.name.split('.').pop() || 'jpg'
  const path = `items/${crypto.randomUUID()}.${ext}`
  const { error } = await sb.storage.from(PHOTO_BUCKET).upload(path, file, { upsert: false })
  if (error) throw error
  const { data } = sb.storage.from(PHOTO_BUCKET).getPublicUrl(path)
  return data.publicUrl
}

/* ================= AI-импорт (extract-checklist-from-image) ================= */

export interface ExtractedItem {
  label: string
  description?: string
  children?: ExtractedItem[]
}

/** Парсит скриншот чеклиста в структуру пунктов через shared edge-функцию. */
export async function extractChecklistFromImage(imageBase64: string): Promise<ExtractedItem[]> {
  const sb = requireSupabase()
  const { data, error } = await sb.functions.invoke('extract-checklist-from-image', {
    body: { image: imageBase64 },
  })
  if (error) throw error
  // edge может вернуть {items:[...]} либо массив напрямую
  const items = (data?.items ?? data) as ExtractedItem[]
  return Array.isArray(items) ? items : []
}

/* ================= Send → Make ================= */

export interface SendPayload {
  payload_from: string
  sent_at: string
  project: Project
  checklist: ChecklistTemplate | null
  items: {
    task_id: string
    label: string
    selected_answer: string | null
    is_not_applicable: boolean
    notes: string | null
  }[]
}

/**
 * Отправляет пройденный чеклист на Make-вебхук и помечает проект отправленным.
 * «Перенос как есть»: прямой fetch из браузера, без HMAC. Идемпотентность — мягкая:
 * не шлём повторно, если у проекта уже стоит checklist_sent_at (проверяет вызывающий).
 */
export async function sendChecklistToMake(args: {
  project: Project
  template: ChecklistTemplate | null
  items: ChecklistItem[]
  progress: ProgressRow[]
}): Promise<void> {
  const webhook = await resolveString('production-checklist', 'send_webhook', MAKE_WEBHOOK)
  if (!webhook) throw new Error('Send webhook is not configured (App Settings → Webhooks or .env)')
  const progressByTask = new Map(args.progress.map((p) => [p.task_id, p]))

  const payload: SendPayload = {
    payload_from: 'production-checklist',
    sent_at: new Date().toISOString(),
    project: args.project,
    checklist: args.template,
    items: args.items.map((it) => {
      const p = progressByTask.get(it.task_id)
      return {
        task_id: it.task_id,
        label: it.label,
        selected_answer: p?.selected_answer ?? null,
        is_not_applicable: !!p?.is_not_applicable,
        notes: p?.notes ?? null,
      }
    }),
  }

  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`Make webhook error: HTTP ${res.status}`)

  // помечаем проект отправленным/завершённым
  const sb = requireSupabase()
  const { error } = await sb
    .from('projects')
    .update({ status: 'Completed', checklist_sent_at: new Date().toISOString() })
    .eq('id', args.project.id)
  if (error) throw error
}
