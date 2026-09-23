import { requireSupabase } from '../lib/supabase'
import type { ScenarioComment } from '../domain/make-catalog'

/**
 * Комментарии разработчиков к сценариям Make (миграция 0021). Лежат в базе, а не в снимке JSON,
 * чтобы пересборка каталога их не затирала. Автора и время ставит триггер в базе.
 */
export async function loadComments(): Promise<ScenarioComment[]> {
  const sb = requireSupabase()
  const { data, error } = await sb
    .from('dev_scenario_comments')
    .select('id, scenario_id, body, created_by, created_by_name, created_at')
    .order('created_at')
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id as number,
    scenarioId: Number(r.scenario_id),
    body: r.body as string,
    createdBy: r.created_by as string,
    createdByName: (r.created_by_name as string | null) ?? null,
    createdAt: r.created_at as string,
  }))
}

export async function addComment(scenarioId: number, body: string): Promise<void> {
  const { error } = await requireSupabase().from('dev_scenario_comments').insert({ scenario_id: scenarioId, body: body.trim() })
  if (error) throw error
}

export async function deleteComment(id: number): Promise<void> {
  const { data, error } = await requireSupabase().from('dev_scenario_comments').delete().eq('id', id).select('id')
  if (error) throw error
  if (!data?.length) throw new Error('Not deleted — you can only delete your own comments.')
}
