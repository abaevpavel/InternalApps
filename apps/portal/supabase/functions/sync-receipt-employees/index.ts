// Supabase Edge Function: sync-receipt-employees (BAS-1472)
//
// Сотрудники для 07 Finances — Receipts Matcher: Airtable «All employees» → public.receipt_matcher_employees.
// Только в ОДНУ сторону и только личность: record id, Full Name, Email.
//
// Правила из хендоффа Никиты (вложение к BAS-1472), каждое — по делу:
//   • сопоставление ТОЛЬКО по airtable_record_id, никогда по имени: переименованный в Airtable
//     человек сохраняет id, а совпадение по имени завело бы дубль;
//   • full_name пишем байт в байт как в Airtable — без trim, схлопывания двойных пробелов и
//     title-case: это ключ сопоставления у автоматизации («Oscar  Herrera » — с двумя пробелами и
//     хвостовым, так и должно остаться);
//   • пропавший из Airtable — active = false, НЕ удаление; вернулся — снова active = true;
//   • таблицу карт `receipt_matcher_card_numbers` синк не трогает вообще — у неё нет источника,
//     кроме экрана.
// Добавление человека из портала (`action: 'add_employee'`, фича поверх BAS-1472): строка
// создаётся в 05-Contacts Directory (источник синхронизированной «All employees») с
// Category = Employee. У нас человек появляется ПОСЛЕ синхронизации Airtable и нашего синка —
// только так у него будет тот record id, на который ссылаются чеки. Автоматике (cron) недоступно.
//
// Кто может вызвать:
//   • pg_cron раз в сутки — заголовок `x-sync-secret` = секрет RECEIPT_SYNC_SECRET;
//   • человек кнопкой «Sync now» — его токен (в теле: платформа портит Authorization). Права
//     проверяем чтением receipt_matcher_employees ПОД ЕГО токеном: таблица закрыта тем же RLS
//     `/receipt-import` (или админ), засижена, поэтому пустой ответ = нет доступа.
//
// Secrets: AIRTABLE_EMPLOYEES_TOKEN — PAT с data.records:read на base «All employees» (синк) и
// data.records:read + write на 05-Contacts Directory (добавление человека); RECEIPT_SYNC_SECRET.

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-sync-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const BASE = 'appEcdKbrX4LcDzGC'
const TABLE = 'tblHd8Gk2ZCclN9rd' // «All employees» — таблица, на которую ссылается Receipts.Employee
const NAME_FIELD = 'Full Name'
const EMAIL_FIELD = 'Email'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
// Свой токен на base сотрудников (read + write). Общий AIRTABLE_TOKEN заведён под Buildertrend
// Schedule и видит только base appucrtf5MBcFXVza — он здесь лишь запасной вариант.
const AIRTABLE_TOKEN = Deno.env.get('AIRTABLE_EMPLOYEES_TOKEN') ?? Deno.env.get('AIRTABLE_TOKEN') ?? ''
const SYNC_SECRET = Deno.env.get('RECEIPT_SYNC_SECRET') ?? ''

/**
 * Откуда «All employees» берёт строки. Сама «All employees» — СИНХРОНИЗИРОВАННАЯ таблица Airtable:
 * создавать в ней записи Airtable не даёт никому («the underlying table is externally synced»).
 * Источник — 05-Contacts Directory, вью «all employee» с фильтром Category = Employee.
 */
const DIRECTORY_BASE = 'appiScywNMqBk3x9e'
const DIRECTORY_TABLE = 'tblVvfgjkGMGHWexL'
const CATEGORY_FIELD = 'Category'
const FIRST_FIELD = 'F_Name'
const LAST_FIELD = 'L_Name'
const TITLE_FIELD = 'Title/Position'
const DEPARTMENT_FIELD = 'Department'
const HEADSHOT_FIELD = 'Headshot'
/** Фото уходит в теле запроса base64 — держим его небольшим (лимит Airtable на загрузку — 5 МБ). */
const HEADSHOT_MAX_BYTES = 3 * 1024 * 1024

/**
 * Варианты для формы: отделы и должности, которые уже есть в справочнике. Берём из самих
 * записей, а не из схемы base — так не нужен отдельный scope schema.bases:read. Отдел, который
 * не стоит ни у одной записи, в список не попадёт — его выбирают в Airtable.
 */
