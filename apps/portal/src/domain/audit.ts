/**
 * История изменений (миграция 0019, `portal_audit_log`). Пишет триггер в базе; здесь —
 * только подача: как назвать таблицу, запись и поле человеческими словами.
 */

export interface AuditEntry {
  id: number
  tableName: string
  rowKey: string
  action: 'insert' | 'update' | 'delete'
  oldData: Record<string, unknown> | null
  newData: Record<string, unknown> | null
  changedFields: string[] | null
  actorName: string | null
  actorKind: 'person' | 'automation'
  changedAt: string
}

const TABLE_LABELS: Record<string, string> = {
  receipt_matcher_settings: 'Notification recipients',
  receipt_matcher_prompts: 'AI prompt',
  receipt_matcher_card_numbers: 'Card number',
  receipt_matcher_employees: 'Employee',
  gmb_settings: 'Setting',
  gmb_listings: 'Listing name',
}

export function tableLabel(t: string): string {
  return TABLE_LABELS[t] ?? t
}

/** Имя записи — чтобы строка истории читалась без открытия JSON. */
export function recordLabel(e: AuditEntry): string {
  const d = (e.newData ?? e.oldData ?? {}) as Record<string, unknown>
  const s = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : null)
  switch (e.tableName) {
    case 'receipt_matcher_card_numbers': {
      const kind = s('kind')
      const tail = kind === 'not_a_card' ? ' (not a card)' : kind === 'shared_card' ? ' (shared card)' : ''
      return `${s('issuer') ?? ''} ${s('last4') ?? ''}`.trim() + tail
    }
    case 'receipt_matcher_employees':
      return (s('full_name') ?? e.rowKey).replace(/\s+/g, ' ').trim()
    case 'gmb_listings':
      return [s('store_code'), s('live_title')].filter(Boolean).join(' · ') || e.rowKey
    default:
      return e.rowKey
  }
}

const ACTION_WORDS: Record<AuditEntry['action'], string> = { insert: 'added', update: 'changed', delete: 'deleted' }
export function actionWord(a: AuditEntry['action']): string {
  return ACTION_WORDS[a]
}

/** Автоматика по роли Postgres → понятное имя. */
export function actorLabel(e: AuditEntry): string {
  if (e.actorKind === 'person') return e.actorName ?? 'Someone'
  if (e.actorName === 'gmb_agent') return 'GMB agent'
  if (e.actorName === 'service_role') return 'Automation (sync)'
  return `Automation${e.actorName ? ` (${e.actorName})` : ''}`
}

/** Значение поля одной строкой; длинное — обрезаем, целиком доступно по «Show full». */
export function formatValue(v: unknown, max = 120): { short: string; full: string; cut: boolean } {
  const full = v === null || v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v)
  const cut = full.length > max
  return { short: cut ? full.slice(0, max) + '…' : full, full, cut }
}

/** Поля, которые показываем для записи: изменённые при update, все значимые при insert/delete. */
export function shownFields(e: AuditEntry): string[] {
  if (e.action === 'update') return e.changedFields ?? []
  const d = e.newData ?? e.oldData ?? {}
  return Object.keys(d).filter((k) => !['id', 'created_at'].includes(k) && d[k] !== null && d[k] !== '')
}
