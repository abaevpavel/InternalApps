/**
 * GMB Agent — модель настроек агента Google Business Profile (BAS-1353 / BAS-1344).
 *
 * Данные лежат НЕ в портальной базе, а в проекте Forge (`dpsmbarayebinqcaqhsd`),
 * схема `gmb`: таблицы Setting / SettingKey / AgentStatus / Region. Портал ходит туда
 * через edge-прокси `gmb-settings` (у пользователей портала нет аккаунтов в Forge).
 *
 * Каталог ключей приходит из `gmb."SettingKey"` — форма строится по нему, а не по
 * захардкоженному списку. Здесь только ПОДАЧА (подпись, подсказка, тип контрола) и
 * ВАЛИДАЦИЯ, которые в каталоге не хранятся; ключ, которого нет в каталоге, не рисуется,
 * а ключ без описания ниже рисуется дефолтным контролом по его valueType.
 */

export type GmbSection = 'reviews' | 'posts' | 'listings' | 'general'
export type GmbValueType = 'string' | 'string_list' | 'text_list' | 'number' | 'range' | 'boolean' | 'topic_table'
export type GmbEditableBy = 'staff' | 'developer'

/** Строка каталога `gmb."SettingKey"` — read-only для экрана. */
export interface GmbSettingKey {
  key: string
  section: GmbSection
  valueType: GmbValueType
  editableBy: GmbEditableBy
  notes: string | null
}

/** Строка `gmb."Setting"`. */
export interface GmbSetting {
  key: string
  value: unknown
  updatedAt: string | null
  updatedBy: string | null
}

/** `gmb."AgentStatus"` — пишет агент, экран только показывает. */
export interface GmbAgentStatus {
  appliedAt: string | null
  appliedError: string | null
  appliedHash: string | null
  updatedAt: string | null
}

/** `gmb."Region"` — закрытый словарь для `post_topics.regions`. */
export interface GmbRegion {
  code: string
  label: string
}

export interface GmbTopic {
  key: string
  label: string
  query: string
  regions: string[]
}

export interface GmbBundle {
  keys: GmbSettingKey[]
  settings: GmbSetting[]
  status: GmbAgentStatus | null
  regions: GmbRegion[]
}

/** Все расписания агента читаются и вводятся в этой зоне — таймзона в деплое, не на экране. */
export const GMB_TZ_LABEL = 'America/New_York (ET)'

export const SECTION_TITLES: Record<GmbSection, string> = {
  reviews: 'Reviews',
  posts: 'Posts',
  listings: 'Listing names',
  general: 'General',
}

export const SECTION_ORDER: GmbSection[] = ['reviews', 'posts', 'listings', 'general']

export const CTA_OPTIONS = [
  { value: 'LEARN_MORE', label: 'Learn more' },
  { value: 'BOOK', label: 'Book' },
  { value: 'CALL', label: 'Call' },
  { value: 'SIGN_UP', label: 'Sign up' },
] as const

/** Как часто разрешено запускать — нижняя граница частоты для cron-поля. */
export type CronFloor = 'hourly' | 'daily'

/** Подача поля: подпись, подсказка, размеры контрола, лимиты для валидации. */
export interface GmbFieldMeta {
  label: string
  hint?: string
  /** Предупреждение под полем — то, что иначе прочитают неправильно (см. спеку). */
  warning?: string
  rows?: number
  maxChars?: number
  /** Для number / range. */
  min?: number
  max?: number
  cronFloor?: CronFloor
  /** Пустое значение допустимо (иначе поле обязательное). */
  optional?: boolean
  placeholder?: string
}

