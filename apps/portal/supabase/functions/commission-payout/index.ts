// Supabase Edge Function: commission-payout (BAS-1635, Commission App)
//
// Подтверждение выплаты комиссий по Change Order'ам. Два действия, оба — POST с сессией:
//   • { action: 'load',    ids: ['rec…'] } → { records: PayoutRecord[] }
//   • { action: 'confirm', ids: ['rec…'] } → { confirmation, paid, skipped, failed }
//
// confirm:
//   1. проверяет, что за запросом человек с доступом к /commission-app (cp_app_gate под RLS);
//   2. перечитывает записи из Airtable — статус мог смениться, пока страница была открыта;
//   3. ставит `Commission STATUS = PAID` только тем, что ещё в REQUESTED (повторный клик и
//      подставленные чужие id ничего не меняют);
//   4. пишет строку в cp_payout_confirmations — и при успехе, и при сбое Airtable.
// Если Airtable не принял запись — ответ с ошибкой, экран показывает её, а не «Thank you».
//
// Secrets (Supabase → Edge Functions → Secrets):
//   InternalAppsReadWrite  (required) — PAT с data.records:read + write на базу; заведён 2026-10-05.
//                          Им и читаем, и пишем. Если его нет — чтение падает на AIRTABLE_TOKEN
//                          (read-only, из list-schedule-projects), а confirm отказывает.
//   AIRTABLE_BASE          (опц., default appucrtf5MBcFXVza)
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY платформа инжектит сама.
//
// ⚠️ SEC-9: verify_jwt пропускает и публичный anon-ключ. Человека опознаём сами — sub из
// payload + запрос к /rest с его токеном (тот же приём, что list-schedule-projects и
// sync-receipt-employees).

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const BASE = Deno.env.get('AIRTABLE_BASE') ?? 'appucrtf5MBcFXVza'
const WRITE_TOKEN = Deno.env.get('InternalAppsReadWrite') ?? ''
const READ_TOKEN = WRITE_TOKEN || (Deno.env.get('AIRTABLE_TOKEN') ?? '')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

// Clients Change Orders. Поля — по именам (как в Make-сценариях 4731449 / 4735895).
const CO_TABLE = 'tbl5z6kVeFL8wkr0s'
const GPI_TABLE = 'tblY5HQVxyDyR748b' // General Project Info — ради имени проекта
const F = {
  billingId: 'Billing Record ID',
  status: 'Commission STATUS',
  total: 'Total',
  commAdjusted: 'Total Commission adjusted',
  comm: 'Total Comm',
  requester: 'Requester full name',
  pm: 'PM full name',
  project: 'Project',
  ineligible: 'CO Ineligible',
} as const

const REQUESTED = 'REQUESTED'
const PAID = 'PAID'
const MAX_IDS = 50
const RECORD_ID = /^rec[A-Za-z0-9]{14}$/

interface PayoutRecord {
  id: string
  billingRecordId: string
  projectName: string | null
  requester: string | null
  pm: string | null
  coTotal: number | null
  commission: number | null
  status: string | null
  ineligible: boolean
}

type Caller = { ok: true; id: string; email: string } | { ok: false; status: number; error: string }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

function b64url(s: string): string {
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4) s += '='
  return atob(s)
}

/** Кто вызывает и выдана ли ему апка. Токен берём и из тела: платформа умеет портить заголовок. */
async function whoCalls(req: Request, body: Record<string, unknown>): Promise<Caller> {
  const headerToken = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  const token = String(body.access_token ?? '') || headerToken
  if (!token) return { ok: false, status: 401, error: 'Sign in to continue.' }

  let sub = ''
  let email = ''
  try {
    const p = JSON.parse(b64url(token.split('.')[1] ?? ''))
    sub = p.sub ?? ''
    email = p.email ?? ''
  } catch { /* ignore */ }
  if (!sub) return { ok: false, status: 401, error: 'Sign in to continue.' }

  const r = await fetch(`${SUPABASE_URL}/rest/v1/cp_app_gate?select=id&limit=1`, {
    headers: { Authorization: `Bearer ${token}`, apikey: ANON_KEY },
  })
  if (r.status === 401 || r.status === 403) return { ok: false, status: 401, error: 'Your session has expired. Sign in again.' }
  if (!r.ok) return { ok: false, status: 500, error: `Access check failed (${r.status}).` }
  const rows = await r.json().catch(() => [])
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, status: 403, error: 'You do not have access to Commission App.' }
  }
  return { ok: true, id: sub, email: email || sub }
}

function cleanIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const v of raw) {
    const s = String(v ?? '').trim()
    if (RECORD_ID.test(s) && !out.includes(s)) out.push(s)
  }
  return out.slice(0, MAX_IDS)
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  return null
}

function text(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0].trim() || null
  return null
}

async function airtableGet(url: URL): Promise<Record<string, unknown>> {
  const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${READ_TOKEN}` } })
  if (!r.ok) throw new Error(`Airtable answered ${r.status}: ${(await r.text()).slice(0, 300)}`)
  return await r.json()
}

/** Записи CO по id (ids уже провалидированы регуляркой — в формулу ничего постороннего не попадёт). */
async function loadRecords(ids: string[]): Promise<PayoutRecord[]> {
  if (!READ_TOKEN) throw new Error('Airtable token is not configured (InternalAppsReadWrite secret).')
  if (ids.length === 0) return []

  const url = new URL(`https://api.airtable.com/v0/${BASE}/${CO_TABLE}`)
  url.searchParams.set('filterByFormula', `OR(${ids.map((id) => `RECORD_ID()='${id}'`).join(',')})`)
  url.searchParams.set('pageSize', '100')
  for (const f of Object.values(F)) url.searchParams.append('fields[]', f)
  const data = await airtableGet(url)
  const raw = (data.records ?? []) as { id: string; fields: Record<string, unknown> }[]

  // Имя проекта: `Project` — ссылка на General Project Info, тянем имена одним запросом.
  const projectIds = Array.from(new Set(raw.map((r) => text(r.fields[F.project])).filter((x): x is string => !!x)))
  const projectNames = new Map<string, string>()
  if (projectIds.length) {
    const pu = new URL(`https://api.airtable.com/v0/${BASE}/${GPI_TABLE}`)
    pu.searchParams.set('filterByFormula', `OR(${projectIds.map((id) => `RECORD_ID()='${id}'`).join(',')})`)
    pu.searchParams.append('fields[]', 'Project Name')
    try {
      const pd = await airtableGet(pu)
      for (const p of (pd.records ?? []) as { id: string; fields: Record<string, unknown> }[]) {
        const name = text(p.fields['Project Name'])
        if (name) projectNames.set(p.id, name)
      }
    } catch {
      // имя проекта — для удобства; без него подтверждение всё равно возможно
    }
  }

  const byId = new Map(raw.map((r) => [r.id, r]))
  // Порядок — как в ссылке письма.
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is { id: string; fields: Record<string, unknown> } => !!r)
    .map((r) => {
      const f = r.fields
      const projectId = text(f[F.project])
      return {
        id: r.id,
        billingRecordId: text(f[F.billingId]) ?? r.id,
        projectName: projectId ? projectNames.get(projectId) ?? null : null,
        requester: text(f[F.requester]),
        pm: text(f[F.pm]),
        coTotal: num(f[F.total]),
        commission: num(f[F.commAdjusted]) ?? num(f[F.comm]),
        status: text(f[F.status]),
        ineligible: f[F.ineligible] === true,
      }
    })
}

