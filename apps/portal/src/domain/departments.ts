/**
 * Департаменты апок (BAS-1681) — как папки компании. Значение хранится в
 * `applications.department` (миграция 0026, там же check-ограничение на этот список).
 */
export const DEPARTMENTS = [
  '01-MARKETING',
  '02-SALES',
  '03-PRODUCTION',
  '04-OPERATIONS',
  '05-EXECUTIVE',
  '06-HR',
  '07-FINANCES',
  '08-IT',
  '09-FORGE',
] as const

export type Department = (typeof DEPARTMENTS)[number]

export const NO_DEPARTMENT = 'No department'

export interface DepartmentGroup<T> {
  key: string
  label: string
  apps: T[]
}

/**
 * Карточки главной по департаментам: по возрастанию (01 → 09), «No department» —
 * последним. Внутри блока порядок исходного списка (он уже отсортирован по имени).
 * Значение не из списка (вписали руками в базе) не теряем — отдельным блоком перед
 * «No department».
 */
export function groupByDepartment<T extends { department?: string | null }>(apps: T[]): DepartmentGroup<T>[] {
  const known = new Map<string, T[]>()
  const unknown = new Map<string, T[]>()
  const none: T[] = []
  for (const a of apps) {
    const d = a.department?.trim()
    if (!d) none.push(a)
    else if ((DEPARTMENTS as readonly string[]).includes(d)) known.set(d, [...(known.get(d) ?? []), a])
    else unknown.set(d, [...(unknown.get(d) ?? []), a])
  }
  const out: DepartmentGroup<T>[] = []
  for (const d of DEPARTMENTS) if (known.has(d)) out.push({ key: d, label: d, apps: known.get(d)! })
  for (const d of [...unknown.keys()].sort()) out.push({ key: d, label: d, apps: unknown.get(d)! })
  if (none.length) out.push({ key: '__none__', label: NO_DEPARTMENT, apps: none })
  return out
}

/**
 * Имя апки для показа: департамент префиксом — «02-SALES — Send an Offer Email».
 * Департамент не выбран — просто имя. Если имя уже начинается с департамента (так
 * исторически назывались некоторые апки), второй раз его не дописываем.
 */
export function displayAppName(name: string, department?: string | null): string {
  const d = department?.trim()
  const n = name.trim()
  if (!d) return n
  if (n.toUpperCase().startsWith(d.toUpperCase())) return n
  return `${d} — ${n}`
}
