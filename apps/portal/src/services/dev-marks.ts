import { requireSupabase } from '../lib/supabase'

/**
 * Пометки полей payload'а «удалить» / «оставить» (миграция 0023). Ключ — (scope, path):
 * scope — вид payload'а Mac-приложения ('mac:proposal'…) или 'scenario:<id>' для прочих вебхуков.
 */
export type MarkStatus = 'delete' | 'keep' | 'add'

export interface PayloadMark {
  status: MarkStatus
  /** Для «add»: тип будущего поля и заметка. */
  fieldType: string | null
  note: string | null
  updatedByName: string | null
  updatedAt: string
}

/** scope → path → пометка */
export type MarksIndex = Map<string, Map<string, PayloadMark>>

export async function loadMarks(): Promise<MarksIndex> {
  const { data, error } = await requireSupabase()
    .from('dev_payload_marks')
    .select('scope, path, status, field_type, note, updated_by_name, updated_at')
  if (error) throw error
  const out: MarksIndex = new Map()
  for (const r of data ?? []) {
    const scope = r.scope as string
    if (!out.has(scope)) out.set(scope, new Map())
    out.get(scope)!.set(r.path as string, {
      status: r.status as MarkStatus,
      fieldType: (r.field_type as string | null) ?? null,
      note: (r.note as string | null) ?? null,
      updatedByName: (r.updated_by_name as string | null) ?? null,
      updatedAt: r.updated_at as string,
    })
  }
  return out
}

export async function setMark(
  scope: string,
  path: string,
  status: MarkStatus | null,
  extra?: { fieldType?: string; note?: string },
): Promise<void> {
  const sb = requireSupabase()
  if (status === null) {
    const { error } = await sb.from('dev_payload_marks').delete().eq('scope', scope).eq('path', path)
    if (error) throw error
    return
  }
  const { error } = await sb.from('dev_payload_marks').upsert({
    scope,
    path,
    status,
    field_type: extra?.fieldType?.trim() || null,
    note: extra?.note?.trim() || null,
  })
  if (error) throw error
}
