/**
 * 07 Finances — Receipts Matcher · редактируемые промпты (BAS-1473).
 *
 * Две таблицы Никиты (BAS-1498):
 *   receipt_matcher_prompt_keys — каталог: label, what_it_does, where_used, min_len, max_len,
 *                                 sort_order, required_tokens. Форма строится ПО НЕМУ.
 *   receipt_matcher_prompts     — сам текст: key, value, updated_at, updated_by.
 *
 * `required_tokens` — jsonb; enum-значения лежат ВМЕСТЕ с кавычками (`"we_paid"`), имена
 * полей — без (`amount_cents`). Сверяем строку целиком, как есть.
 *
 * Промпт — инструкция модели, чей ответ дальше разбирается ПО ИМЕНАМ (`we_paid`,
 * `amount_source`…). Прозу переписывать можно, эти имена — нет. Читатель отклоняет текст,
 * потерявший токен, и автоматизация молча остаётся на старом — поэтому экран обязан отклонить
 * то же самое сохранение сам, иначе на экране «сохранено», а в пайплайне тишина.
 *
 * Текст хранится ровно как отправляется модели: ничего не обрезаем и не нормализуем.
 */

export interface PromptKey {
  key: string
  label: string
  whatItDoes: string | null
  whereUsed: string | null
  minLen: number | null
  maxLen: number | null
  sortOrder: number
  requiredTokens: string[]
}

export interface PromptValue {
  key: string
  value: string
  updatedAt: string | null
}

/** required_tokens может прийти text[] или jsonb-массивом — берём строки, остальное отбрасываем. */
export function parseTokens(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((t): t is string => typeof t === 'string' && t.length > 0)
}

/** Токены, которых больше нет в тексте. Проверка — точное вхождение подстроки, с учётом регистра. */
export function missingTokens(text: string, tokens: string[]): string[] {
  return tokens.filter((t) => !text.includes(t))
}

/**
 * Длина — как считает читатель `receipts-prompts` (core.ts, Никита): `value.length`, то есть в
 * UTF-16 единицах JS. Он и решает, примет ли автоматизация текст, поэтому экран считает так же.
 */
export function charLength(text: string): number {
  return text.length
}

/** Токен для сообщения: в каталоге enum-значения хранятся уже в кавычках (`"we_paid"`) — не задваиваем. */
function quoted(t: string): string {
  return t.startsWith('"') ? t : `"${t}"`
}

/** Ошибки поля (пустой массив — можно сохранять). Каждая — готовая фраза для человека. */
export function validatePrompt(text: string, meta: Pick<PromptKey, 'minLen' | 'maxLen' | 'requiredTokens'>): string[] {
  const out: string[] = []
  if (!text.trim()) {
    out.push('The prompt cannot be empty.')
    return out
  }
  for (const t of missingTokens(text, meta.requiredTokens)) {
    out.push(
      `This prompt no longer mentions ${quoted(t)}. That value is read out of the model's answer, so the automation would refuse this text and keep the previous one.`,
    )
  }
  const len = charLength(text)
  if (meta.minLen != null && len < meta.minLen) {
    out.push(
      `The prompt is ${len} characters; it needs at least ${meta.minLen}. A prompt that suddenly got this short is usually a paste that went wrong.`,
    )
  }
  if (meta.maxLen != null && len > meta.maxLen) {
    out.push(`The prompt is ${len} characters; the limit is ${meta.maxLen}.`)
  }
  return out
}

export function lengthHint(text: string, meta: Pick<PromptKey, 'minLen' | 'maxLen'>): string {
  const bounds =
    meta.minLen != null && meta.maxLen != null
      ? `${meta.minLen}–${meta.maxLen}`
      : meta.maxLen != null
        ? `up to ${meta.maxLen}`
        : meta.minLen != null
          ? `at least ${meta.minLen}`
          : null
  const len = charLength(text)
  return bounds ? `${len} characters · allowed ${bounds}` : `${len} characters`
}