export const FIELDS: Record<string, GmbFieldMeta> = {
  /* ---------------- Reviews ---------------- */
  reviews_voice: {
    label: 'Voice',
    hint: 'Who is speaking. Plain text — replies are published to Google, which does not render markdown.',
    rows: 5,
    maxChars: 600,
  },
  tone_positive: { label: 'Tone — positive review', hint: 'Warm and specific, 1–3 sentences, no upsell.', rows: 3, maxChars: 400 },
  tone_neutral: { label: 'Tone — neutral review', hint: 'Acknowledge honestly, invite them to get in touch. 2–4 sentences.', rows: 3, maxChars: 400 },
  tone_negative: {
    label: 'Tone — negative review',
    hint: 'Empathy for the specific problem, responsibility for the experience without admitting fault, invitation to contact the office. 2–4 sentences.',
    rows: 3,
    maxChars: 400,
  },
  reviews_signature: {
    label: 'Signature',
    hint: 'Appended to every reply. Leave empty for no signature.',
    maxChars: 80,
    optional: true,
    placeholder: '— the BasementRemodeling.com team',
  },
  reviews_forbidden: {
    label: 'Forbidden in replies',
    hint: 'One prohibition per line. Duplicates are collapsed on save.',
    warning:
      'This is wording, not switches. A review demanding a refund, threatening legal action, naming a member of staff or making a factual accusation is stopped in code before the model ever runs — removing the matching line here does not turn that protection off.',
    maxChars: 200,
  },
  reviews_max_chars: { label: 'Max reply length', hint: 'Characters. 4096 is Google’s own limit and cannot be raised.', min: 100, max: 4096 },
  reviews_cron: { label: 'Review reply schedule', cronFloor: 'hourly' },
  employee_names: {
    label: 'Staff names',
    hint: 'One first name per line, as reviewers write them ("Pavel was on time"). No commas. Duplicates are collapsed on save.',
    warning:
      'A safety guard, not a staff directory. An empty list does not break the agent — reviews are still collected and escalated — but live auto-replies stop being sent, so the form rejects it. Over-listing is the safe direction.',
    maxChars: 200,
  },

  /* ---------------- Posts ---------------- */
  posts_topic_guidance: {
    label: 'Topic guidance',
    hint: 'One useful idea per post, value before selling, tie it to the listing’s city.',
    rows: 5,
    maxChars: 600,
  },
  posts_voice: { label: 'Voice', hint: 'Expert without hype, specifics over generalities, no marketing superlatives.', rows: 5, maxChars: 600 },
  posts_length_words: { label: 'Post length (words)', hint: 'Both bounds between 20 and 300.', min: 20, max: 300 },
  posts_max_chars: { label: 'Max post length', hint: 'Characters. 1500 is Google’s own limit.', min: 100, max: 1500 },
  posts_cta_default: { label: 'Default call to action', hint: 'One of the four values Google accepts.' },
  posts_forbidden: { label: 'Forbidden in posts', hint: 'One prohibition per line. Duplicates are collapsed on save.', maxChars: 200 },
  posts_examples: { label: 'Example posts', hint: 'Reference posts for the model. The list may be left empty.', maxChars: 1500, optional: true },
  posts_cron: { label: 'Posting schedule', cronFloor: 'daily' },
  post_topics: {
    label: 'Post topics',
    hint: 'Key: letters, digits and hyphens, unique. Query is what retrieves context from the wiki.',
    warning:
      'Regions are not cosmetic. A topic tied to the rules of a specific jurisdiction and left untagged lands on a listing in another state as a factually wrong claim. Empty means the topic goes to every listing.',
  },

  /* ---------------- Listings ---------------- */
  listing_check_cron: {
    label: 'Listing name check schedule',
    hint: 'The canonical listing names themselves stay in the agent’s database with their own approval cycle — only the check schedule lives here.',
    cronFloor: 'daily',
  },

  /* ---------------- General ---------------- */
  agent_paused: {
    label: 'Pause the agent',
    hint: 'Takes all three workflows off the schedule without deleting anything.',
  },
}

export function fieldMeta(key: string): GmbFieldMeta {
  return FIELDS[key] ?? { label: key }
}

/* ---------------- cron ---------------- */

export const WEEKDAYS = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 0, label: 'Sunday' },
]

export type CronShape =
  | { mode: 'daily'; hour: number; minute: number }
  | { mode: 'weekly'; hour: number; minute: number; weekday: number }
  | { mode: 'raw' }