async function directoryOptions(): Promise<Response> {
  const departments = new Set<string>()
  const titles = new Set<string>()
  let offset: string | undefined
  do {
    const url = new URL(`https://api.airtable.com/v0/${DIRECTORY_BASE}/${DIRECTORY_TABLE}`)
    url.searchParams.set('pageSize', '100')
    url.searchParams.append('fields[]', DEPARTMENT_FIELD)
    url.searchParams.append('fields[]', TITLE_FIELD)
    url.searchParams.set('filterByFormula', `{${CATEGORY_FIELD}}='${EMPLOYEE_CATEGORY}'`)
    if (offset) url.searchParams.set('offset', offset)
    const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } })
    if (!r.ok) return json({ error: airtableError(r.status, (await r.text()).slice(0, 300)) }, 502)
    const data = await r.json()
    for (const rec of data.records ?? []) {
      const d = rec.fields?.[DEPARTMENT_FIELD]
      for (const v of Array.isArray(d) ? d : d ? [d] : []) if (typeof v === 'string' && v.trim()) departments.add(v)
      const t = asText(rec.fields?.[TITLE_FIELD])
      if (t && t.trim() && t.trim() !== 'n/a') titles.add(t.trim())
    }
    offset = data.offset
  } while (offset)
  return json({
    departments: [...departments].sort((a, b) => a.localeCompare(b)),
    titles: [...titles].sort((a, b) => a.localeCompare(b)),
  })
}
const EMPLOYEE_CATEGORY = 'Employee'

/**
 * Добавить человека: строка в 05-Contacts Directory с Category = Employee. У нас он НЕ заводится
 * сразу: его record id в «All employees» появится только после синхронизации Airtable, а
 * автоматизация чеков ссылается именно на тот id. Дальше его подтянет обычный синк.
 */
async function addEmployee(body: Record<string, unknown>): Promise<Response> {
  // «Full Name» в справочнике — формула: для Category = Employee это {F_Name} & " " & {L_Name}.
  // Пишем её части; края обрезаем, иначе формула дала бы имя с лишним пробелом.
  const first = String(body.first_name ?? '').trim()
  const last = String(body.last_name ?? '').trim()
  const email = String(body.email ?? '').trim() || null
  if (!first || !last) return json({ error: 'Enter both the first and the last name.' }, 400)
  if (first.length > 60 || last.length > 60) return json({ error: 'A name part is longer than 60 characters.' }, 400)
  if (email && !/^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(email)) return json({ error: 'This does not look like an email address.' }, 400)
  const fullName = `${first} ${last}`

  const dirUrl = `https://api.airtable.com/v0/${DIRECTORY_BASE}/${DIRECTORY_TABLE}`
  const auth = { Authorization: `Bearer ${AIRTABLE_TOKEN}` }

  // Такой человек уже есть в справочнике — в любой категории (у не-сотрудника Full Name
  // «Имя Фамилия - Компания», поэтому сравниваем части, а не Full Name).
  const q = (v: string) => `'${v.toLowerCase().replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  const find = new URL(dirUrl)
  find.searchParams.set('filterByFormula', `AND(LOWER(TRIM({${FIRST_FIELD}}))=${q(first)}, LOWER(TRIM({${LAST_FIELD}}))=${q(last)})`)
  find.searchParams.set('maxRecords', '1')
  find.searchParams.append('fields[]', CATEGORY_FIELD)
  const fr = await fetch(find.toString(), { headers: auth })
  if (!fr.ok) return json({ error: airtableError(fr.status, (await fr.text()).slice(0, 300)) }, 502)
  const existing = (await fr.json()).records?.[0]
  if (existing) {
    const cat = asText(existing.fields?.[CATEGORY_FIELD]) ?? 'no category'
    return json(
      {
        error:
          cat === EMPLOYEE_CATEGORY
            ? `${fullName} is already in the Contacts Directory as an employee — press Sync now to bring them here.`
            : `${fullName} is already in the Contacts Directory (category: ${cat}). Change the category to Employee there instead of adding a second person.`,
      },
      409,
    )
  }

  const title = String(body.title ?? '').trim()
  const departments = Array.isArray(body.departments)
    ? (body.departments as unknown[]).filter((d): d is string => typeof d === 'string' && d.trim() !== '')
    : []
  if (title.length > 120) return json({ error: 'The title is longer than 120 characters.' }, 400)

  const headshot = body.headshot as { data?: unknown; content_type?: unknown; filename?: unknown } | undefined
  if (headshot) {
    if (typeof headshot.data !== 'string' || typeof headshot.content_type !== 'string' || !headshot.content_type.startsWith('image/')) {
      return json({ error: 'The headshot must be an image.' }, 400)
    }
    if ((headshot.data.length * 3) / 4 > HEADSHOT_MAX_BYTES) return json({ error: 'The headshot is larger than 3 MB.' }, 413)
  }

  const fields: Record<string, unknown> = { [FIRST_FIELD]: first, [LAST_FIELD]: last, [CATEGORY_FIELD]: EMPLOYEE_CATEGORY }
  if (email) fields[EMAIL_FIELD] = email
  if (title) fields[TITLE_FIELD] = title
  // Только существующие отделы: без typecast Airtable откажет, а не заведёт новый вариант.
  if (departments.length) fields[DEPARTMENT_FIELD] = departments
  const at = await fetch(dirUrl, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ records: [{ fields }] }),
  })
  if (!at.ok) return json({ error: airtableError(at.status, (await at.text()).slice(0, 300)) }, 502)
  const created = (await at.json()).records?.[0]

  // Фото — отдельным запросом к content API уже созданной записи. Не вышло — человек всё равно
  // создан, фото добавят в Airtable руками; говорим об этом, а не молчим.
  let headshotWarning: string | null = null
  if (headshot && created?.id) {
    const up = await fetch(
      `https://content.airtable.com/v0/${DIRECTORY_BASE}/${created.id}/${encodeURIComponent(HEADSHOT_FIELD)}/uploadAttachment`,
      {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentType: headshot.content_type,
          file: headshot.data,
          filename: typeof headshot.filename === 'string' && headshot.filename ? headshot.filename : 'headshot.jpg',
        }),
      },
    )
    if (!up.ok) headshotWarning = `The person was created, but the headshot was not uploaded (Airtable ${up.status}) — add it in Airtable.`
  }
  return json({ ok: true, directory_record_id: created?.id ?? null, full_name: fullName, warning: headshotWarning })
}

