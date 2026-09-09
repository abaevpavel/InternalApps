import type { GmbBundle, GmbSetting, GmbSettingKey, GmbRegion } from '../domain/gmb'

/**
 * Источник данных экрана GMB Agent.
 *
 * Настройки живут в проекте Forge (`dpsmbarayebinqcaqhsd`, схема `gmb`), у пользователей
 * портала аккаунтов там нет — ходить надо через edge-прокси `gmb-settings`. Прокси ещё
 * не подключён (нужен ключ Forge и `gmb` в Exposed schemas — согласуется в BAS-1344),
 * поэтому экран пока работает в режиме PREVIEW: каталог ключей и дефолты зашиты здесь,
 * правки лежат в localStorage этого браузера и агента не касаются.
 *
 * Когда прокси появится, меняется только `loadBundle`/`saveChanges` — форма строится по
 * каталогу `SettingKey` и от источника не зависит.
 */

export type GmbSource = 'preview' | 'live'

export interface GmbLoadResult extends GmbBundle {
  source: GmbSource
  /** Почему живой источник недоступен (показывается в баннере). */
  note?: string
}

const PREVIEW_STORE = 'gmb-agent-preview-settings'

/* ---------------- каталог 20 ключей (копия `gmb."SettingKey"` из хендоффа) ---------------- */

export const PREVIEW_KEYS: GmbSettingKey[] = [
  { key: 'reviews_voice', section: 'reviews', valueType: 'string', editableBy: 'staff', notes: null },
  { key: 'tone_positive', section: 'reviews', valueType: 'string', editableBy: 'staff', notes: null },
  { key: 'tone_neutral', section: 'reviews', valueType: 'string', editableBy: 'staff', notes: null },
  { key: 'tone_negative', section: 'reviews', valueType: 'string', editableBy: 'staff', notes: null },
  { key: 'reviews_signature', section: 'reviews', valueType: 'string', editableBy: 'staff', notes: null },
  { key: 'reviews_forbidden', section: 'reviews', valueType: 'string_list', editableBy: 'staff', notes: null },
  { key: 'reviews_max_chars', section: 'reviews', valueType: 'number', editableBy: 'staff', notes: null },
  { key: 'reviews_cron', section: 'reviews', valueType: 'string', editableBy: 'staff', notes: null },
  { key: 'employee_names', section: 'reviews', valueType: 'string_list', editableBy: 'staff', notes: null },
  { key: 'posts_topic_guidance', section: 'posts', valueType: 'string', editableBy: 'staff', notes: null },
  { key: 'posts_voice', section: 'posts', valueType: 'string', editableBy: 'staff', notes: null },
  { key: 'posts_length_words', section: 'posts', valueType: 'range', editableBy: 'staff', notes: null },
  { key: 'posts_max_chars', section: 'posts', valueType: 'number', editableBy: 'staff', notes: null },
  { key: 'posts_cta_default', section: 'posts', valueType: 'string', editableBy: 'staff', notes: null },
  { key: 'posts_forbidden', section: 'posts', valueType: 'string_list', editableBy: 'staff', notes: null },
  { key: 'posts_examples', section: 'posts', valueType: 'text_list', editableBy: 'staff', notes: null },
  { key: 'posts_cron', section: 'posts', valueType: 'string', editableBy: 'staff', notes: null },
  { key: 'post_topics', section: 'posts', valueType: 'topic_table', editableBy: 'staff', notes: null },
  { key: 'listing_check_cron', section: 'listings', valueType: 'string', editableBy: 'staff', notes: null },
  { key: 'agent_paused', section: 'general', valueType: 'boolean', editableBy: 'developer', notes: null },
]

/** `gmb."Region"` — сегодня там DMV и PA. */
export const PREVIEW_REGIONS: GmbRegion[] = [
  { code: 'DMV', label: 'DMV (DC / Maryland / Virginia)' },
  { code: 'PA', label: 'Pennsylvania' },
]

/**
 * Дефолты для preview. Тексты — заполнители по описанию из спеки, а не выгрузка из
 * промптов агента: настоящие значения приедут из `gmb."Setting"`, когда включим прокси.
 */
