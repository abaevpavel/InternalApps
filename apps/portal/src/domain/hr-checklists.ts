/**
 * Доменные типы 06-HR-Checklists — под РЕАЛЬНУЮ схему Lovable-Supabase
 * (проект pilxwhtkhysanpukaliu). Единственное место (вместе с services/hr-checklists.ts),
 * где живут имена таблиц/колонок. DDL — из migration-spec (аудит прод-кода).
 *
 * Ключевые особенности (не сломать при миграции):
 *  - Матчинг items ↔ progress по `task_id` (TEXT, не uuid).
 *  - Прогресс уникален по составному ключу (employee_id, task_id, phase).
 *  - `phase` перегружен: 'phase1'|'phase2a'|'phase2b'|'phase3' для legacy-фаз,
 *    ИЛИ UUID шаблона в виде text для динамических назначенных чек-листов.
 */

/* ---------------- enum ---------------- */

export type EmployeeType =
  | 'Office employee'
  | 'Field managerial employee'
  | 'Field non-managerial employee'

export const EMPLOYEE_TYPES: EmployeeType[] = [
  'Office employee',
  'Field managerial employee',
  'Field non-managerial employee',
]

/* ---------------- employees ---------------- */

export interface Employee {
  id: string
  first_name: string
  last_name: string
  employee_type: EmployeeType
  start_date: string | null
  termination_date: string | null
  application_id: string | null // мёртвая колонка в этом приложении
  created_at: string
  updated_at: string
}

/* ---------------- employee_types (legacy словарь) ---------------- */

export interface EmployeeTypeRow {
  id: string
  name: string
  description: string | null
  created_at: string
  updated_at: string
}

/* ---------------- checklists (шаблоны) ---------------- */

export interface Checklist {
  id: string
  name: string
  description: string | null
  employee_type_id: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

/* ---------------- checklist_items ---------------- */

export interface ItemLink {
  label: string
  url: string
}

export interface ChecklistItem {
  id: string
  checklist_id: string
  /** Стабильный текстовый ключ матчинга с progress. */
  task_id: string
  label: string
  description: string | null
  links: ItemLink[] | null // jsonb [{label,url}]
  photos: string[] | null // text[], имена файлов в bucket checklist-item-photos
  answer_options: string[] | null // jsonb ["Yes","No","N/A"], до 10
  parent_id: string | null // self-FK, иерархия ≥3 уровней
  sort_order: number
  created_at: string
  updated_at: string
}

/** Узел дерева items. */
export interface ItemNode extends ChecklistItem {
  children: ItemNode[]
}

/* ---------------- employee_checklists (назначения) ---------------- */

export interface EmployeeChecklist {
  id: string
  employee_id: string
  checklist_id: string
  assigned_at: string | null
  assigned_by: string | null
  /** «Общие» заметки по назначенному чек-листу (не по задаче). */
  notes: string | null
  created_at: string | null
  updated_at: string | null
}

/* ---------------- employee_checklist_progress ---------------- */

export interface ProgressRow {
  id: string
  employee_id: string
  /** Матчится с ChecklistItem.task_id. */
  task_id: string
  /** 'phase1'|'phase2a'|'phase2b'|'phase3' (legacy) ИЛИ checklistId (uuid как text). */
  phase: string
  completed: boolean | null
  is_not_applicable: boolean | null
  selected_answer: string | null
  notes: string | null
  photos: string[] | null // bucket checklist-item-photos
  completed_at: string | null
  created_at: string
  updated_at: string
}

/* ---------------- employee_phase_preferences ---------------- */

export interface PhasePreference {
  id: string
  employee_id: string
  phase: string // сейчас только 'phase2b'
  is_required: boolean
  created_at: string
  updated_at: string
}

/* ---------------- checklist_photos (фото на уровне назначения) ---------------- */

export interface ChecklistPhoto {
  id: string
  employee_checklist_id: string
  file_path: string // имя файла в bucket checklist-photos
  file_name: string
  uploaded_by: string | null
  created_at: string
}

/* ================= helpers ================= */

export const DEFAULT_ANSWERS = ['Yes', 'No', 'N/A'] as const

/** Три состояния задачи. */
export type TriState = 'unchecked' | 'checked' | 'not_applicable'

export function triStateOf(p: ProgressRow | undefined): TriState {
  if (!p) return 'unchecked'
  if (p.is_not_applicable) return 'not_applicable'
  if (p.completed) return 'checked'
  return 'unchecked'
}

/** Следующее состояние в цикле unchecked → checked → not_applicable → unchecked. */
export function nextTriState(s: TriState): TriState {
  return s === 'unchecked' ? 'checked' : s === 'checked' ? 'not_applicable' : 'unchecked'
}

/** Задача «выполнена» для прогресса: completed || N/A. */
export function isDone(p: ProgressRow | undefined): boolean {
  return !!p && (!!p.completed || !!p.is_not_applicable)
}

export function fullName(e: Pick<Employee, 'first_name' | 'last_name'>): string {
  return [e.first_name, e.last_name].filter(Boolean).join(' ').trim()
}

/** Собрать все листья поддерева (промежуточные узлы «сплющиваются»). */
export function collectLeaves(node: ItemNode): ItemNode[] {
  if (!node.children.length) return [node]
  return node.children.flatMap(collectLeaves)
}

/** Плоский список поддерева, включая сам узел. */
export function flatten(node: ItemNode): ItemNode[] {
  return [node, ...node.children.flatMap(flatten)]
}

/** Построить дерево из плоского списка items (по parent_id + sort_order). */
export function buildTree(items: ChecklistItem[]): ItemNode[] {
  const byId = new Map<string, ItemNode>()
  for (const it of items) byId.set(it.id, { ...it, children: [] })
  const roots: ItemNode[] = []
  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id)) byId.get(node.parent_id)!.children.push(node)
    else roots.push(node)
  }
  const sortRec = (nodes: ItemNode[]) => {
    nodes.sort((a, b) => a.sort_order - b.sort_order)
    nodes.forEach((n) => sortRec(n.children))
  }
  sortRec(roots)
  return roots
}
