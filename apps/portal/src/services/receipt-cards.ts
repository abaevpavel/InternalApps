import { requireSupabase } from '../lib/supabase'
import type { CardKind, CardNumber, Employee } from '../domain/receipt-cards'

/**
 * 07 Finances — Receipts Matcher · сотрудники и карты (BAS-1472).
 *
 * Права — как у всех `receipt_*`: `/receipt-import` или админ. Сотрудников экран только читает
 * (их ведёт синк из Airtable; удаление запрещено базой). Карты — читает и пишет; удалить можно
 * (опечатка), закрытую/перевыпущенную карту — деактивируют.
 * Сохранение сразу доходит до автоматизации: эти таблицы и есть список карт, копии нет.
 */

export async function loadCardsData(): Promise<{ employees: Employee[]; cards: CardNumber[] }> {
  const sb = requireSupabase()
  const [eRes, cRes] = await Promise.all([
    sb.from('receipt_matcher_employees').select('id, airtable_record_id, full_name, email, active, synced_at').order('full_name'),
    sb.from('receipt_matcher_card_numbers').select('id, kind, last4, employee_id, issuer, reason, active'),
  ])
  if (eRes.error) throw eRes.error
  if (cRes.error) throw cRes.error
  return {
    employees: (eRes.data ?? []).map((r) => ({
      id: r.id as string,
      airtableRecordId: (r.airtable_record_id as string | null) ?? null,
      fullName: r.full_name as string,
      email: (r.email as string | null) ?? null,
      active: Boolean(r.active),
      syncedAt: (r.synced_at as string | null) ?? null,
    })),
    cards: (cRes.data ?? []).map((r) => ({
      id: r.id as string,
      kind: r.kind as CardKind,
      last4: r.last4 as string,
      employeeId: (r.employee_id as string | null) ?? null,
      issuer: (r.issuer as string | null) ?? null,
      reason: (r.reason as string | null) ?? null,
      active: Boolean(r.active),
    })),
  }
}

/** Отказ базы на дубль активного номера (частичный unique index по last4 where active). */
export class DuplicateNumberError extends Error {}

function translate(error: { code?: string; message: string }): Error {
  if (error.code === '23505') return new DuplicateNumberError(error.message)
  if (error.code === '23514') return new Error('The database refused this entry: a person’s card needs a bank, the shared card needs a bank and a note, a non-card needs a reason.')
  return new Error(error.message)
}

async function userId(): Promise<string | null> {
  const { data } = await requireSupabase().auth.getSession()
  return data.session?.user?.id ?? null
}

export type NewCard =
  | { kind: 'employee_card'; last4: string; employeeId: string; issuer: string }
  | { kind: 'not_a_card'; last4: string; reason: string }
  | { kind: 'shared_card'; last4: string; issuer: string; reason: string }

export async function addCard(c: NewCard): Promise<void> {
  const sb = requireSupabase()
  // Поля ровно под CHECK card_or_account: у каждого вида свой набор обязательных и пустых.
  const row =
    c.kind === 'employee_card'
      ? { kind: c.kind, last4: c.last4, employee_id: c.employeeId, issuer: c.issuer.trim(), reason: null }
      : c.kind === 'shared_card'
        ? { kind: c.kind, last4: c.last4, employee_id: null, issuer: c.issuer.trim(), reason: c.reason.trim() }
        : { kind: c.kind, last4: c.last4, employee_id: null, issuer: null, reason: c.reason.trim() }
  const { data, error } = await sb.from('receipt_matcher_card_numbers').insert({ ...row, active: true, updated_by: await userId() }).select('id')
  if (error) throw translate(error)
  if (!data?.length) throw new Error('Not saved. You may not have access to Receipts Matcher — ask a portal administrator.')
}

export async function updateCard(
  id: string,
  patch: Partial<{ last4: string; issuer: string; reason: string; active: boolean }>,
): Promise<void> {
  const sb = requireSupabase()
  const { data, error } = await sb
    .from('receipt_matcher_card_numbers')
    .update({ ...patch, updated_by: await userId() })
    .eq('id', id)
    .select('id')
  if (error) throw translate(error)
  if (!data?.length) throw new Error('Not saved. You may not have access to Receipts Matcher — ask a portal administrator.')
}

export async function deleteCard(id: string): Promise<void> {
  const sb = requireSupabase()
  const { data, error } = await sb.from('receipt_matcher_card_numbers').delete().eq('id', id).select('id')
  if (error) throw translate(error)
  if (!data?.length) throw new Error('Not deleted. You may not have access to Receipts Matcher — ask a portal administrator.')
}

/**
 * Добавить человека (фича поверх BAS-1472): функция создаёт строку в 05-Contacts Directory
 * (F_Name, L_Name, Email, Category = Employee). «All employees» — синхронизированная копия этой
 * таблицы, поэтому у нас человек появится после синхронизации Airtable и нашего синка.
 */
export interface NewPerson {
  firstName: string
  lastName: string
  email: string
  title: string
  departments: string[]
  headshot: File | null
}

/** Возвращает предупреждение, если человек создан, но фото не загрузилось. */
export async function addEmployee(input: NewPerson): Promise<{ warning: string | null }> {
  const sb = requireSupabase()
  const { data: auth } = await sb.auth.getSession()
  const headshot = input.headshot
    ? { data: await toBase64(input.headshot), content_type: input.headshot.type, filename: input.headshot.name }
    : undefined
  const { data, error } = await sb.functions.invoke('sync-receipt-employees', {
    body: {
      action: 'add_employee',
      first_name: input.firstName,
      last_name: input.lastName,
      email: input.email,
      title: input.title,
      departments: input.departments,
      headshot,
      access_token: auth.session?.access_token ?? '',
    },
  })
  if (error) throw new Error((await functionError(error)) ?? error.message)
  return { warning: typeof data?.warning === 'string' ? data.warning : null }
}

/** Отделы и должности, которые уже есть у сотрудников справочника, — для выбора в форме. */
export async function loadDirectoryOptions(): Promise<{ departments: string[]; titles: string[] }> {
  const sb = requireSupabase()
  const { data: auth } = await sb.auth.getSession()
  const { data, error } = await sb.functions.invoke('sync-receipt-employees', {
    body: { action: 'directory_options', access_token: auth.session?.access_token ?? '' },
  })
  if (error) throw new Error((await functionError(error)) ?? error.message)
  return { departments: data?.departments ?? [], titles: data?.titles ?? [] }
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''))
    r.onerror = () => reject(r.error ?? new Error('Could not read the file.'))
    r.readAsDataURL(file)
  })
}

async function functionError(error: unknown): Promise<string | null> {
  const ctx = (error as { context?: Response }).context
  try {
    const body = ctx ? await ctx.json() : null
    return typeof body?.error === 'string' ? body.error : null
  } catch {
    return null
  }
}

/**
 * «Sync now» — тот же синк, что раз в сутки гоняет pg_cron. Токен кладём и в тело:
 * платформа умеет портить заголовок Authorization.
 */
export async function syncEmployeesNow(): Promise<{ fetched: number; added: number; updated: number; reactivated: number; deactivated: number }> {
  const sb = requireSupabase()
  const { data: auth } = await sb.auth.getSession()
  const { data, error } = await sb.functions.invoke('sync-receipt-employees', {
    body: { access_token: auth.session?.access_token ?? '' },
  })
  if (error) throw new Error((await functionError(error)) ?? error.message)
  return data
}
