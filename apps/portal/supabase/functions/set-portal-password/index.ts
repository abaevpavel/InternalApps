// Портал — задать/сбросить пароль пользователю (только для админа портала).
//
// Зачем: OAuth-клиент портала — Internal, поэтому почта вне домена организации через
// Google не войдёт вообще (подрядчики, бригады). Пароль — единственный путь для них.
// Письма не шлём: аккаунт создаётся сразу подтверждённым (`email_confirm: true`),
// поэтому свой SMTP в Supabase не нужен. Пароль админ передаёт человеку сам.
//
// Whitelist не ослабляем: пароль можно задать ТОЛЬКО тому, кто уже в контуре допуска —
// есть профиль либо живое приглашение. Иначе получился бы аккаунт, который всё равно
// упрётся в «Access denied», но уже существовал бы в auth.users.
//
// Опознание вызывающего — как в `set-team-password` / `gmail-auth` (единственный рабочий
// способ на этом стеке): `sub` из payload + подтверждение подписи запросом через шлюз
// `/rest`. Токен принимаем и из тела: платформа умеет портить заголовок Authorization.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const MIN_PASSWORD = 8

Deno.serve(async (req) => {
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

    const body = await req.json().catch(() => ({}))

    // 1) токен вызывающего: тело в приоритете (заголовок может быть срезан прокси)
    const headerToken = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
    const token = String(body.access_token ?? '') || headerToken
    if (!token) return json({ error: 'Missing token (header and body both empty)' }, 401)

    const b64 = (s: string) => {
      s = s.replace(/-/g, '+').replace(/_/g, '/')
      while (s.length % 4) s += '='
      return atob(s)
    }
    let sub = ''
    try {
      sub = JSON.parse(b64(token.split('.')[1] ?? '')).sub ?? ''
    } catch { /* ignore */ }
    // У anon-ключа `sub` нет — он подписан проектом, но пользователя за ним не стоит.
    if (!sub) return json({ error: 'Bad token' }, 401)

    // 2) админ ли он. RPC зовём через /rest под ЕГО токеном: шлюз проверит подпись
    //    (поддельный токен → 401), а сама функция вернёт результат whitelist-проверки.
    const adminRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/user_has_admin_role`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ user_id: sub }),
    })
    if (adminRes.status === 401 || adminRes.status === 403) {
      return json({ error: `Invalid token (rest ${adminRes.status})` }, 401)
    }
    if (!adminRes.ok) return json({ error: `Auth check failed (rest ${adminRes.status})` }, 500)
    if ((await adminRes.json()) !== true) return json({ error: 'Forbidden: portal admins only' }, 403)

    // 3) вход
    const email = String(body.email ?? '').trim().toLowerCase()
    const password = String(body.password ?? '')
    if (!email.includes('@')) return json({ error: 'Valid email required' }, 400)
    if (password.length < MIN_PASSWORD) {
      return json({ error: `Password must be at least ${MIN_PASSWORD} characters` }, 400)
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

    // 4) whitelist: профиль ИЛИ живое приглашение на этот email
    const { data: prof, error: profErr } = await admin
      .from('profiles')
      .select('id')
      .ilike('email', email)
      .limit(1)
    if (profErr) return json({ error: `Whitelist check failed: ${profErr.message}` }, 500)

    let allowed = (prof ?? []).length > 0
    if (!allowed) {
      const { data: inv, error: invErr } = await admin
        .from('invitations')
        .select('id')
        .ilike('email', email)
        .is('accepted_at', null)
        .limit(1)
      if (invErr) return json({ error: `Whitelist check failed: ${invErr.message}` }, 500)
      allowed = (inv ?? []).length > 0
    }
    if (!allowed) {
      return json({ error: 'This email is not invited to the portal. Add the user first.' }, 400)
    }

    // 5) найти или создать auth-аккаунт по email
    const { data: list, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
    if (listErr) return json({ error: `List users failed: ${listErr.message}` }, 400)
    const found = list.users.find((u) => (u.email ?? '').toLowerCase() === email)

    let userId: string
    let created = false
    if (found) {
      const { error } = await admin.auth.admin.updateUserById(found.id, { password })
      if (error) return json({ error: error.message }, 400)
      userId = found.id
    } else {
      // email_confirm: true — без подтверждающего письма, SMTP проекту не нужен.
      // Триггер `on_auth_user_created_accept_invitation` (миграция 0010) на этом INSERT
      // сам примет приглашение: создаст профиль и проставит роли.
      const { data: c, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
      })
      if (error) return json({ error: error.message }, 400)
      userId = c.user!.id
      created = true
    }

    // Приглашение здесь не принимаем: если аккаунт уже существовал (входил через Google
    // и упёрся в «Access denied»), триггер на INSERT не сработает — но при первом входе
    // портал сам зовёт `accept_my_invitation()` (см. AuthProvider.loadProfile). Дублировать
    // это здесь нельзя: у `accept_invitation_for` EXECUTE отозван у всех, кроме владельца.
    return json({ ok: true, user_id: userId, created })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