/** PATCH по 10 записей (лимит Airtable). Возвращает id, которые Airtable подтвердил. */
async function markPaid(ids: string[]): Promise<{ done: string[]; error: string | null }> {
  const done: string[] = []
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10)
    const r = await fetch(`https://api.airtable.com/v0/${BASE}/${CO_TABLE}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${WRITE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: chunk.map((id) => ({ id, fields: { [F.status]: PAID } })) }),
    })
    if (!r.ok) {
      return { done, error: `Airtable answered ${r.status}: ${(await r.text()).slice(0, 300)}` }
    }
    const data = await r.json()
    for (const rec of (data.records ?? []) as { id: string }[]) done.push(rec.id)
  }
  return { done, error: null }
}

async function saveHistory(row: Record<string, unknown>): Promise<{ row: unknown; error: string | null }> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/cp_payout_confirmations`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  })
  if (!r.ok) return { row: null, error: `History was not saved (${r.status}): ${(await r.text()).slice(0, 300)}` }
  const rows = await r.json().catch(() => [])
  return { row: Array.isArray(rows) ? rows[0] ?? null : null, error: null }
}

async function confirm(ids: string[], caller: { id: string; email: string }): Promise<Response> {
  if (!WRITE_TOKEN) return json({ error: 'Airtable write token is not configured (InternalAppsReadWrite secret).' }, 500)

  const records = await loadRecords(ids)
  const found = new Set(records.map((r) => r.id))
  const toPay = records.filter((r) => r.status === REQUESTED)
  if (toPay.length === 0) {
    return json({ error: 'Nothing to confirm: none of these Change Orders is in REQUESTED status anymore.' }, 409)
  }

  const { done, error } = await markPaid(toPay.map((r) => r.id))
  const doneSet = new Set(done)

  const entries = [
    ...records.map((r) => {
      const base = {
        id: r.id,
        billingRecordId: r.billingRecordId,
        projectName: r.projectName,
        requester: r.requester,
        commission: r.commission,
        statusBefore: r.status,
      }
      if (r.status !== REQUESTED) return { ...base, result: 'skipped', reason: r.status === PAID ? 'Already paid' : `Status was ${r.status ?? 'empty'}` }
      return doneSet.has(r.id) ? { ...base, result: 'paid' } : { ...base, result: 'failed' }
    }),
    ...ids.filter((id) => !found.has(id)).map((id) => ({ id, result: 'skipped', reason: 'Not found in Airtable' })),
  ]
  const paid = toPay.filter((r) => doneSet.has(r.id))
  const totalPaid = Math.round(paid.reduce((s, r) => s + (r.commission ?? 0), 0) * 100) / 100
  const status = paid.length === toPay.length ? 'confirmed' : paid.length > 0 ? 'partial' : 'failed'

  const history = await saveHistory({
    confirmed_by: caller.id,
    confirmed_by_email: caller.email,
    status,
    error,
    requester_names: Array.from(new Set(records.map((r) => r.requester).filter((x): x is string => !!x))),
    requested_ids: ids,
    // Правило: всегда пишем id записи Airtable, в которую внесли изменение, и где она лежит.
    airtable_base: BASE,
    airtable_table: CO_TABLE,
    changed_record_ids: paid.map((r) => r.id),
    records: entries,
    total_paid: totalPaid,
    paid_count: paid.length,
  })

  if (status !== 'confirmed') {
    // Airtable принял не всё — это ошибка для человека, даже если часть прошла.
    return json({
      error: `${error ?? 'Airtable did not confirm every record.'} Marked as PAID: ${paid.length} of ${toPay.length}.`,
      confirmation: history.row,
      historyError: history.error,
    }, 502)
  }

  return json({
    confirmation: history.row,
    paidCount: paid.length,
    totalPaid,
    skipped: entries.filter((e) => e.result === 'skipped'),
    historyError: history.error,
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'POST only.' }, 405)

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const caller = await whoCalls(req, body)
  if (!caller.ok) return json({ error: caller.error }, caller.status)

  const ids = cleanIds(body.ids)
  if (ids.length === 0) return json({ error: 'The link has no valid Change Order ids.' }, 400)

  try {
    if (body.action === 'load') return json({ records: await loadRecords(ids) })
    if (body.action === 'confirm') return await confirm(ids, caller)
    return json({ error: 'Unknown action.' }, 400)
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
