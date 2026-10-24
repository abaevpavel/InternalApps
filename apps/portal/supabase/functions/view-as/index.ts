// Портал — View As: посмотреть портал глазами другого пользователя (только роль Developer).
//
//   action 'list'  — кого можно выбрать: пользователи портала с привязанным аккаунтом, их
//                    портальные роли и роли модулей (для подписи в выборе).
//   action 'start' — открыть сессию выбранного пользователя и вернуть её токены. Сессия
//                    создаётся на сервере: magic link (generateLink письма НЕ шлёт) →
//                    verifyOtp. Её id пишется в portal_view_as_sessions — по нему база
//                    запрещает любую запись из этой сессии (миграция 0046).
//   action 'end'   — отметить конец просмотра (токен — той самой сессии просмотра).
//
// Опознание вызывающего — как в `set-portal-password`: `sub` из payload + проверка подписи
// запросом через шлюз `/rest` под его токеном. Токен принимаем и из тела.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function payloadOf(token: string): Record<string, unknown> {
  try {
    let s = (token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/')
    while (s.length % 4) s += '='
    return JSON.parse(atob(s))
  } catch {
    return {}
  }
}

Deno.serve(async (req) => {
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

    const body = await req.json().catch(() => ({}))
    const action = String(body.action ?? '')
    const headerToken = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
    const token = String(body.access_token ?? '') || headerToken
    if (!token) return json({ error: 'Missing token' }, 401)
    const claims = payloadOf(token)
    const sub = String(claims.sub ?? '')
    if (!sub) return json({ error: 'Bad token' }, 401)

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

    // Подпись токена проверяет шлюз /rest (поддельный → 401); функция отвечает, Developer ли он.
    const rpc = async (fn: string, args: unknown) => {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, apikey: ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      })
      if (r.status === 401 || r.status === 403) throw Object.assign(new Error(`Invalid token (rest ${r.status})`), { status: 401 })
      if (!r.ok) throw new Error(`Auth check failed (rest ${r.status})`)
      return r.json()
    }

    if (action === 'end') {
      // Токен — сессии просмотра; закрываем только запись о ней (сессию клиент закроет сам).
      await rpc('portal_view_as_active', {})
      const sid = String(claims.session_id ?? '')
      if (sid) {
        await admin.from('portal_view_as_sessions').update({ ended_at: new Date().toISOString() })
          .eq('session_id', sid).is('ended_at', null)
      }
      return json({ ok: true })
    }

    if ((await rpc('user_has_developer_role', { user_id: sub })) !== true) {
      return json({ error: 'Forbidden: View As is for Developers only' }, 403)
    }

    if (action === 'list') {
      const [profiles, userRoles, roles, appRoles] = await Promise.all([
        admin.from('profiles').select('user_id, email, first_name, last_name').not('user_id', 'is', null),
        admin.from('user_roles').select('user_id, role_id'),
        admin.from('roles').select('id, name'),
        admin.from('app_user_roles').select('user_id, app_code, role_key'),
      ])
      for (const r of [profiles, userRoles, roles, appRoles]) if (r.error) return json({ error: r.error.message }, 500)
      const roleName = new Map((roles.data ?? []).map((r) => [r.id, r.name as string]))
      // Сам разработчик — первым: из просмотра к себе возвращаются одним кликом.
      const users = (profiles.data ?? [])
        .map((p) => ({
          is_me: p.user_id === sub,
          user_id: p.user_id,
          email: p.email,
          name: [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email,
          portal_roles: (userRoles.data ?? []).filter((u) => u.user_id === p.user_id).map((u) => roleName.get(u.role_id)).filter(Boolean),
          app_roles: (appRoles.data ?? []).filter((a) => a.user_id === p.user_id).map((a) => ({ app: a.app_code, role: a.role_key })),
        }))
        .sort((a, b) => Number(b.is_me) - Number(a.is_me) || a.name.localeCompare(b.name))
      return json({ users })
    }

    if (action === 'start') {
      const targetId = String(body.user_id ?? '')
      if (!targetId || targetId === sub) return json({ error: 'Pick another user' }, 400)
      const { data: prof } = await admin.from('profiles').select('email, first_name, last_name').eq('user_id', targetId).maybeSingle()
      if (!prof) return json({ error: 'This user has no portal profile' }, 400)
      const { data: u, error: uErr } = await admin.auth.admin.getUserById(targetId)
      if (uErr || !u.user?.email) return json({ error: uErr?.message ?? 'User has no email' }, 400)

      const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email: u.user.email })
      if (linkErr) return json({ error: `Link failed: ${linkErr.message}` }, 400)
      const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
      const { data: sess, error: otpErr } = await anon.auth.verifyOtp({ type: 'magiclink', token_hash: link.properties.hashed_token })
      if (otpErr || !sess.session) return json({ error: `Session failed: ${otpErr?.message ?? 'no session'}` }, 400)

      const sid = String(payloadOf(sess.session.access_token).session_id ?? '')
      if (!sid) return json({ error: 'Session has no id' }, 500)
      const { error: logErr } = await admin.from('portal_view_as_sessions').insert({
        session_id: sid, developer_id: sub, developer_email: String(claims.email ?? ''),
        target_user_id: targetId, target_email: u.user.email,
      })
      // Без записи в журнале сессия не была бы «только для чтения» — тогда её не отдаём.
      if (logErr) {
        await admin.auth.admin.signOut(sess.session.access_token, 'local').catch(() => {})
        return json({ error: `Could not register the session: ${logErr.message}` }, 500)
      }
      return json({
        access_token: sess.session.access_token,
        refresh_token: sess.session.refresh_token,
        target: {
          user_id: targetId,
          email: u.user.email,
          name: [prof.first_name, prof.last_name].filter(Boolean).join(' ') || u.user.email,
        },
      })
    }

    return json({ error: `Unknown action: ${action}` }, 400)
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500
    return json({ error: e instanceof Error ? e.message : String(e) }, status)
  }
})
