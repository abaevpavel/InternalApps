/**
 * Доменные типы Production-Checklist — под РЕАЛЬНУЮ схему Lovable-Supabase
 * (проект pilxwhtkhysanpukaliu). Единственное место (вместе с services/data.ts),
 * где живут имена таблиц/колонок. Схема задокументирована в
 * docs/app-estimates/03-Production-Checklist.md (аудит прод-кода).
 *
 * Матчинг items ↔ progress идёт по `task_id` (TEXT, не uuid) — стабильный ключ,
 * позволяет пересоздавать items без потери прогресса. Не переназначать при миграции.
 */

/* ---------------- projects ---------------- */

export interface Address {
  street_address_1?: string | null
  street_address_2?: string | null
  city?: string | null
  state?: string | null
  postal_code?: string | null
  country?: string | null
}

export interface Contact {
  name?: string | null
  email?: string | null
  phone_number?: string | null
}

export type ProjectStatus = 'In Progress' | 'Completed' | (string & {})

export interface Project {
  id: string
  name: string
  status: ProjectStatus | null
  description: string | null
  start_date: string | null
  end_date: string | null
  address: Address | null
  primary_contact: Contact | null
  checklist_sent_at: string | null
  created_at: string
  updated_at: string | null
}

/* ---------------- production_checklists (шаблоны) ---------------- */

export interface ChecklistTemplate {
  id: string
  name: string
  description: string | null
  created_at: string
  updated_at: string | null
}

/* ---------------- production_checklist_items ---------------- */

export interface ItemLink {
  label: string
  url: string
}

export interface ChecklistItem {
  id: string
  checklist_id: string
  /** Стабильный текстовый ключ матчинга с progress. Уникален в рамках шаблона. */
  task_id: string
  label: string
  description: string | null
  links: ItemLink[] | null
  photos: string[] | null
  /** Варианты ответа. По умолчанию ['Yes','No','N/A']. */
  answer_options: string[] | null
  parent_id: string | null
  sort_order: number
  created_at: string
  updated_at: string | null
}

/** Узел дерева items (иерархия по parent_id). */
export interface ItemNode extends ChecklistItem {
  children: ItemNode[]
}

/* ---------------- project_checklists (назначения) ---------------- */

export interface ProjectChecklistLink {
  id: string
  project_id: string
  checklist_id: string
  assigned_by: string | null
  assigned_at: string | null
  notes: string | null
  created_at: string
  updated_at: string | null
}

/* ---------------- project_checklist_progress ---------------- */

export interface ProgressRow {
  id: string
  project_id: string
  /** Ключ матчинга с ChecklistItem.task_id. */
  task_id: string
  completed: boolean | null
  is_not_applicable: boolean | null
  selected_answer: string | null
  /** Мёртвая колонка в UI (фото-ответы не реализованы). */
  photos: string[] | null
  notes: string | null
  completed_at: string | null
  created_at: string
  updated_at: string | null
}

/* ---------------- helpers ---------------- */

export const DEFAULT_ANSWERS = ['Yes', 'No', 'N/A'] as const

export function isCompletedStatus(s: ProjectStatus | null | undefined): boolean {
  return (s ?? '').trim().toLowerCase() === 'completed'
}

/** Строка адреса одной строкой (для карточки проекта). */
export function formatAddress(a: Address | null | undefined): string {
  if (!a) return ''
  return [a.street_address_1, a.city, a.state, a.postal_code, a.country]
    .map((x) => (x ?? '').trim())
    .filter(Boolean)
    .join(', ')
}

/** Ответ считается данным, если выбран вариант, помечено N/A или completed. */
export function isAnswered(p: ProgressRow | undefined): boolean {
  if (!p) return false
  return !!p.selected_answer || !!p.is_not_applicable || !!p.completed
}

/** Собрать все листья поддерева (промежуточные узлы «сплющиваются»). */
export function collectLeaves(node: ItemNode): ItemNode[] {
  if (!node.children.length) return [node]
  return node.children.flatMap(collectLeaves)
}

/** Построить дерево из плоского списка items (по parent_id + sort_order). */
export function buildTree(items: ChecklistItem[]): ItemNode[] {
  const byId = new Map<string, ItemNode>()
  for (const it of items) byId.set(it.id, { ...it, children: [] })
  const roots: ItemNode[] = []
  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id)) {
      byId.get(node.parent_id)!.children.push(node)
    } else {
      roots.push(node)
    }
  }
  const sortRec = (nodes: ItemNode[]) => {
    nodes.sort((a, b) => a.sort_order - b.sort_order)
    nodes.forEach((n) => sortRec(n.children))
  }
  sortRec(roots)
  return roots
}
