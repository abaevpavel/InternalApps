import { requireSupabase } from '../lib/supabase'
import type { PayoutRecord } from '../domain/commission-app'

/**
 * Сервис Commission App (BAS-1635). Airtable и запись истории — только через edge-функцию
 * `commission-payout`: ключи Airtable во фронт не попадают, а строку «кто подтвердил» пишет
 * сервер (у authenticated нет insert в cp_payout_confirmations).
 */

export interface PayoutHistoryEntry {
  id: string
  billingRecordId?: string
  projectName?: string | null
  requester?: string | null
  commission?: number | null
  statusBefore?: string | null
  result: 'paid' | 'skipped' | 'failed'
  reason?: string
}

export interface PayoutConfirmation {
  id: string
  confirmed_at: string
  confirmed_by: string | null
  confirmed_by_email: string
  status: 'confirmed' | 'partial' | 'failed'
  error: string | null
  requester_names: string[]
  requested_ids: string[]
  records: PayoutHistoryEntry[]
  total_paid: number
  paid_count: number
}

export interface ConfirmResult {
  confirmation: PayoutConfirmation | null
  paidCount: number
  totalPaid: number
  skipped: PayoutHistoryEntry[]
  /** Airtable обновлён, но строка истории не записалась — показываем предупреждение. */
  historyError: string | null
}

/**
 * Вызов edge-функции. Токен сессии кладём и в тело — заголовок `Authorization` платформа
 * иногда портит (тот же приём, что в buildertrend-schedule). Ошибку с не-2xx ответа достаём
 * из тела: там текст для человека.
 */
async function call<T>(body: Record<string, unknown>): Promise<T> {
  const sb = requireSupabase()
  const { data: auth } = await sb.auth.getSession()
  const { data, error } = await sb.functions.invoke('commission-payout', {
    body: { ...body, access_token: auth.session?.access_token ?? '' },
  })
  if (error) {
    const ctx = (error as { context?: Response }).context
    if (ctx && typeof ctx.json === 'function') {
      const payload = await ctx.json().catch(() => null)
      if (payload?.error) throw new Error(payload.error)
    }
    throw error
  }
  if (data?.error) throw new Error(data.error)
  return data as T
}

export async function loadPayoutRecords(ids: string[]): Promise<PayoutRecord[]> {
  const data = await call<{ records: PayoutRecord[] }>({ action: 'load', ids })
  return data.records ?? []
}

export async function confirmPayout(ids: string[]): Promise<ConfirmResult> {
  const data = await call<Partial<ConfirmResult>>({ action: 'confirm', ids })
  return {
    confirmation: data.confirmation ?? null,
    paidCount: data.paidCount ?? 0,
    totalPaid: data.totalPaid ?? 0,
    skipped: data.skipped ?? [],
    historyError: data.historyError ?? null,
  }
}

/** История подтверждений, свежие сверху. Читается напрямую — RLS пускает тех, кому выдана апка. */
export async function listConfirmations(limit = 100): Promise<PayoutConfirmation[]> {
  const sb = requireSupabase()
  const { data, error } = await sb
    .from('cp_payout_confirmations')
    .select('*')
    .order('confirmed_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data ?? []) as PayoutConfirmation[]
}
