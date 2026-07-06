import { requireSupabase } from '../lib/supabase'
import { compressToJpeg } from '../lib/imageCompression'
import type {
  Checklist,
  ChecklistItem,
  ChecklistPhoto,
  Employee,
  EmployeeChecklist,
  EmployeeType,
  EmployeeTypeRow,
  ItemLink,
  PhasePreference,
  ProgressRow,
  TriState,
} from '../domain/hr-checklists'

/**
 * Сервисный слой 06-HR-Checklists под реальную схему Lovable-Supabase.
 * Единственное место с именами таблиц/колонок. Upsert прогресса — read-then-write по
 * составному ключу (employee_id, task_id, phase), без опоры на DB-UNIQUE (его нет).
 */

const ITEM_BUCKET = 'checklist-item-photos'
const ASSIGNMENT_BUCKET = 'checklist-photos'

/* ================= Employees ================= */

export async function listEmployees(): Promise<Employee[]> {
  const sb = requireSupabase()
  const { data, error } = await sb.from('employees').select('*').order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as Employee[]
}

export async function createEmployee(input: {
  first_name: string
  last_name: string
  employee_type: EmployeeType
  start_date?: string | null
  termination_date?: string | null
}): Promise<Employee> {
  const sb = requireSupabase()
  // start_date опускаем при undefined — тогда сработает DB-default CURRENT_DATE
  const row: Record<string, unknown> = {
    first_name: input.first_name.trim(),
    last_name: input.last_name.trim(),
    employee_type: input.employee_type,
    termination_date: input.termination_date ?? null,
  }
  if (input.start_date !== undefined) row.start_date = input.start_date
  const { data, error } = await sb.from('employees').insert(row).select('*').single()
  if (error) throw error
  return data as Employee
}

export async function updateEmployee(
  id: string,
  patch: Partial<Pick<Employee, 'first_name' | 'last_name' | 'employee_type' | 'start_date' | 'termination_date'>>,
): Promise<void> {
  const sb = requireSupabase()
  const { error } = await sb.from('employees').update(patch).eq('id', id)
  if (error) throw error
}

export async function deleteEmployee(id: string): Promise<void> {
  const sb = requireSupabase()
  const { error } = await sb.from('employees').delete().eq('id', id)
  if (error) throw error
}

/* ================= employee_types (словарь) ================= */

export async function listEmployeeTypes(): Promise<EmployeeTypeRow[]> {
  const sb = requireSupabase()
  const { data, error } = await sb.from('employee_types').select('*').order('name')
  if (error) throw error
  return (data ?? []) as EmployeeTypeRow[]
}

/* ================= Checklists (шаблоны) ================= */

export async function listChecklists(): Promise<Checklist[]> {
  const sb = requireSupabase()
  const { data, error } = await sb.from('checklists').select('*').order('created_at')
  if (error) throw error
  return (data ?? []) as Checklist[]
}

export async function getChecklist(id: string): Promise<Checklist | null> {
  const sb = requireSupabase()
  const { data, error } = await sb.from('checklists').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return (data as Checklist) ?? null
}

export async function createChecklist(input: {
  name: string
  description?: string
  employee_type_id?: string | null
}): Promise<Checklist> {
  const sb = requireSupabase()
  const { data, error } = await sb
    .from('checklists')
    .insert({
      name: input.name.trim(),
      description: input.description?.trim() || null,
      employee_type_id: input.employee_type_id ?? null,
    })
    .select('*')
    .single()
  if (error) throw error
  return data as Checklist
}

export async function updateChecklist(
  id: string,
  patch: Partial<Pick<Checklist, 'name' | 'description' | 'employee_type_id' | 'notes'>>,
): Promise<void> {
  const sb = requireSupabase()
  const { error } = await sb.from('checklists').update(patch).eq('id', id)
  if (error) throw error
}

