import { requireSupabase } from '../lib/supabase'
import {
  HISTORY_LIMIT, buildFormData, outcomeFromError,
  type ImportAccount, type ImportForm, type ImportMode, type ImportRun, type ImportStatus, type SubmitOutcome,
} from '../domain/receipt-import'

/**
 * 07 Finances — Receipts Matcher · импорт транзакций (BAS-1450).
 *
 * База и сервер — сторона Никиты (BAS-1449), в базе портала:
 *   receipt_import_accounts — каталог счетов для дропдауна (только чтение)
 *   receipt_import_runs     — история импортов (только чтение; пишет сервер)
 *   edge `receipt-import`   — единственная точка записи: принимает файлы и ставит импорт в очередь
 *
 * Экран не видит ни URL автоматизации, ни секретов. Прямую запись в таблицы и в storage
 * база из браузера отклоняет. Доступ — `user_has_application_access(auth.uid(), '/receipt-import')`
 * или админ; спрятанная карточка — для порядка, защищает сервер.
 */

export async function loadAccounts(): Promise<ImportAccount[]> {
  const sb = requireSupabase()
  const { data, error } = await sb
    .from('receipt_import_accounts')
    .select('account, label')
    .eq('active', true)
    .order('sort_order')
  if (error) throw error
  return (data ?? []).map((r) => ({ account: r.account as string, label: (r.label as string) ?? (r.account as string) }))
}

export async function loadRuns(): Promise<ImportRun[]> {
  const sb = requireSupabase()
  const { data, error } = await sb
    .from('receipt_import_runs')
    .select('id, created_at, created_by_name, twperry_month, account, mode, csv_name, pdf_name, status, summary, problems, details, started_at, finished_at')
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT)
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id as string,
    createdAt: r.created_at as string,
    createdByName: (r.created_by_name as string | null) ?? null,
    twperryMonth: Boolean(r.twperry_month),
    account: (r.account as string | null) ?? null,
    mode: (r.mode as ImportMode) ?? 'dry',
    csvName: (r.csv_name as string | null) ?? null,
    pdfName: (r.pdf_name as string | null) ?? null,
    status: r.status as ImportStatus,
    summary: (r.summary as string | null) ?? null,
    problems: Array.isArray(r.problems) ? (r.problems as string[]) : [],
    details: Array.isArray(r.details)
      ? (r.details as { label?: unknown; value?: unknown }[]).map((d) => ({ label: String(d.label ?? ''), value: String(d.value ?? '') }))
      : [],
    startedAt: (r.started_at as string | null) ?? null,
    finishedAt: (r.finished_at as string | null) ?? null,
  }))
}

/**
 * Отправить импорт. Никаких повторов: при сбое живого импорта решение «пробовать ли ещё»
 * принимает человек.
 *
 * `202 { run_id }` — принят. Любой не-2xx supabase-js отдаёт как FunctionsHttpError, а тело
 * с готовой фразой для человека прячет в `context` — достаём его руками.
 */
export async function submitImport(form: ImportForm): Promise<SubmitOutcome> {
  const sb = requireSupabase()
  const { data, error } = await sb.functions.invoke('receipt-import', { body: buildFormData(form) })

  if (error) {
    const ctx = (error as { context?: Response }).context
    if (ctx && typeof ctx.status === 'number') {
      let body: unknown = null
      try {
        body = await ctx.json()
      } catch {
        body = null
      }
      return outcomeFromError(ctx.status, body)
    }
    // Сеть/релей: до функции не достучались, ответа нет вовсе.
    return outcomeFromError(0, null)
  }

  const runId = (data as { run_id?: unknown } | null)?.run_id
  return { ok: true, runId: typeof runId === 'string' ? runId : '' }
}
