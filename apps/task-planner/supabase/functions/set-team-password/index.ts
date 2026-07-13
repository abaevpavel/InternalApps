// Task Planner — задать/сбросить пароль члену бригады (только для super_admin).
// Универсальная: нет auth-аккаунта → создаёт с паролем; есть → меняет пароль.
// Опознание вызывающего — через клиент, привязанный к его Authorization (надёжнее,
// чем getUser(jwt) на service-role). Привилегированные операции — service_role.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const ROLES = ['super_admin', 'pm', 'team_lead']

Deno.serve(async (req) => {
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    // Публичный ключ для проверки токена через /rest — берём из env проекта (не хардкод).
    // Supabase инжектит SUPABASE_ANON_KEY в edge-функции автоматически.
    const PUBLISHABLE_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

    const body = await req.json().catch(() => ({}))

    // 1) опознать вызывающего: токен из заголовка ИЛИ из тела (обход срезания хедера).
    //    Валидируем токен напрямую через /auth/v1/user — getUser(jwt) в JSR-версии
    //    игнорирует аргумент и падает «Auth session missing».
    const headerToken = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    // Тело в приоритете: платформа может портить заголовок Authorization.
    const token = String(body.access_token ?? '') || headerToken
    if (!token) return json({ error: 'Missing token (header and body both empty)' }, 401)

    // Декодим sub из токена. Доверяем ему ТОЛЬКО потому, что запрос ниже под этим же
    // токеном идёт через шлюз /rest — шлюз проверяет подпись (поддельный токен → 401).
    const b64 = (s: string) => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return atob(s) }
    let sub = ''
    try { sub = JSON.parse(b64(token.split('.')[1] ?? '')).sub ?? '' } catch { /* ignore */ }
    if (!sub) return json({ error: 'Bad token' }, 401)

    // 2) проверить токен + роль super_admin через /rest (тем же путём, что работает в app)
    const roleRes = await fetch(
      `${SUPABASE_URL}/rest/v1/tp_user_roles?select=role&user_id=eq.${sub}&role=eq.super_admin`,
      { headers: { Authorization: `Bearer ${token}`, apikey: PUBLISHABLE_KEY } },
    )
    if (roleRes.status === 401 || roleRes.status === 403) return json({ error: `Invalid token (rest ${roleRes.status})` }, 401)
    if (!roleRes.ok) return json({ error: `Auth check failed (rest ${roleRes.status})` }, 500)
    const roleRows = await roleRes.json()
    if (!Array.isArray(roleRows) || roleRows.length === 0) return json({ error: 'Forbidden: super_admin only' }, 403)
    const callerId = sub

    // привилегированные операции — service_role
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

    // 3) вход
    const email = String(body.email ?? '').trim().toLowerCase()
    const password = String(body.password ?? '')
    const role = ROLES.includes(body.role) ? body.role : 'team_lead'
    const first_name = body.first_name ? String(body.first_name) : null
    const last_name = body.last_name ? String(body.last_name) : null
    if (!email.includes('@')) return json({ error: 'Valid email required' }, 400)
    if (password.length < 6) return json({ error: 'Password must be at least 6 characters' }, 400)

    // 4) найти или создать auth-пользователя по email
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
      const { data: c, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { first_name, last_name },
      })
      if (error) return json({ error: error.message }, 400)
      userId = c.user.id
      created = true
    }

    // 5) профиль + роль (идемпотентно)
    const { error: pErr } = await admin.from('tp_profiles').upsert(
      { user_id: userId, email, first_name, last_name },
      { onConflict: 'user_id' },
    )
    if (pErr) return json({ error: `Profile upsert failed: ${pErr.message}` }, 400)
    await admin.from('tp_user_roles').delete().eq('user_id', userId)
    const { error: urErr } = await admin.from('tp_user_roles').insert({ user_id: userId, role })
    if (urErr) return json({ error: `Role insert failed: ${urErr.message}` }, 400)

    return json({ ok: true, user_id: userId, created, role })
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
