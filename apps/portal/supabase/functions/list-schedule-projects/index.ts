// Supabase Edge Function: list-schedule-projects
//
// Возвращает актуальный список проектов из Airtable «General Project Info» для селектора апки
// 03-Production — Send Buildertrend Schedule. Тянется вживую на каждый запрос (свежие проекты).
//
// Зачем прокси: значение проекта, которое апка отправляет в Make, должно ТОЧНО совпадать с
// формулой поиска сценария `{Project Name} = '{{12.project}}'`. Значит список обязан идти из
// той же базы Airtable, а не из Supabase `projects` (Buildertrend-синк — другой набор/формат).
// Ключ Airtable живёт в secrets функции (AIRTABLE_TOKEN) и во фронт не попадает.
//
// Ответ: { projects: [{ name, label }] }
//   • name  — значение `Project Name` (шлём в вебхук; напр. "20-12-11 Allred-Takoma Park, MD")
//   • label — подпись для селектора; если задан AIRTABLE_STATUS_FIELD — префиксуется статусом
//             в стиле JotForm ("DEPOSIT_…"/"PROP_…"), иначе = name.
//
// Настройка через secrets (Supabase → Edge Functions → Secrets):
//   AIRTABLE_TOKEN         (required) — Personal Access Token, scope data.records:read на базу
//   AIRTABLE_BASE          (опц., default appucrtf5MBcFXVza)
//   AIRTABLE_TABLE         (опц., default "General Project Info")
//   AIRTABLE_VIEW          (опц., но РЕКОМЕНДУЕТСЯ) — id/имя вью, что кормит форму (тот же фильтр
//                          и сортировка, что видит PM; иначе вернутся все ~665 записей)
//   AIRTABLE_STATUS_FIELD  (опц.) — поле для префикса метки (DEPOSIT/PROP). Не задан → без префикса.

// ⚠️ SEC-9. `verify_jwt = true` в config.toml НЕ означает «вызвал залогиненный человек»:
// шлюз проверяет только подпись токена, а публичный anon-ключ — такой же подписанный JWT
// и лежит в JS-бандле портала. До этой проверки функция отдавала весь список проектов
// Airtable (681 запись: фамилии клиентов и города) любому, кто открывал портал.
// Отличаем живую сессию от anon-ключа по наличию пользователя: у anon-ключа роль `anon`
// и нет claim `sub`, поэтому /auth/v1/user на нём возвращает 403.

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const BASE = Deno.env.get('AIRTABLE_BASE') ?? 'appucrtf5MBcFXVza'
const TABLE = Deno.env.get('AIRTABLE_TABLE') ?? 'General Project Info'
const VIEW = Deno.env.get('AIRTABLE_VIEW') ?? ''
const STATUS_FIELD = Deno.env.get('AIRTABLE_STATUS_FIELD') ?? ''
const TOKEN = Deno.env.get('AIRTABLE_TOKEN') ?? ''
const NAME_FIELD = 'Project Name'

// Инжектится платформой в каждую edge-функцию.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

/** base64url → строка (в токене payload закодирован именно так). */
function b64url(s: string): string {
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4) s += '='
  return atob(s)
}

/**
 * Есть ли за запросом реальный пользователь.
 *
 * Проверка сделана тем же способом, что в `set-team-password` — он на этом стеке
 * единственный рабочий (см. заметки по edge-auth):
 *   • `auth.getUser(jwt)` в supabase-js аргумент игнорирует и падает «Auth session missing»;
 *   • `/auth/v1/user` на проектах с новыми ключами отбивает и валидные токены (`bad_jwt`).
 * Поэтому: достаём `sub` из payload (у anon-ключа его нет вовсе — роль `anon`, claim `sub`
 * отсутствует → отсекается здесь же), затем убеждаемся, что токен настоящий, сходив с ним
 * на `/rest` — подпись там проверяет шлюз, поддельный токен даёт 401.
 *
 * Токен берём и из тела тоже: платформа умеет портить заголовок `Authorization`.
 */
async function callerUserId(req: Request, body: Record<string, unknown>): Promise<string | null> {
  const headerToken = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  const token = String(body.access_token ?? '') || headerToken
  if (!token || !SUPABASE_URL || !ANON_KEY) return null

  let sub = ''
  try {
    sub = JSON.parse(b64url(token.split('.')[1] ?? '')).sub ?? ''
  } catch {
    return null
  }
  if (!sub) return null // anon-ключ: подписан проектом, но пользователя за ним нет

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=user_id&user_id=eq.${sub}&limit=1`, {
      headers: { Authorization: `Bearer ${token}`, apikey: ANON_KEY },
    })
    return r.ok ? sub : null
  } catch {
    return null
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const body = await req.json().catch(() => ({}))
  if (!(await callerUserId(req, body as Record<string, unknown>))) {
    return new Response(JSON.stringify({ error: 'Sign in to load the project list.' }), {
      status: 401,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  try {
    if (!TOKEN) throw new Error('AIRTABLE_TOKEN secret is not set')

    const projects: { name: string; label: string }[] = []
    let offset: string | undefined

    do {
      const url = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(TABLE)}`)
      url.searchParams.set('pageSize', '100')
      url.searchParams.append('fields[]', NAME_FIELD)
      if (STATUS_FIELD) url.searchParams.append('fields[]', STATUS_FIELD)
      if (VIEW) url.searchParams.set('view', VIEW)
      if (offset) url.searchParams.set('offset', offset)

      const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${TOKEN}` } })
      if (!r.ok) throw new Error(`Airtable ${r.status}: ${await r.text()}`)
      const data = await r.json()

      for (const rec of data.records ?? []) {
        const name = String(rec.fields?.[NAME_FIELD] ?? '').trim()
        if (!name) continue
        const status = STATUS_FIELD ? String(rec.fields?.[STATUS_FIELD] ?? '').trim() : ''
        projects.push({ name, label: status ? `${status}_${name}` : name })
      }
      offset = data.offset
    } while (offset)

    return new Response(JSON.stringify({ projects }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
