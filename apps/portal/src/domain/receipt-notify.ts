/**
 * 07 Finances — Receipts Matcher · получатели уведомлений (BAS-1474).
 *
 * Таблица `receipt_matcher_settings` (Никита): три строки, `value` — jsonb-список
 * `[{ name, email, phone? }]`. Автоматизация читает их на каждом прогоне через edge
 * `receipts-settings`, поэтому сохранение действует со следующего запуска.
 *
 * Главное правило: ПУСТОЙ список и ОТСУТСТВУЮЩЕЕ значение — противоположные вещи.
 * `[]` — кто-то решил никого не уведомлять, автоматизация это соблюдает. Нет строки или
 * значение не читается — автоматизация берёт свой зашитый адрес. Поэтому строки не удаляем
 * (база и не даст), «никого» — это сохранённый `[]`.
 *
 * Невалидная запись отклоняет ВЕСЬ список у читателя, и на экране это не видно — только как
 * тихий откат автоматизации на запасной адрес. Поэтому всё проверяем здесь, до сохранения.
 */

export type NotifyKey = 'notify_technical' | 'notify_non_technical' | 'notify_tool_purchase'

export interface Recipient {
  name: string
  email: string
  phone: string
}

export interface NotifySetting {
  key: NotifyKey
  value: Recipient[]
  updatedAt: string | null
}

export const MAX_RECIPIENTS = 20
export const NAME_MAX = 80

export const NOTIFY_KEYS: { key: NotifyKey; label: string; hint: string; emptyNote?: string }[] = [
  {
    key: 'notify_technical',
    label: 'Technical issues',
    hint: 'These people receive failures — a run that stopped, with the technical detail needed to fix it. Whoever is listed here gets stack traces.',
  },
  {
    key: 'notify_non_technical',
    label: 'Non-technical issues',
    hint: 'These people receive things the automation cannot decide by itself — for example a card number that is on nobody. This is the list a bookkeeper belongs on.',
  },
  {
    key: 'notify_tool_purchase',
    label: 'Tool purchases',
    hint: 'These people are told when a power tool is bought on a receipt. Tools go through the books as ordinary materials, so nothing else points them out.',
    emptyNote:
      'Empty on purpose until someone is added: tool-purchase mail is switched off while this list is empty. Nothing is lost — receipts it finds are reported once an address is saved here.',
  },
]

export function emptyRecipient(): Recipient {
  return { name: '', email: '', phone: '' }
}

/** jsonb из базы → строки формы. Всё непонятное превращаем в пустые поля, а не роняем экран. */
export function parseRecipients(value: unknown): Recipient[] {
  if (!Array.isArray(value)) return []
  return value.map((v) => {
    const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
    return {
      name: typeof o.name === 'string' ? o.name : '',
      email: typeof o.email === 'string' ? o.email : '',
      phone: typeof o.phone === 'string' ? o.phone : '',
    }
  })
}

/** Строки формы → то, что пишем в базу: обрезанные пробелы, пустой телефон — null. */
export function normalizeRecipients(list: Recipient[]): { name: string; email: string; phone: string | null }[] {
  return list.map((r) => ({ name: r.name.trim(), email: r.email.trim(), phone: r.phone.trim() || null }))
}

const EMAIL_RE = /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/
const E164_RE = /^\+[1-9]\d{1,14}$/

export interface RecipientErrors {
  name?: string
  email?: string
  phone?: string
}

export function validateRecipient(r: Recipient): RecipientErrors {
  const out: RecipientErrors = {}
  const name = r.name.trim()
  const email = r.email.trim()
  const phone = r.phone.trim()

  if (!name) out.name = 'Add a name — it is used in the run log.'
  else if (name.length > NAME_MAX) out.name = `At most ${NAME_MAX} characters.`

  if (!email) out.email = 'Add an email address.'
  else if (/[,;\s]/.test(email)) out.email = 'One address per row — add another row for the second one.'
  else if (!EMAIL_RE.test(email)) out.email = 'This does not look like an email address.'

  if (phone && !E164_RE.test(phone)) out.phone = 'Use the international format: +13015550123.'

  return out
}

/** Ошибки списка: по строкам + общая (лимит). Пустой список — валиден. */
export function validateList(list: Recipient[]): { rows: RecipientErrors[]; list: string | null; ok: boolean } {
  const rows = list.map(validateRecipient)
  const listErr = list.length > MAX_RECIPIENTS ? `At most ${MAX_RECIPIENTS} people per list.` : null
  return { rows, list: listErr, ok: !listErr && rows.every((e) => Object.keys(e).length === 0) }
}

/**
 * Адреса, которые встречаются в списке дважды. Читатель такие молча схлопывает, поэтому
 * это не ошибка, а подсказка: скорее всего, промах в форме.
 */
export function duplicateEmails(list: Recipient[]): Set<string> {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const r of list) {
    const e = r.email.trim().toLowerCase()
    if (!e) continue
    if (seen.has(e)) dup.add(e)
    seen.add(e)
  }
  return dup
}

export function sameRecipients(a: Recipient[], b: Recipient[]): boolean {
  return JSON.stringify(normalizeRecipients(a)) === JSON.stringify(normalizeRecipients(b))
}
