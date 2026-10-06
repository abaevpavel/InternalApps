import { useQuery } from '@tanstack/react-query'
import { listApplications } from '../services/data'
import type { Application } from '../domain/types'
import type { AppConfig } from './appRegistry'
import { displayAppName } from '../domain/departments'

/**
 * Строка `applications` для апки из реестра (BAS-1681): имя и департамент теперь правит
 * админ, поэтому показываем их из базы, а `label` из кода — только запасной вариант,
 * пока список не загрузился или строки нет. Сопоставление — по url (у внутренних апок
 * `applications.url` = роут-префикс).
 */
export function useAppRecord(app: AppConfig | null): { record: Application | null; name: string | null } {
  const q = useQuery({ queryKey: ['applications'], queryFn: listApplications, staleTime: 60_000 })
  if (!app) return { record: null, name: null }
  const record = (q.data ?? []).find((a) => !!a.url && app.routePrefixes.includes(a.url)) ?? null
  return { record, name: record ? displayAppName(record.name, record.department) : app.shortLabel ?? app.label }
}