/** Целое число в диапазоне (без списков, шагов и звёзд) — иначе null. */
function plainInt(field: string, lo: number, hi: number): number | null {
  if (!/^\d{1,2}$/.test(field)) return null
  const n = Number(field)
  return n >= lo && n <= hi ? n : null
}

/**
 * Разбор cron в «расписание временем» для редактора. Всё, что не укладывается
 * в «ежедневно в ЧЧ:ММ» или «по дню недели в ЧЧ:ММ», остаётся сырым cron.
 */
export function parseCron(expr: string): CronShape {
  const p = expr.trim().split(/\s+/)
  if (p.length !== 5) return { mode: 'raw' }
  const [m, h, dom, mon, dow] = p
  const minute = plainInt(m, 0, 59)
  const hour = plainInt(h, 0, 23)
  if (minute === null || hour === null || dom !== '*' || mon !== '*') return { mode: 'raw' }
  if (dow === '*') return { mode: 'daily', hour, minute }
  const weekday = plainInt(dow, 0, 6)
  if (weekday === null) return { mode: 'raw' }
  return { mode: 'weekly', hour, minute, weekday }
}

export function buildCron(shape: Exclude<CronShape, { mode: 'raw' }>): string {
  const dow = shape.mode === 'weekly' ? String(shape.weekday) : '*'
  return `${shape.minute} ${shape.hour} * * ${dow}`
}

/** Человеческая подпись под полем расписания. */
export function describeCron(expr: string): string {
  const s = parseCron(expr)
  if (s.mode === 'raw') return `Custom expression · ${GMB_TZ_LABEL}`
  const t = `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`
  if (s.mode === 'daily') return `Every day at ${t} · ${GMB_TZ_LABEL}`
  const d = WEEKDAYS.find((w) => w.value === s.weekday)?.label ?? '?'
  return `Every ${d} at ${t} · ${GMB_TZ_LABEL}`
}

/**
 * Проверка cron. Частоту меряем по минутному полю: конкретная минута = не чаще раза
 * в час; для дневного потолка час тоже должен быть конкретным. Звезда/шаг/список
 * в этих полях означают «чаще, чем разрешено».
 */
export function validateCron(expr: string, floor: CronFloor): string | null {
  const p = expr.trim().split(/\s+/)
  if (p.length !== 5) return 'A schedule is five fields: minute hour day-of-month month day-of-week.'
  const [m, h, dom, mon, dow] = p
  const ok = (f: string, lo: number, hi: number) =>
    f === '*' || f.split(',').every((part) => /^(\*|\d{1,2})(-\d{1,2})?(\/\d{1,2})?$/.test(part) &&
      part.split(/[-/]/).filter((x) => x !== '*' && x !== '').every((x) => Number(x) >= lo && Number(x) <= hi))
  if (!ok(m, 0, 59) || !ok(h, 0, 23) || !ok(dom, 1, 31) || !ok(mon, 1, 12) || !ok(dow, 0, 6)) {
    return 'This is not a valid cron expression.'
  }
  if (plainInt(m, 0, 59) === null) return 'Runs more often than once an hour — the minute must be a single value.'
  if (floor === 'daily' && plainInt(h, 0, 23) === null) {
    return 'Runs more often than once a day — the hour must be a single value.'
  }
  return null
}

/* ---------------- нормализация и валидация значений ---------------- */

export function asString(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

export function asStringList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : String(x ?? ''))) : []
}

export function asRange(v: unknown): { min: number; max: number } {
  const o = (v ?? {}) as Record<string, unknown>
  return { min: Number(o.min ?? 0), max: Number(o.max ?? 0) }
}

export function asTopics(v: unknown): GmbTopic[] {
  if (!Array.isArray(v)) return []
  return v.map((raw) => {
    const o = (raw ?? {}) as Record<string, unknown>
    return {
      key: asString(o.key),
      label: asString(o.label),
      query: asString(o.query),
      regions: asStringList(o.regions),
    }
  })
}

