/**
 * Dev Apps · каталог сценариев Make цепочки продаж (BAS-1556 письма, BAS-1504 payload'ы).
 *
 * Снимок собирается скриптом из ЖИВЫХ блюпринтов Make (только чтение — в Make ничего не меняем)
 * и коммитится в репо JSON-файлом `src/data/make-catalog.json`. Портал в Make не ходит.
 */

/** Этапы цепочки в том порядке, в каком по ним идёт проект. */
export const STAGES = [
  { key: 'proposal', label: 'Proposal' },
  { key: 'internal_scope', label: 'Internal scope' },
  { key: 'change_order', label: 'Change order' },
  { key: 'invoice', label: 'Invoice' },
  { key: 'deposit', label: 'Deposit' },
  { key: 'contract', label: 'Contract' },
  { key: 'void', label: 'Voids' },
  { key: 'submit_sale', label: 'Submit a sale' },
  { key: 'billing_statement', label: 'Billing statement' },
  { key: 'other', label: 'Other' },
] as const

export type StageKey = (typeof STAGES)[number]['key']

export interface PayloadUse {
  moduleId: number
  /** Где именно: «subject», «to», «filter: route 2», «Airtable: Project Name»… */
  where: string
}

export interface PayloadField {
  /** Путь в payload: `client.email`, `items[].price`. */
  path: string
  type: string | null
  /** Пример из последнего реального выполнения, если был. */
  example: unknown
  usedIn: PayloadUse[]
  /** Нигде в сценарии не используется — кандидат на удаление (BAS-1505). */
  unused: boolean
}

export interface EmailEntry {
  moduleId: number
  /** Имя модуля, как его назвали в Make («Email to CLIENT and PC»); null — не назван. */
  label: string | null
  /** Модуль Make: `google-email:ActionSendEmail`, `email:ActionSendEme`… */
  module: string
  /** Человеческое описание, когда письмо уходит: путь роутера и фильтры до него. */
  condition: string | null
  from: string | null
  to: string[]
  cc: string[]
  bcc: string[]
  replyTo: string | null
  subject: string
  /** Тело как в Make — с переменными `{{…}}`. */
  bodyHtml: string
  attachments: string[]
}

export interface ScenarioEntry {
  id: number
  name: string
  stage: StageKey
  active: boolean
  /** Прямая ссылка на сценарий в Make. */
  url: string
  webhook: { name: string | null; fields: PayloadField[] } | null
  emails: EmailEntry[]
}

export interface CatalogSnapshot {
  /** Когда собран снимок; null — ещё не собирали. */
  generatedAt: string | null
  scenarios: ScenarioEntry[]
}

export const MODULE_KINDS: Record<string, string> = {
  'app#emailsender-vt4aje:sendEmail': 'Email sender',
  'google-email:sendAnEmail': 'Gmail',
  'google-email:ActionSendEmail': 'Gmail (legacy)',
  'email:ActionSendEmail': 'Email (SMTP)',
  'quickbooks:SendInvoice': 'QuickBooks invoice',
}

export interface ScenarioComment {
  id: number
  scenarioId: number
  body: string
  createdBy: string
  createdByName: string | null
  createdAt: string
}

/** Переменные Make в тексте письма — чтобы подсветить их в превью. */
export function makeVariables(text: string): string[] {
  return [...new Set(text.match(/\{\{[^}]+\}\}/g) ?? [])]
}

/** HTML письма для превью: переменные Make — жёлтой подсветкой. Превью живёт в sandbox-iframe. */
export function previewHtml(bodyHtml: string): string {
  const highlighted = bodyHtml.replace(
    /\{\{([^}]+)\}\}/g,
    (_m, v: string) => `<mark style="background:#fef3c7;border-radius:3px;padding:0 2px;font-family:monospace;font-size:12px">{{${v}}}</mark>`,
  )
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;font-size:14px;color:#111;margin:12px">${highlighted}</body></html>`
}
