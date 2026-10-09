import { requireSupabase } from '../lib/supabase'

/**
 * Сервис app-settings (таблица public.app_settings, key/value на приложение).
 * Чтение — любой authenticated; запись — админ (RLS). resolveString не кидает при
 * отсутствии таблицы — падает на fallback (env), чтобы апки работали до применения миграции.
 */

export async function getSettingsMap(appCode: string): Promise<Record<string, unknown>> {
  const sb = requireSupabase()
  const { data, error } = await sb.from('app_settings').select('key, value').eq('app_code', appCode)
  if (error) throw error
  const map: Record<string, unknown> = {}
  for (const r of data ?? []) map[r.key as string] = r.value
  return map
}

export async function setSetting(appCode: string, key: string, value: unknown): Promise<void> {
  const sb = requireSupabase()
  const { error } = await sb
    .from('app_settings')
    .upsert({ app_code: appCode, key, value, updated_at: new Date().toISOString() }, { onConflict: 'app_code,key' })
  if (error) throw error
}

/** Строковая настройка с фолбэком (напр. вебхук: БД → env). Тихо падает на fallback. */
export async function resolveString(appCode: string, key: string, fallback?: string): Promise<string> {
  try {
    const sb = requireSupabase()
    const { data, error } = await sb
      .from('app_settings')
      .select('value')
      .eq('app_code', appCode)
      .eq('key', key)
      .limit(1)
      .maybeSingle()
    if (!error && data && typeof data.value === 'string' && data.value) return data.value
  } catch {
    // таблицы может ещё не быть — используем fallback
  }
  return fallback ?? ''
}
