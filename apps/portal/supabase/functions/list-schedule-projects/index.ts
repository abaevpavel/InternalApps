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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

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
