import { supabase } from './supabase'

/**
 * SSO-хэндофф: портал передаёт Supabase-сессию дочернему приложению через
 * URL-fragment (`#sso=<base64>`), т.к. localStorage между субдоменами не шарится.
 * Fragment не уходит на сервер/в логи. Приложение на своей стороне делает
 * `supabase.auth.setSession({access_token, refresh_token})` и чистит hash
 * (консюмер будет в packages/lib, чтобы каждая апка не писала своё).
 */
export async function buildAppUrl(url: string): Promise<string> {
  if (!supabase) return url
  const { data } = await supabase.auth.getSession()
  const s = data.session
  if (!s) return url
  const payload = btoa(JSON.stringify({ at: s.access_token, rt: s.refresh_token }))
  return `${url}#sso=${payload}`
}

export async function openApp(url: string): Promise<void> {
  const target = await buildAppUrl(url)
  window.open(target, '_blank')
}
