/**
 * Commission App (BAS-1635) — чистая логика без сети, чтобы её можно было покрыть тестами.
 *
 * Сценарий: сотрудник в Retool Commission App запрашивает выплату комиссии по своим Change
 * Order'ам → Make (4731449) ставит им `Commission STATUS = REQUESTED` и шлёт письмо billing'у.
 * В письме ссылка `/commission-app?ids=rec…,rec…` — billing открывает её в портале, видит
 * список CO и подтверждает оплату. Подтверждение ставит PAID только тем записям, что всё ещё
 * в REQUESTED, и пишется в историю (`cp_payout_confirmations`).
 */

/** Сколько CO можно подтвердить за раз. Запрос из Retool — это CO одного сотрудника, десятки максимум. */
export const MAX_IDS = 50

/** Airtable record id: `rec` + 14 символов [A-Za-z0-9]. */
const RECORD_ID = /^rec[A-Za-z0-9]{14}$/

/** Статус комиссии, из которого подтверждение переводит в PAID. */
export const REQUESTED = 'REQUESTED'
export const PAID = 'PAID'

export interface ParsedIds {
  ids: string[]
  invalid: string[]
  tooMany: boolean
}

/**
 * Разобрать `ids` из ссылки письма: через запятую, допускаем пробелы и переносы (почтовики
 * иногда ломают длинные ссылки). Дубли схлопываем, порядок сохраняем. Мусор не выбрасываем
 * молча — возвращаем в `invalid`, чтобы экран мог сказать, что ссылка повреждена.
 */
export function parseRecordIds(raw: string | null | undefined): ParsedIds {
  const parts = (raw ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const ids: string[] = []
  const invalid: string[] = []
  for (const p of parts) {
    if (!RECORD_ID.test(p)) {
      invalid.push(p)
      continue
    }
    if (!ids.includes(p)) ids.push(p)
  }
  return { ids: ids.slice(0, MAX_IDS), invalid, tooMany: ids.length > MAX_IDS }
}

/** CO в том виде, в каком его отдаёт edge-функция `commission-payout`. */
export interface PayoutRecord {
  id: string
  billingRecordId: string
  projectName: string | null
  requester: string | null
  pm: string | null
  coTotal: number | null
  /** Комиссия к выплате: `Total Commission adjusted`, если пусто — `Total Comm`. */
  commission: number | null
  status: string | null
  ineligible: boolean
}

/** Можно ли эту запись подтвердить сейчас. */
export function isConfirmable(r: PayoutRecord): boolean {
  return r.status === REQUESTED
}

export interface PayoutSummary {
  confirmable: PayoutRecord[]
  skipped: PayoutRecord[]
  /** Сумма комиссий только по тем, что будут подтверждены. */
  total: number
  requesters: string[]
}

export function summarize(records: PayoutRecord[]): PayoutSummary {
  const confirmable = records.filter(isConfirmable)
  const skipped = records.filter((r) => !isConfirmable(r))
  const total = round2(confirmable.reduce((s, r) => s + (r.commission ?? 0), 0))
  const requesters = Array.from(new Set(records.map((r) => r.requester).filter((x): x is string => !!x)))
  return { confirmable, skipped, total, requesters }
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function formatMoney(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

/** Почему запись не будет подтверждена — текст для экрана (UI на английском). */
export function skipReason(r: PayoutRecord): string {
  if (r.status === PAID) return 'Already paid'
  if (!r.status) return 'No commission status'
  return `Status is ${r.status}, not ${REQUESTED}`
}
