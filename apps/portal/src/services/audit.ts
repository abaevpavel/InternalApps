import { requireSupabase } from '../lib/supabase'
import type { AuditEntry } from '../domain/audit'

/**
 * История изменений приложения (`portal_audit_log`, миграция 0019). Только чтение: пишет
 * триггер в базе. Видят те, у кого есть приложение, и админы (RLS по app_url).
 */
export const HISTORY_PAGE = 50

export async function loadHistory(
  appUrl: string,
  opts: { peopleOnly: boolean; before?: number },
): Promise<AuditEntry[]> {
  const sb = requireSupabase()
  let q = sb
    .from('portal_audit_log')
    .select('id, table_name, row_key, action, old_data, new_data, changed_fields, actor_name, actor_kind, changed_at')
    .eq('app_url', appUrl)
    .order('id', { ascending: false })
    .limit(HISTORY_PAGE)
  if (opts.peopleOnly) q = q.eq('actor_kind', 'person')
  if (opts.before) q = q.lt('id', opts.before)
  const { data, error } = await q
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id as number,
    tableName: r.table_name as string,
    rowKey: r.row_key as string,
    action: r.action as AuditEntry['action'],
    oldData: (r.old_data as Record<string, unknown> | null) ?? null,
    newData: (r.new_data as Record<string, unknown> | null) ?? null,
    changedFields: (r.changed_fields as string[] | null) ?? null,
    actorName: (r.actor_name as string | null) ?? null,
    actorKind: r.actor_kind as AuditEntry['actorKind'],
    changedAt: r.changed_at as string,
  }))
}