function airtableError(status: number, text: string): string {
  const hint =
    status === 401 || status === 403
      ? ' The Airtable token cannot write to the Contacts Directory — it needs data.records:read and data.records:write on that base.'
      : status === 422
        ? ' Airtable refused the fields — check that “F_Name”, “L_Name”, “Email”, “Title/Position”, “Department” and “Category” (with the option “Employee”) exist and are editable in the Contacts Directory, and that the chosen departments are existing options.'
        : ''
  return `Airtable answered ${status}.${hint} ${text}`
}

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

function b64url(s: string): string {
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4) s += '='
  return atob(s)
}

/** Сравнение секрета без раннего выхода по первому несовпавшему символу. */
function sameSecret(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

type Caller = { kind: 'cron' } | { kind: 'user'; id: string } | { kind: 'denied'; status: number; error: string }

async function whoCalls(req: Request, body: Record<string, unknown>): Promise<Caller> {
  if (sameSecret(req.headers.get('x-sync-secret') ?? '', SYNC_SECRET)) return { kind: 'cron' }

  const headerToken = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  const token = String(body.access_token ?? '') || headerToken
  if (!token) return { kind: 'denied', status: 401, error: 'Sign in to run the sync.' }

  let sub = ''
  try {
    sub = JSON.parse(b64url(token.split('.')[1] ?? '')).sub ?? ''
  } catch { /* ignore */ }
  // anon-ключ подписан проектом, но пользователя за ним нет.
  if (!sub) return { kind: 'denied', status: 401, error: 'Sign in to run the sync.' }

  const r = await fetch(`${SUPABASE_URL}/rest/v1/receipt_matcher_employees?select=id&limit=1`, {
    headers: { Authorization: `Bearer ${token}`, apikey: ANON_KEY },
  })
  if (r.status === 401 || r.status === 403) return { kind: 'denied', status: 401, error: 'Your session has expired. Sign in again.' }
  if (!r.ok) return { kind: 'denied', status: 500, error: `Access check failed (${r.status}).` }
  const rows = await r.json().catch(() => [])
  if (!Array.isArray(rows) || rows.length === 0) {
    return { kind: 'denied', status: 403, error: 'You do not have access to Receipts Matcher.' }
  }
  return { kind: 'user', id: sub }
}

interface AirtableEmployee {
  id: string
  fullName: string
  email: string | null
}

function asText(v: unknown): string | null {
  if (typeof v === 'string') return v
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0]
  return null
}

