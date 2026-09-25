import { requireSupabase } from '../lib/supabase'
import type { SourceKind, WebhookSource } from '../domain/make-catalog'

/**
 * Кто шлёт вебхук сценария (миграция 0022, dev_webhook_sources). Разметка ручная, по ходу —
 * поэтому в базе; нет строки — экран берёт значение по умолчанию из снимка.
 */
export async function loadSources(): Promise<Map<number, WebhookSource>> {
  const { data, error } = await requireSupabase()
    .from('dev_webhook_sources')
    .select('scenario_id, kind, sender, note, updated_by_name, updated_at')
  if (error) throw error
  return new Map(
    (data ?? []).map((r) => [
      Number(r.scenario_id),
      {
        kind: r.kind as SourceKind,
        sender: (r.sender as string | null) ?? null,
        note: (r.note as string | null) ?? null,
        updatedByName: (r.updated_by_name as string | null) ?? null,
        updatedAt: (r.updated_at as string | null) ?? null,
      },
    ]),
  )
}

export async function saveSource(scenarioId: number, v: { kind: SourceKind; sender: string; note: string }): Promise<void> {
  const { error } = await requireSupabase()
    .from('dev_webhook_sources')
    .upsert({ scenario_id: scenarioId, kind: v.kind, sender: v.sender.trim() || null, note: v.note.trim() || null })
  if (error) throw error
}
