import { requireSupabase, supabase } from '../lib/supabase'
import type { GmbAgentStatus, GmbBundle, GmbRegion, GmbSetting, GmbSettingKey } from '../domain/gmb'

/**
 * GMB Agent — данные экрана настроек (BAS-1353).
 *
 * Живут в базе портала, четыре таблицы `gmb_*` в `public` (завёл Никита, BAS-1344):
 *   gmb_settings      — значение на ключ (key/value jsonb) + updated_at / updated_by
 *   gmb_setting_keys  — каталог 20 валидных ключей; форма строится ПО НЕМУ, а не по списку в коде
 *   gmb_agent_status  — одна строка (id = 1), пишет агент: applied_at / applied_error
 *   gmb_regions       — закрытый словарь регионов для post_topics
 *
 * Права — портальные, никаких новых понятий: чтение и запись по
 * `user_has_application_access(auth.uid(), '/gmb-agent')`, причём ключи с
 * `editable_by = developer` (сегодня только `agent_paused`) БД отдаёт на запись
 * лишь админу. То есть форма ничего не «прячет» — гейт стоит в базе.
 *
 * Агент опрашивает настройки сам; сохранение доезжает до продакшена примерно за две минуты.
 */

export type GmbLoadResult = GmbBundle

export async function loadBundle(): Promise<GmbLoadResult> {
  const sb = requireSupabase()

  const [keysRes, settingsRes, statusRes, regionsRes] = await Promise.all([
    sb.from('gmb_setting_keys').select('key, section, value_type, editable_by, notes'),
    sb.from('gmb_settings').select('key, value, updated_at, updated_by'),
    sb.from('gmb_agent_status').select('applied_at, applied_error, applied_hash, updated_at').limit(1).maybeSingle(),
    sb.from('gmb_regions').select('code, label').order('code'),
  ])

  for (const r of [keysRes, settingsRes, regionsRes]) if (r.error) throw r.error
  // Статус пишет агент: если строки ещё нет, экран должен открыться, а не упасть.
  const statusRow = statusRes.error ? null : statusRes.data

  const keys: GmbSettingKey[] = (keysRes.data ?? []).map((r) => ({
    key: r.key as string,
    section: r.section as GmbSettingKey['section'],
    valueType: r.value_type as GmbSettingKey['valueType'],
    editableBy: r.editable_by as GmbSettingKey['editableBy'],
    notes: (r.notes as string | null) ?? null,
  }))

  const settings: GmbSetting[] = (settingsRes.data ?? []).map((r) => ({
    key: r.key as string,
    value: r.value,
    updatedAt: (r.updated_at as string | null) ?? null,
    updatedBy: (r.updated_by as string | null) ?? null,
  }))

  const status: GmbAgentStatus | null = statusRow
    ? {
        appliedAt: (statusRow.applied_at as string | null) ?? null,
        appliedError: (statusRow.applied_error as string | null) ?? null,
        appliedHash: (statusRow.applied_hash as string | null) ?? null,
        updatedAt: (statusRow.updated_at as string | null) ?? null,
      }
    : null

  const regions: GmbRegion[] = (regionsRes.data ?? []).map((r) => ({
    code: r.code as string,
    label: (r.label as string) ?? (r.code as string),
  }))

  return { keys, settings, status, regions }
}

/**
 * Сохранить изменённые ключи.
 *
 * UPDATE, а не upsert: все 20 строк заведены вместе с каталогом, и вставлять здесь нечего.
 * `.select('key')` ловит тихий no-op — когда RLS не пустила запись (ключ `developer`, а
 * человек не админ), Supabase не отдаёт ошибку, просто ничего не обновляет. Без этой
 * проверки экран показал бы «Saved ✓» на несохранённом значении.
 */
export async function saveChanges(changes: { key: string; value: unknown }[]): Promise<void> {
  const sb = requireSupabase()
  const { data: session } = await sb.auth.getSession()
  const userId = session.session?.user?.id ?? null
  const now = new Date().toISOString()

  const refused: string[] = []
  for (const c of changes) {
    const { data, error } = await sb
      .from('gmb_settings')
      .update({ value: c.value, updated_at: now, updated_by: userId })
      .eq('key', c.key)
      .select('key')
    if (error) throw error
    if (!data || data.length === 0) refused.push(c.key)
  }

  if (refused.length) {
    throw new Error(
      `Not saved: ${refused.join(', ')}. These keys are developer-only — ask a portal administrator.`,
    )
  }
}

/** Есть ли вообще подключение к базе (экран показывает понятную ошибку вместо пустоты). */
export function gmbConfigured(): boolean {
  return supabase !== null
}
