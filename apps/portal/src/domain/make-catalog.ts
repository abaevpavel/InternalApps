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
  /** Где Make сам читает поле: напрямую, через итератор / переменную, toCollection или в JS-коде. */
  usedIn: PayloadUse[]
  /**
   * Поле не читается, но уходит внутри объекта, переданного целиком (в JSON, HTTP, агрегатор):
   * использовать его может только получатель.
   */
  forwardedTo?: PayloadUse[]
  /**
   * Откуда поле известно: `structure` — из описания вебхука (значит, приходит); `reference` —
   * только из того, что сценарий его читает (описания нет, как у Forge-вебхуков).
   */
  origin: 'structure' | 'app' | 'reference'
  /** Точно приходит (structure / app), но нигде в сценарии не читается — кандидат на удаление (BAS-1505). */
  unused: boolean
  /**
   * Сценарий читает поле, которого Mac-приложение не шлёт (только для его сценариев): мёртвая
   * ссылка, опечатка в имени или поле добавляет промежуточный сервис (pdfbuilder, int).
   */
  missing?: boolean
  /** Приложение поле не шлёт, но оно приходит: его добавляет посредник на пути (pdfbuilder / int…). */
  addedBy?: string
  /** Поля ещё нет — запланировано к добавлению (пометка «add» в dev_payload_marks). */
  planned?: { fieldType: string | null; note: string | null }
}

export type SourceKind = 'mac_app' | 'external' | 'unknown'

export interface WebhookSource {
  kind: SourceKind
  sender: string | null
  note?: string | null
  updatedByName?: string | null
  updatedAt?: string | null
}

export interface AppAction {
  action: string
  button: string
  document: string
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
  /** Источник вебхука по умолчанию (из скоупа); на экране переопределяется в dev_webhook_sources. */
  source: WebhookSource
  /** Значения action / статуса сметы / депозита, которые сценарий ловит фильтрами. */
  actions: string[]
  /** Действия Mac-приложения, которые приходят в этот сценарий (по коду estimatingTool). */
  appActions?: string[]
  /** Вид payload'а приложения: «Proposal payload (A)» и т.п. */
  appPayload?: string | null
  /** Ключ пометок полей (dev_payload_marks.scope): 'mac:proposal' и т.п. или 'scenario:<id>'. */
  markScope?: string
  emails: EmailEntry[]
}

export interface CatalogSnapshot {
  /** Когда собран снимок; null — ещё не собирали. */
  generatedAt: string | null
  /** Действия Mac-приложения (estimatingTool), которые уходят в Make. */
  appActions?: AppAction[]
  /** Куда приложение шлёт каждое действие (pdfbuilder / int.basementremodeling.com). */
  appActionRoutes?: Record<string, string>
  /** Откуда взята структура payload'ов приложения (ветка, коммит, файлы). */
  appPayloadSource?: string
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

/* ---------------- дерево payload'а ---------------- */

/** Узел дерева payload'а: `estimateResult` → `categories[]` → `name`. */
export interface PayloadNode {
  /** Сегмент пути: `estimateResult`, `categories[]`, `name`. */
  key: string
  /** Полный путь до узла. */
  path: string
  /** Поле, если сам узел — известное поле (лист или объект, прочитанный целиком). */
  field: PayloadField | null
  children: PayloadNode[]
  /** Сколько полей-листьев внутри (включая сам узел, если он лист). */
  leaves: number
  unused: number
  missing: number
}

/**
 * Плоский список путей → дерево с сохранением структуры JSON. Массив — сегмент с `[]`
 * (`categories[].name` → `categories[]` → `name`). Порядок — как пришли поля, внутри уровня
 * узлы с детьми и листья не перемешиваются.
 */
export function buildPayloadTree(fields: PayloadField[]): PayloadNode[] {
  const root: PayloadNode = { key: '', path: '', field: null, children: [], leaves: 0, unused: 0, missing: 0 }
  // Путь `a.b[]` и путь `a.b` (массив, прочитанный целиком или добавленный одним узлом) — один узел:
  // индекс без `[]`, а подпись узла — с `[]`, если хоть один путь говорит, что это массив.
  const index = new Map<string, PayloadNode>()
  for (const f of fields) {
    const segs = f.path.split('.')
    let cur = root
    let path = ''
    for (const seg of segs) {
      path = path ? `${path}.${seg}` : seg
      const id = path.replace(/\[\]/g, '')
      let next = index.get(id)
      if (!next) {
        next = { key: seg, path, field: null, children: [], leaves: 0, unused: 0, missing: 0 }
        index.set(id, next)
        cur.children.push(next)
      } else if (seg.endsWith('[]') && !next.key.endsWith('[]')) {
        next.key = seg
      }
      cur = next
    }
    cur.field = f
  }
  const count = (n: PayloadNode) => {
    for (const c of n.children) count(c)
    const own = n.children.length === 0 && n.field ? 1 : 0
    n.leaves = own + n.children.reduce((s, c) => s + c.leaves, 0)
    n.unused = (own && n.field?.unused ? 1 : 0) + n.children.reduce((s, c) => s + c.unused, 0)
    n.missing = (n.field?.missing ? 1 : 0) + n.children.reduce((s, c) => s + c.missing, 0)
  }
  count(root)
  return root.children
}

/** Оставить только ветки, где есть поле, подходящее под фильтр. */
export function filterPayloadTree(nodes: PayloadNode[], keep: (f: PayloadField) => boolean): PayloadNode[] {
  const out: PayloadNode[] = []
  for (const n of nodes) {
    const children = filterPayloadTree(n.children, keep)
    if (children.length || (n.field && keep(n.field))) out.push({ ...n, children })
  }
  return out
}
