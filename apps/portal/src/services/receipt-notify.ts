import { requireSupabase } from '../lib/supabase'
import { NOTIFY_KEYS, parseRecipients, type NotifyKey, type NotifySetting } from '../domain/receipt-notify'

/**
 * 07 Finances — Receipts Matcher · получатели уведомлений (BAS-1474).
 *
 * `receipt_matcher_settings` (Никита) — три строки, заведены и засижены. Права — те же, что у
 * всех `receipt_*`: `user_has_application_access(auth.uid(), '/receipt-import')` или админ.
 * DELETE база не даёт вовсе: «никого не уведомлять» — это сохранённый `[]`.
 */

export async function loadNotify(): Promise<NotifySetting[]> {
  const sb = requireSupabase()
  const { data, error } = await sb.from('receipt_matcher_settings').select('key, value, updated_at')
  if (error) throw error
  const byKey = new Map((data ?? []).map((r) => [r.key as string, r]))
  // Порядок и набор — из NOTIFY_KEYS: строка, которой вдруг нет в базе, всё равно видна пустой,
  // но сохранить её экран не сможет (UPDATE без строки) — и честно скажет об этом.
  return NOTIFY_KEYS.map(({ key }) => {
    const r = byKey.get(key)
    return { key, value: parseRecipients(r?.value), updatedAt: (r?.updated_at as string | null) ?? null }
  })
}

/**
 * Сохранить изменённые списки. UPDATE, а не upsert: все три строки заведены вместе с таблицей.
 * `.select('key')` ловит тихий no-op, когда RLS не пустила запись: Supabase не отдаёт ошибку,
 * просто ничего не обновляет — без проверки экран показал бы «Saved ✓».
 */
export async function saveNotify(changes: { key: NotifyKey; value: unknown }[]): Promise<void> {
  const sb = requireSupabase()
  const { data: session } = await sb.auth.getSession()
  const userId = session.session?.user?.id ?? null
  const now = new Date().toISOString()

  const refused: string[] = []
  for (const c of changes) {
    const { data, error } = await sb
      .from('receipt_matcher_settings')
      .update({ value: c.value, updated_at: now, updated_by: userId })
      .eq('key', c.key)
      .select('key')
    if (error) throw error
    if (!data || data.length === 0) refused.push(c.key)
  }

  if (refused.length) {
    throw new Error(`Not saved: ${refused.join(', ')}. You may not have access to Receipts Matcher settings — ask a portal administrator.`)
  }
}
