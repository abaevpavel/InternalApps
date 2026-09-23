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
// Сотрудника из портала не заводим (решение по BAS-1472): человек, существующий только в Supabase,
// не может попасть на чек — ссылка в Airtable берёт record id.
//
// Кто может вызвать:
//   • pg_cron раз в сутки — заголовок `x-sync-secret` = секрет RECEIPT_SYNC_SECRET;
//   • человек кнопкой «Sync now» — его токен (в теле: платформа портит Authorization). Права
//     проверяем чтением receipt_matcher_employees ПОД ЕГО токеном: таблица закрыта тем же RLS
//     `/receipt-import` (или админ), засижена, поэтому пустой ответ = нет доступа.
//
// Secrets: AIRTABLE_TOKEN (общий, нужен scope data.records:read на base ниже), RECEIPT_SYNC_SECRET.

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
const AIRTABLE_TOKEN = Deno.env.get('AIRTABLE_TOKEN') ?? ''
const SYNC_SECRET = Deno.env.get('RECEIPT_SYNC_SECRET') ?? ''

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

  try {
    if (!AIRTABLE_TOKEN) throw new Error('The AIRTABLE_TOKEN secret is not set.')

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
