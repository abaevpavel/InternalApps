import { supabase } from '../../lib/supabase'
import { runEdgeSync } from './data'

/**
 * Автосинк Task Planner с Airtable при входе в апку (миграция 0036). Решает база
 * (tp_claim_auto_sync): синк нужен, если последний успешный был больше 10 минут назад
 * и сейчас никто не синкает, — тогда его запускает браузер этого пользователя.
 */
export const AUTO_SYNC_FUNCTIONS = ['sync-airtable-projects', 'sync-airtable-teams', 'sync-airtable-skills']

export interface SyncStatus {
  lastSyncedAt: string | null
  inProgress: boolean
  lastError: string | null
  lastErrorAt: string | null
}

export async function fetchSyncStatus(): Promise<SyncStatus> {
  if (!supabase) throw new Error('Supabase is not configured')
  const { data, error } = await supabase.rpc('tp_sync_status')
  if (error) throw error
  const r = ((data ?? []) as Record<string, unknown>[])[0] ?? {}
  return {
    lastSyncedAt: (r.last_synced_at as string | null) ?? null,
    inProgress: !!r.in_progress,
    lastError: (r.last_error as string | null) ?? null,
    lastErrorAt: (r.last_error_at as string | null) ?? null,
  }
}

/** Запустить синк, если он нужен. `true` — синк прошёл здесь, `false` — не понадобился. */
export async function runAutoSyncIfDue(): Promise<boolean> {
  if (!supabase) throw new Error('Supabase is not configured')
  const { data: id, error } = await supabase.rpc('tp_claim_auto_sync')
  if (error) throw error
  if (!id) return false
  try {
    await runEdgeSync(AUTO_SYNC_FUNCTIONS)
  } catch (e) {
    await supabase.rpc('tp_finish_auto_sync', { p_id: id, p_ok: false, p_error: e instanceof Error ? e.message : String(e) })
    throw e
  }
  const { error: finishError } = await supabase.rpc('tp_finish_auto_sync', { p_id: id, p_ok: true })
  if (finishError) throw finishError
  return true
}
