// View As (миграция 0046): сессия, которую разработчик открыл «глазами пользователя», — только
// для чтения. База сама отклоняет запись из такой сессии, но edge-функции пишут сервисным
// ключом и этот запрет не видят — поэтому каждая функция, которая что-то меняет, спрашивает здесь.
//
// Проверка — RPC `portal_view_as_active` под токеном вызывающего: шлюз /rest проверит подпись,
// функция ответит, есть ли его сессия в журнале. Токены без session_id (anon, service, cron)
// пользователем не являются — их не трогаем.

function claimsOf(token: string): Record<string, unknown> {
  try {
    let s = (token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/')
    while (s.length % 4) s += '='
    return JSON.parse(atob(s))
  } catch {
    return {}
  }
}

/** true — запрос пришёл из сессии View As, менять ничего нельзя. */
export async function isViewAsSession(token: string | null | undefined): Promise<boolean> {
  const t = (token ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!t || !claimsOf(t).session_id) return false
  const url = Deno.env.get('SUPABASE_URL')!
  const anon = Deno.env.get('SUPABASE_ANON_KEY')!
  try {
    const r = await fetch(`${url}/rest/v1/rpc/portal_view_as_active`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${t}`, apikey: anon, 'Content-Type': 'application/json' },
      body: '{}',
    })
    if (!r.ok) return false // невалидный токен отсечёт собственная проверка функции
    return (await r.json()) === true
  } catch {
    return false
  }
}

export const VIEW_AS_READONLY = 'View As is read-only: this action is not available while viewing as another user'