const PREVIEW_VALUES: Record<string, unknown> = {
  reviews_voice:
    'You are replying as a calm, experienced contractor who has finished hundreds of basements in the DC area. Speak plainly, in the first person plural. No corporate boilerplate, no marketing language.',
  tone_positive: 'Thank them warmly and name the specific thing they praised. One to three sentences. Never upsell.',
  tone_neutral:
    'Acknowledge what they said honestly, without arguing. Invite them to get in touch with the office if anything is still open. Two to four sentences.',
  tone_negative:
    'Show empathy for the specific problem they describe. Take responsibility for the experience without admitting fault. Invite them to contact the office directly. Two to four sentences.',
  reviews_signature: '— the BasementRemodeling.com team',
  reviews_forbidden: [
    'Never promise compensation, a refund or a discount.',
    'Never argue with the reviewer or dispute their account.',
    'Never invent details that are not in the review.',
    'Never name a member of staff.',
    'Never mention prices or contract terms.',
    'Never reference legal action or insurance.',
    'Never ask the reviewer to change or remove their review.',
  ],
  reviews_max_chars: 4096,
  reviews_cron: '0 9 * * *',
  employee_names: ['Pavel', 'Elena', 'Helida', 'Mykyta', 'Vladyslav'],
  posts_topic_guidance:
    'One useful idea per post. Value before selling: the reader should learn something even if they never call us. Tie the post to the city of the listing it is published on.',
  posts_voice:
    'Expert without hype. Specifics over generalities — measurements, materials, sequence of work. No marketing superlatives, no exclamation marks.',
  posts_length_words: { min: 80, max: 180 },
  posts_max_chars: 1500,
  posts_cta_default: 'LEARN_MORE',
  posts_forbidden: [
    'No price claims or figures that are not in the wiki.',
    'No superlatives ("best", "number one").',
    'No promises about timelines.',
    'No comparisons with named competitors.',
    'No invented customer stories.',
    'No legal or code claims outside the listing’s own state.',
  ],
  posts_examples: [],
  posts_cron: '0 2 * * 1',
  post_topics: [
    { key: 'egress-window', label: 'Egress window requirements', query: 'egress window code requirements basement', regions: ['DMV'] },
    { key: 'moisture-control', label: 'Moisture control before finishing', query: 'basement moisture control vapor barrier', regions: [] },
    { key: 'permit-timeline', label: 'What a basement permit takes', query: 'basement finishing permit process timeline', regions: ['DMV', 'PA'] },
  ],
  listing_check_cron: '0 1 * * 1',
  agent_paused: false,
}

function previewSettings(): GmbSetting[] {
  let overrides: Record<string, unknown> = {}
  try {
    overrides = JSON.parse(localStorage.getItem(PREVIEW_STORE) ?? '{}') as Record<string, unknown>
  } catch {
    overrides = {}
  }
  return PREVIEW_KEYS.map((k) => ({
    key: k.key,
    value: k.key in overrides ? overrides[k.key] : PREVIEW_VALUES[k.key],
    updatedAt: k.key in overrides ? new Date().toISOString() : null,
    updatedBy: null,
  }))
}

export async function loadBundle(): Promise<GmbLoadResult> {
  return {
    source: 'preview',
    note: 'Not connected to the agent database yet — the proxy to the Forge project is waiting on access (BAS-1344).',
    keys: PREVIEW_KEYS,
    settings: previewSettings(),
    regions: PREVIEW_REGIONS,
    status: null,
  }
}

export async function saveChanges(changes: { key: string; value: unknown }[]): Promise<void> {
  let overrides: Record<string, unknown> = {}
  try {
    overrides = JSON.parse(localStorage.getItem(PREVIEW_STORE) ?? '{}') as Record<string, unknown>
  } catch {
    overrides = {}
  }
  for (const c of changes) overrides[c.key] = c.value
  localStorage.setItem(PREVIEW_STORE, JSON.stringify(overrides))
}

/** Сбросить локальные правки preview — вернуться к зашитым дефолтам. */
export async function resetPreview(): Promise<void> {
  localStorage.removeItem(PREVIEW_STORE)
}