/** Схлопнуть дубликаты и пустые строки — как требует спека для списков. */
export function collapseList(list: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of list) {
    const v = raw.trim()
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

/** Значение, которое реально уходит в БД (после trim/схлопывания). */
export function normalizeValue(key: string, type: GmbValueType, value: unknown): unknown {
  switch (type) {
    case 'string':
      return asString(value).trim()
    case 'string_list':
      return collapseList(asStringList(value))
    case 'text_list':
      return asStringList(value).map((x) => x.trim()).filter(Boolean)
    case 'number':
      return Number(value)
    case 'boolean':
      return !!value
    case 'range': {
      const r = asRange(value)
      return { min: r.min, max: r.max }
    }
    case 'topic_table':
      return asTopics(value).map((t) => ({
        key: t.key.trim(),
        label: t.label.trim(),
        query: t.query.trim(),
        regions: collapseList(t.regions),
      }))
    default:
      return value
  }
}

/** Ошибка поля или null. Значение уже нормализовано `normalizeValue`. */
export function validateValue(
  key: string,
  type: GmbValueType,
  value: unknown,
  regions: GmbRegion[],
): string | null {
  const meta = fieldMeta(key)

  if (meta.cronFloor) return validateCron(asString(value), meta.cronFloor)

  switch (type) {
    case 'string': {
      const s = asString(value)
      if (!s && !meta.optional) return 'Cannot be empty.'
      if (meta.maxChars && s.length > meta.maxChars) return `Too long: ${s.length} of ${meta.maxChars} characters.`
      if (key === 'posts_cta_default' && !CTA_OPTIONS.some((o) => o.value === s)) {
        return 'Must be one of the four values Google accepts.'
      }
      return null
    }
    case 'string_list':
    case 'text_list': {
      const list = asStringList(value)
      if (!list.length && !meta.optional) return 'Add at least one entry.'
      for (const entry of list) {
        if (!entry.trim()) return 'Entries cannot be empty.'
        if (meta.maxChars && entry.length > meta.maxChars) return `An entry is longer than ${meta.maxChars} characters.`
        if (key === 'employee_names' && entry.includes(',')) return 'No commas — one name per line.'
      }
      return null
    }
    case 'number': {
      const n = Number(value)
      if (!Number.isFinite(n)) return 'Must be a number.'
      if (meta.min !== undefined && n < meta.min) return `Must be at least ${meta.min}.`
      if (meta.max !== undefined && n > meta.max) return `Must be at most ${meta.max}.`
      return null
    }
    case 'range': {
      const { min, max } = asRange(value)
      if (!Number.isFinite(min) || !Number.isFinite(max)) return 'Both bounds must be numbers.'
      const lo = meta.min ?? 0
      const hi = meta.max ?? Number.MAX_SAFE_INTEGER
      if (min < lo || min > hi || max < lo || max > hi) return `Both bounds must be between ${lo} and ${hi}.`
      if (min >= max) return 'The lower bound must be below the upper bound.'
      return null
    }
    case 'topic_table': {
      const topics = asTopics(value)
      const codes = new Set(regions.map((r) => r.code))
      const seen = new Set<string>()
      for (const t of topics) {
        if (!/^[A-Za-z0-9-]+$/.test(t.key)) return `Topic key "${t.key || '—'}": letters, digits and hyphens only.`
        if (seen.has(t.key)) return `Topic key "${t.key}" is used twice.`
        seen.add(t.key)
        if (!t.label) return `Topic "${t.key}": label cannot be empty.`
        if (t.label.length > 80) return `Topic "${t.key}": label is longer than 80 characters.`
        if (!t.query) return `Topic "${t.key}": query cannot be empty.`
        if (t.query.length > 300) return `Topic "${t.key}": query is longer than 300 characters.`
        for (const r of t.regions) if (!codes.has(r)) return `Topic "${t.key}": unknown region "${r}".`
      }
      return null
    }
    case 'boolean':
      return null
    default:
      return null
  }
}

/** Одинаковы ли значения (для «есть несохранённые изменения»). */
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}