export async function deleteChecklist(id: string): Promise<void> {
  const sb = requireSupabase()
  // FK checklist_items.checklist_id ON DELETE CASCADE — items уйдут сами, но подстрахуемся
  await sb.from('checklist_items').delete().eq('checklist_id', id)
  const { error } = await sb.from('checklists').delete().eq('id', id)
  if (error) throw error
}

/** Дублировать шаблон вместе с деревом. task_id РЕГЕНЕРИРУЕТСЯ (как в оригинале). */
export async function duplicateChecklist(id: string): Promise<Checklist> {
  const src = await getChecklist(id)
  if (!src) throw new Error('Checklist not found')
  const items = await listItems(id)
  const copy = await createChecklist({
    name: `${src.name} (copy)`,
    description: src.description ?? '',
    employee_type_id: src.employee_type_id,
  })
  if (!items.length) return copy

  const sb = requireSupabase()
  const idMap = new Map<string, string>()
  for (const it of items) {
    const { data, error } = await sb
      .from('checklist_items')
      .insert({
        checklist_id: copy.id,
        task_id: makeTaskId(),
        label: it.label,
        description: it.description,
        links: it.links ?? [],
        photos: it.photos ?? [],
        answer_options: it.answer_options ?? [],
        parent_id: null,
        sort_order: it.sort_order,
      })
      .select('id')
      .single()
    if (error) throw error
    idMap.set(it.id, (data as { id: string }).id)
  }
  for (const it of items) {
    if (!it.parent_id) continue
    const newId = idMap.get(it.id)!
    const newParent = idMap.get(it.parent_id)
    if (newParent) await sb.from('checklist_items').update({ parent_id: newParent }).eq('id', newId)
  }
  return copy
}

/** task_id как в edge-функции: 'task-'+timestamp+'-'+rand. */
export function makeTaskId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/* ================= Items ================= */

export async function listItems(checklistId: string): Promise<ChecklistItem[]> {
  const sb = requireSupabase()
  const { data, error } = await sb
    .from('checklist_items')
    .select('*')
    .eq('checklist_id', checklistId)
    .order('sort_order')
  if (error) throw error
  return (data ?? []) as ChecklistItem[]
}

export interface ItemInput {
  checklist_id: string
  task_id?: string
  label: string
  description?: string | null
  links?: ItemLink[]
  photos?: string[]
  answer_options?: string[]
  parent_id?: string | null
  sort_order?: number
}

