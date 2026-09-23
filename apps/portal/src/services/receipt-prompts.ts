import { requireSupabase } from '../lib/supabase'
import { parseTokens, type PromptKey, type PromptValue } from '../domain/receipt-prompts'

/**
 * 07 Finances — Receipts Matcher · промпты (BAS-1473).
 *
 * Каталог `receipt_matcher_prompt_keys` для браузера только на чтение, у текстов
 * `receipt_matcher_prompts` нет DELETE: промпт меняют, но не удаляют — отсутствующая строка
 * вернула бы автоматизацию к копии, зашитой в её узел. Права — как у всех `receipt_*`
 * (`/receipt-import` или админ). Сохранение действует со следующего прогона, кэша нет.
 */

export async function loadPrompts(): Promise<{ keys: PromptKey[]; values: PromptValue[] }> {
  const sb = requireSupabase()
  const [keysRes, valuesRes] = await Promise.all([
    sb
      .from('receipt_matcher_prompt_keys')
      .select('key, label, what_it_does, where_used, min_len, max_len, sort_order, required_tokens')
      .order('sort_order'),
    sb.from('receipt_matcher_prompts').select('key, value, updated_at'),
  ])
  if (keysRes.error) throw keysRes.error
  if (valuesRes.error) throw valuesRes.error

  const keys: PromptKey[] = (keysRes.data ?? []).map((r) => ({
    key: r.key as string,
    label: (r.label as string | null) ?? (r.key as string),
    whatItDoes: (r.what_it_does as string | null) ?? null,
    whereUsed: (r.where_used as string | null) ?? null,
    minLen: (r.min_len as number | null) ?? null,
    maxLen: (r.max_len as number | null) ?? null,
    sortOrder: (r.sort_order as number | null) ?? 0,
    requiredTokens: parseTokens(r.required_tokens),
  }))

  const values: PromptValue[] = (valuesRes.data ?? []).map((r) => ({
    key: r.key as string,
    value: (r.value as string | null) ?? '',
    updatedAt: (r.updated_at as string | null) ?? null,
  }))

  return { keys, values }
}

/**
 * Сохранить изменённые промпты — текст ровно как в поле. UPDATE (все строки засижены);
 * `.select('key')` ловит тихий отказ RLS, иначе экран показал бы «Saved ✓».
 */
export async function savePrompts(changes: { key: string; value: string }[]): Promise<void> {
  const sb = requireSupabase()
  const { data: session } = await sb.auth.getSession()
  const userId = session.session?.user?.id ?? null
  const now = new Date().toISOString()

  const refused: string[] = []
  for (const c of changes) {
    const { data, error } = await sb
      .from('receipt_matcher_prompts')
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