async function fetchAirtable(): Promise<AirtableEmployee[]> {
  const out: AirtableEmployee[] = []
  let offset: string | undefined
  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE}/${TABLE}`)
    url.searchParams.set('pageSize', '100')
    url.searchParams.append('fields[]', NAME_FIELD)
    url.searchParams.append('fields[]', EMAIL_FIELD)
    if (offset) url.searchParams.set('offset', offset)
    const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } })
    if (!r.ok) throw new Error(`Airtable answered ${r.status}: ${(await r.text()).slice(0, 300)}`)
    const data = await r.json()
    for (const rec of data.records ?? []) {
      // Имя — как есть, без trim. Запись без имени пропускаем: full_name обязателен.
      const fullName = asText(rec.fields?.[NAME_FIELD])
      if (!fullName) continue
      out.push({ id: String(rec.id), fullName, email: asText(rec.fields?.[EMAIL_FIELD]) })
    }
    offset = data.offset
  } while (offset)
  return out
}

async function rest(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
}

async function must(r: Response, what: string): Promise<void> {
  if (!r.ok) throw new Error(`${what}: ${r.status} ${(await r.text()).slice(0, 300)}`)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'POST only.' }, 405)

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const caller = await whoCalls(req, body)
  if (caller.kind === 'denied') return json({ error: caller.error }, caller.status)

  if (body.action === 'directory_options') {
    if (caller.kind !== 'user') return json({ error: 'Only a signed-in person can read the directory options.' }, 403)
    if (!AIRTABLE_TOKEN) return json({ error: 'The AIRTABLE_EMPLOYEES_TOKEN secret is not set.' }, 500)
    try {
      return await directoryOptions()
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500)
    }
  }

  if (body.action === 'add_employee') {
    // Заводит человека только человек — по секрету cron'а это не делается.
    if (caller.kind !== 'user') return json({ error: 'Only a signed-in person can add an employee.' }, 403)
    if (!AIRTABLE_TOKEN) return json({ error: 'The AIRTABLE_EMPLOYEES_TOKEN secret is not set.' }, 500)
    try {
      return await addEmployee(body)
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500)
    }
  }

  try {
    if (!AIRTABLE_TOKEN) throw new Error('The AIRTABLE_EMPLOYEES_TOKEN secret is not set.')

    const fromAirtable = await fetchAirtable()
    // Пустой ответ почти всегда значит «токен не видит таблицу / поле переименовали», а не
    // «все уволились». Деактивировать весь список по такому ответу нельзя.
    if (fromAirtable.length === 0) {
      throw new Error('Airtable returned no employees — nothing was changed. Check the token’s access to the base and the “Full Name” field.')
    }

    const existingRes = await rest('receipt_matcher_employees?select=id,airtable_record_id,full_name,email,active')
    await must(existingRes, 'Reading employees')
    const existing = (await existingRes.json()) as {
      id: string; airtable_record_id: string | null; full_name: string; email: string | null; active: boolean
    }[]
    const byRecord = new Map(existing.filter((e) => e.airtable_record_id).map((e) => [e.airtable_record_id!, e]))
    const now = new Date().toISOString()

    const toInsert: Record<string, unknown>[] = []
    let updated = 0
    let reactivated = 0
    const seenIds: string[] = []

    for (const a of fromAirtable) {
      const row = byRecord.get(a.id)
      if (!row) {
        toInsert.push({ airtable_record_id: a.id, full_name: a.fullName, email: a.email, active: true, synced_at: now, updated_by: null })
        continue
      }
      seenIds.push(row.id)
      if (row.full_name !== a.fullName || (row.email ?? null) !== a.email || !row.active) {
        if (!row.active) reactivated++
        else updated++
        await must(
          await rest(`receipt_matcher_employees?id=eq.${row.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ full_name: a.fullName, email: a.email, active: true, synced_at: now, updated_by: null }),
          }),
          'Updating an employee',
        )
      }
    }

    if (toInsert.length) {
      await must(await rest('receipt_matcher_employees', { method: 'POST', body: JSON.stringify(toInsert) }), 'Adding employees')
    }

    // Все, кого Airtable подтвердил, — отметка времени одним запросом.
    if (seenIds.length) {
      await must(
        await rest(`receipt_matcher_employees?id=in.(${seenIds.join(',')})`, {
          method: 'PATCH',
          body: JSON.stringify({ synced_at: now }),
        }),
        'Marking employees as seen',
      )
    }

    // Исчез из Airtable — деактивируем, не удаляем; его карты не трогаем.
    const gone = existing.filter((e) => e.airtable_record_id && e.active && !fromAirtable.some((a) => a.id === e.airtable_record_id))
    if (gone.length) {
      await must(
        await rest(`receipt_matcher_employees?id=in.(${gone.map((g) => g.id).join(',')})`, {
          method: 'PATCH',
          body: JSON.stringify({ active: false, updated_by: null }),
        }),
        'Deactivating employees',
      )
    }

    return json({
      ok: true,
      by: caller.kind,
      fetched: fromAirtable.length,
      added: toInsert.length,
      updated,
      reactivated,
      deactivated: gone.length,
      synced_at: now,
    })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