export async function createItem(input: ItemInput): Promise<ChecklistItem> {
  const sb = requireSupabase()
  const { data, error } = await sb
    .from('checklist_items')
    .insert({
      checklist_id: input.checklist_id,
      task_id: input.task_id ?? makeTaskId(),
      label: input.label.trim(),
      description: input.description ?? null,
      links: input.links ?? [],
      photos: input.photos ?? [],
      answer_options: input.answer_options ?? [],
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
  const { error } = await sb.from('checklist_items').update(patch).eq('id', id)
  if (error) throw error
}

/** Удалить пункт и всё поддерево (FK ON DELETE CASCADE, но подстрахуемся явно). */
export async function deleteItemSubtree(id: string, allItems: ChecklistItem[]): Promise<void> {
  const sb = requireSupabase()
  const ids: string[] = []
  const collect = (pid: string) => {
    ids.push(pid)
    allItems.filter((x) => x.parent_id === pid).forEach((c) => collect(c.id))
  }
  collect(id)
  const { error } = await sb.from('checklist_items').delete().in('id', ids)
  if (error) throw error
}

export async function reorderItems(
  updates: { id: string; parent_id: string | null; sort_order: number }[],
): Promise<void> {
  const sb = requireSupabase()
  for (const u of updates) {
    const { error } = await sb
      .from('checklist_items')
      .update({ parent_id: u.parent_id, sort_order: u.sort_order })
      .eq('id', u.id)
    if (error) throw error
  }
}

/* ================= Assignments (employee_checklists) ================= */

export async function listEmployeeChecklists(employeeId: string): Promise<EmployeeChecklist[]> {
  const sb = requireSupabase()
  const { data, error } = await sb.from('employee_checklists').select('*').eq('employee_id', employeeId)
  if (error) throw error
  return (data ?? []) as EmployeeChecklist[]
}

export async function assignChecklist(employeeId: string, checklistId: string, assignedBy?: string): Promise<void> {
  const sb = requireSupabase()
  // без DB-UNIQUE: не плодим дубли — проверяем существующее назначение
  const { data: existing } = await sb
    .from('employee_checklists')
    .select('id')
    .eq('employee_id', employeeId)
    .eq('checklist_id', checklistId)
    .limit(1)
    .maybeSingle()
  if (existing?.id) return
  const { error } = await sb.from('employee_checklists').insert({
    employee_id: employeeId,
    checklist_id: checklistId,
    assigned_by: assignedBy ?? null,
    assigned_at: new Date().toISOString(),
  })
  if (error) throw error
}

export async function unassignChecklist(id: string): Promise<void> {
  const sb = requireSupabase()
  const { error } = await sb.from('employee_checklists').delete().eq('id', id)
  if (error) throw error
}

export async function updateAssignmentNotes(id: string, notes: string): Promise<void> {
  const sb = requireSupabase()
  const { error } = await sb.from('employee_checklists').update({ notes }).eq('id', id)
  if (error) throw error
}

/* ================= Progress (employee_checklist_progress) ================= */

/** Весь прогресс сотрудника (по всем фазам/чек-листам). */
export async function listProgress(employeeId: string): Promise<ProgressRow[]> {
  const sb = requireSupabase()
  const { data, error } = await sb.from('employee_checklist_progress').select('*').eq('employee_id', employeeId)
  if (error) throw error
  return (data ?? []) as ProgressRow[]
}

/**
 * Upsert прогресса по (employee_id, task_id, phase) без опоры на DB-UNIQUE:
 * читаем строку, затем update/insert. На insert даём безопасные дефолты.
 */
export async function upsertProgress(
  employeeId: string,
  taskId: string,
  phase: string,
  patch: Partial<Pick<ProgressRow, 'completed' | 'is_not_applicable' | 'selected_answer' | 'notes' | 'photos' | 'completed_at'>>,
): Promise<void> {
  const sb = requireSupabase()
  const { data: existing, error: findErr } = await sb
    .from('employee_checklist_progress')
    .select('id')
    .eq('employee_id', employeeId)
    .eq('task_id', taskId)
    .eq('phase', phase)
    .limit(1)
    .maybeSingle()
  if (findErr) throw findErr

  if (existing?.id) {
    const { error } = await sb.from('employee_checklist_progress').update(patch).eq('id', existing.id)
    if (error) throw error
  } else {
    const { error } = await sb.from('employee_checklist_progress').insert({
      employee_id: employeeId,
      task_id: taskId,
      phase,
      completed: false,
      is_not_applicable: false,
      ...patch,
    })
    if (error) throw error
  }
}

/** Установить tri-state задачи (+ опционально selected_answer). */
export async function setTaskState(
  employeeId: string,
  taskId: string,
  phase: string,
  state: TriState,
  selectedAnswer?: string | null,
): Promise<void> {
  await upsertProgress(employeeId, taskId, phase, {
    completed: state === 'checked',
    is_not_applicable: state === 'not_applicable',
    completed_at: state === 'checked' ? new Date().toISOString() : null,
    ...(selectedAnswer !== undefined ? { selected_answer: selectedAnswer } : {}),
  })
}

/** Каскадно проставить одинаковое состояние набору задач (родитель→потомки). */
export async function setManyTaskStates(
  employeeId: string,
  phase: string,
  taskIds: string[],
  state: TriState,
): Promise<void> {
  for (const taskId of taskIds) await setTaskState(employeeId, taskId, phase, state)
}

/* ================= Phase preferences ================= */

export async function listPhasePreferences(employeeId: string): Promise<PhasePreference[]> {
  const sb = requireSupabase()
  const { data, error } = await sb.from('employee_phase_preferences').select('*').eq('employee_id', employeeId)
  if (error) throw error
  return (data ?? []) as PhasePreference[]
}

export async function setPhasePreference(employeeId: string, phase: string, isRequired: boolean): Promise<void> {
  const sb = requireSupabase()
  const { error } = await sb
    .from('employee_phase_preferences')
    .upsert({ employee_id: employeeId, phase, is_required: isRequired }, { onConflict: 'employee_id,phase' })
  if (error) throw error
}

/* ================= checklist_photos (фото на уровне назначения) ================= */

export async function listChecklistPhotos(employeeChecklistId: string): Promise<ChecklistPhoto[]> {
  const sb = requireSupabase()
  const { data, error } = await sb
    .from('checklist_photos')
    .select('*')
    .eq('employee_checklist_id', employeeChecklistId)
    .order('created_at')
  if (error) throw error
  return (data ?? []) as ChecklistPhoto[]
}

export async function addChecklistPhoto(
  employeeChecklistId: string,
  file: File,
  uploadedBy?: string,
): Promise<ChecklistPhoto> {
  const sb = requireSupabase()
  const blob = await compressToJpeg(file)
  const path = `${employeeChecklistId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`
  const { error: upErr } = await sb.storage
    .from(ASSIGNMENT_BUCKET)
    .upload(path, blob, { contentType: 'image/jpeg', cacheControl: '3600', upsert: false })
  if (upErr) throw upErr
  const { data, error } = await sb
    .from('checklist_photos')
    .insert({ employee_checklist_id: employeeChecklistId, file_path: path, file_name: file.name, uploaded_by: uploadedBy ?? null })
    .select('*')
    .single()
  if (error) throw error
  return data as ChecklistPhoto
}

export async function deleteChecklistPhoto(id: string, filePath: string): Promise<void> {
  const sb = requireSupabase()
  await sb.storage.from(ASSIGNMENT_BUCKET).remove([filePath])
  const { error } = await sb.from('checklist_photos').delete().eq('id', id)
  if (error) throw error
}

export function assignmentPhotoUrl(filePath: string): string {
  const sb = requireSupabase()
  return sb.storage.from(ASSIGNMENT_BUCKET).getPublicUrl(filePath).data.publicUrl
}

/* ================= Storage: фото пункта/задачи (checklist-item-photos) ================= */

/** Загрузка фото (JPEG ≤200KB). key — id пункта либо задачи (для имени файла). */
export async function uploadItemPhoto(file: File, key: string): Promise<string> {
  const sb = requireSupabase()
  const blob = await compressToJpeg(file)
  const path = `${key}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`
  const { error } = await sb.storage
    .from(ITEM_BUCKET)
    .upload(path, blob, { contentType: 'image/jpeg', cacheControl: '3600', upsert: false })
  if (error) throw error
  return path // храним имя файла (как в оригинале)
}

export function itemPhotoUrl(fileName: string): string {
  // на случай, если уже полный URL — вернём как есть
  if (/^https?:\/\//.test(fileName)) return fileName
  const sb = requireSupabase()
  return sb.storage.from(ITEM_BUCKET).getPublicUrl(fileName).data.publicUrl
}

/* ================= AI-импорт (extract-checklist-from-image) ================= */

/**
 * Парсит скриншот чек-листа и ВСТАВЛЯЕТ пункты в checklist_id на стороне edge-функции.
 * Контракт: { imageBase64, checklistId, table:'checklist_items' } → { success, itemCount }.
 * Возвращает число вставленных узлов; вызывающий перечитывает items.
 */
export async function extractChecklistFromImage(imageBase64: string, checklistId: string): Promise<number> {
  const sb = requireSupabase()
  const { data, error } = await sb.functions.invoke('extract-checklist-from-image', {
    body: { imageBase64, checklistId, table: 'checklist_items' },
  })
  if (error) throw error
  if (data?.error) throw new Error(String(data.error))
  return Number(data?.itemCount ?? 0)
}
