import { requireSupabase } from '../lib/supabase'

/**
 * 06-HR-Gmail Auto Sender: вызывает существующую edge-функцию `gmail-auth`
 * (та же Supabase, что портал), которая проксирует запрос в AWS API Gateway и
 * возвращает Google OAuth consent URL. Приложение ничего не хранит — токены на AWS.
 *
 * Контракт edge: POST { email } → { success, message } | { error }
 * где message — text/JSON-строка вида { "authentication_url": "https://accounts.google…" }.
 */
export async function setupGmailAuth(email: string): Promise<string> {
  const sb = requireSupabase()
  const { data, error } = await sb.functions.invoke('gmail-auth', { body: { email } })
  if (error) throw error
  if (data?.error) throw new Error(String(data.details ?? data.error))

  const raw = data?.message ?? data
  let url: string | undefined
  if (typeof raw === 'string') {
    try {
      url = JSON.parse(raw)?.authentication_url
    } catch {
      if (/^https?:\/\//.test(raw)) url = raw
    }
  } else if (raw && typeof raw === 'object') {
    url = (raw as { authentication_url?: string }).authentication_url
  }
  if (!url) throw new Error('No authentication_url in response')
  return url
}

/** Простая валидация формата email (в оригинале проверялась только непустота). */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}
