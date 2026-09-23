import type { StatusTone } from '../components/ui'

/**
 * 07 Finances — Receipts Matcher · импорт транзакций (BAS-1450).
 *
 * Чистая логика экрана по контракту Никиты (вложение к BAS-1450): правила формы, подписи,
 * статусы истории. Экран ничего не пишет сам — всё уходит одной edge-функцией
 * `receipt-import`, а сервер перепроверяет каждое правило и имеет последнее слово.
 * Здесь они продублированы, чтобы человек узнал об ошибке до загрузки файла.
 */

export type ImportMode = 'dry' | 'live'
export type ImportStatus = 'queued' | 'running' | 'done' | 'problems' | 'failed'
/** Поля, которые сервер может назвать в `400/413 { error, field }`. */
export type ImportField = 'account' | 'csv' | 'pdf' | 'mode'

export interface ImportAccount {
  /** Значение, которое уходит на сервер. */
  account: string
  /** Что показываем в дропдауне. */
  label: string
}

export interface ImportRun {
  id: string
  createdAt: string
  createdByName: string | null
  twperryMonth: boolean
  account: string | null
  mode: ImportMode
  csvName: string | null
  pdfName: string | null
  status: ImportStatus
  summary: string | null
  problems: string[]
  details: { label: string; value: string }[]
  startedAt: string | null
  finishedAt: string | null
}

export interface ImportForm {
  twperryMonth: boolean
  account: string | null
  csv: File | null
  pdf: File | null
  mode: ImportMode
}

/** Аккаунт TW Perry не входит в каталог: при включённом тумблере он зафиксирован. */
export const TWPERRY_LABEL = 'TW Perry'

export const CSV_MAX_BYTES = 2 * 1024 * 1024
export const PDF_MAX_BYTES = 5 * 1024 * 1024

/** Сколько последних запусков показывает история. */
export const HISTORY_LIMIT = 20
/** Интервал перечитывания истории, пока есть запуск в работе. */
export const POLL_MS = 5000

/** Форма при каждом открытии: Dry run, Live между визитами не запоминаем. */
export function emptyForm(): ImportForm {
  return { twperryMonth: false, account: null, csv: null, pdf: null, mode: 'dry' }
}

/**
 * Переключение тумблера чистит то, что перестало относиться к делу:
 * включили — сбрасываем аккаунт, выключили — сбрасываем PDF.
 */
export function toggleTwPerry(form: ImportForm, on: boolean): ImportForm {
  return on ? { ...form, twperryMonth: true, account: null } : { ...form, twperryMonth: false, pdf: null }
}

function hasExt(file: File, ext: string): boolean {
  return file.name.toLowerCase().endsWith(ext)
}

function mb(bytes: number): string {
  return `${bytes / (1024 * 1024)} MB`
}

/** Ошибки формы по полям. Пустой объект — можно отправлять. */
export function validateForm(form: ImportForm): Partial<Record<ImportField, string>> {
  const out: Partial<Record<ImportField, string>> = {}

  if (!form.twperryMonth && !form.account) out.account = 'Choose the account this export is from.'

  if (!form.csv) out.csv = 'Add the CSV file.'
  else if (!hasExt(form.csv, '.csv')) out.csv = 'The file has to be a .csv export.'
  else if (form.csv.size > CSV_MAX_BYTES) out.csv = `The CSV is larger than ${mb(CSV_MAX_BYTES)}.`

  if (form.twperryMonth) {
    if (!form.pdf) out.pdf = 'Add the statement PDF from the same Billtrust mail.'
    else if (!hasExt(form.pdf, '.pdf')) out.pdf = 'The statement has to be a .pdf file.'
    else if (form.pdf.size > PDF_MAX_BYTES) out.pdf = `The PDF is larger than ${mb(PDF_MAX_BYTES)}.`
  }

  return out
}

export function submitLabel(form: Pick<ImportForm, 'twperryMonth' | 'mode'>): string {
  if (form.mode === 'dry') return 'Run dry run'
  return form.twperryMonth ? 'Import the month' : 'Import'
}

/** Тело запроса ровно в форме контракта: аккаунт — значение из каталога, не подпись. */
export function buildFormData(form: ImportForm): FormData {
  const fd = new FormData()
  fd.append('twperry_month', form.twperryMonth ? 'true' : 'false')
  if (!form.twperryMonth && form.account) fd.append('account', form.account)
  fd.append('mode', form.mode)
  if (form.csv) fd.append('csv', form.csv)
  if (form.twperryMonth && form.pdf) fd.append('pdf', form.pdf)
  return fd
}

export function isActive(status: ImportStatus): boolean {
  return status === 'queued' || status === 'running'
}

/** Запуск, который сейчас держит форму (импорт один на всех пользователей). */
export function activeRun(runs: ImportRun[]): ImportRun | null {
  return runs.find((r) => isActive(r.status)) ?? null
}

export const STATUS_PILL: Record<ImportStatus, { label: string; tone: StatusTone }> = {
  queued: { label: 'Running', tone: 'info' },
  running: { label: 'Running', tone: 'info' },
  done: { label: 'Done', tone: 'success' },
  problems: { label: 'Problems', tone: 'pending' },
  failed: { label: 'Failed', tone: 'danger' },
}

/** Колонка Result: «Dry run · …» / «Live · …»; пока summary пуст — «in progress». */
export function resultLine(run: Pick<ImportRun, 'mode' | 'summary'>): string {
  return `${run.mode === 'live' ? 'Live' : 'Dry run'} · ${run.summary ?? 'in progress'}`
}

export function accountLabel(run: Pick<ImportRun, 'twperryMonth' | 'account'>, accounts: ImportAccount[]): string {
  if (run.twperryMonth && !run.account) return TWPERRY_LABEL
  const hit = accounts.find((a) => a.account === run.account)
  return hit?.label ?? run.account ?? '—'
}

/** Ответ сервера на отправку, разобранный в то, что показывает экран. */
export type SubmitOutcome =
  | { ok: true; runId: string }
  | { ok: false; message: string; field: ImportField | null; runId: string | null }

const SESSION_EXPIRED = 'Your session has expired. Sign in again.'

/**
 * Разбор не-2xx ответа. `error` сервера — готовая фраза для человека, показываем как есть,
 * без префикса «Error:». 401 может прийти без `error` — это отвечает сама платформа
 * (`{ "msg": "Missing authorization header" }`).
 */
export function outcomeFromError(status: number, body: unknown): SubmitOutcome {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const error = typeof b.error === 'string' && b.error ? b.error : null
  const field = (['account', 'csv', 'pdf', 'mode'] as const).find((f) => f === b.field) ?? null
  const runId = typeof b.run_id === 'string' ? b.run_id : null

  if (status === 401) return { ok: false, message: error ?? SESSION_EXPIRED, field: null, runId: null }
  return {
    ok: false,
    message: error ?? `The import service answered ${status || 'nothing'}. Try again later or ask a developer.`,
    field: status === 400 || status === 413 ? field : null,
    runId: status === 409 ? runId : null,
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
