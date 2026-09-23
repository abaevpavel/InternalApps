/**
 * 07 Finances — Receipts Matcher · сотрудники и номера карт (BAS-1472).
 *
 * Таблицы Никиты (BAS-1497), уже засижены и читаются автоматизацией живьём:
 *   receipt_matcher_employees    — личность из Airtable «All employees» (синк, экран не пишет)
 *   receipt_matcher_card_numbers — единственная копия списка карт; её правит ТОЛЬКО этот экран
 *
 * Три колонки несут вес (хендофф §3):
 *   • airtable_record_id — через него автоматизация пишет сотрудника на чек;
 *   • full_name — ключ сопоставления, хранится байт в байт как в Airtable (не трогаем);
 *   • last4 — ТЕКСТ из четырёх цифр, ведущий ноль значим («0034» ≠ 34).
 */

/**
 * `shared_card` (добавлен в BAS-1518, после хендоффа 1472): запасная карта компании, переходит
 * из рук в руки — ни к кому не привязана, покупателя на её чеках бухгалтер ставит руками.
 * Ограничение базы: у неё нет сотрудника, но есть банк И пояснение.
 */
export type CardKind = 'employee_card' | 'not_a_card' | 'shared_card'

export interface Employee {
  id: string
  airtableRecordId: string | null
  fullName: string
  email: string | null
  active: boolean
  syncedAt: string | null
}

export interface CardNumber {
  id: string
  kind: CardKind
  last4: string
  employeeId: string | null
  issuer: string | null
  reason: string | null
  active: boolean
}

/** Предлагаемые эмитенты; свободный текст тоже можно — для нового банка. */
export const ISSUERS = ['Chase', 'BofA', 'Amex'] as const

/**
 * Имя для ЭКРАНА: схлопнуть двойные пробелы и обрезать. Только для показа —
 * в базу и в сравнения идёт `fullName` как есть.
 */
export function displayName(fullName: string): string {
  return fullName.replace(/\s+/g, ' ').trim() || '—'
}

/** Только цифры, не больше четырёх — для маски поля ввода. */
export function maskLast4(input: string): string {
  return input.replace(/\D/g, '').slice(0, 4)
}

export function validateLast4(v: string): string | null {
  return /^[0-9]{4}$/.test(v) ? null : 'Exactly four digits — keep a leading zero (0034).'
}

export function validateIssuer(v: string): string | null {
  const t = v.trim()
  if (!t) return 'Say which bank issued the card.'
  if (t.length > 40) return 'At most 40 characters.'
  return null
}

export function validateReason(v: string): string | null {
  const t = v.trim()
  if (!t) return 'Say what this number is — for example “Pepco account number”.'
  // Пояснения бывают развёрнутыми: у общей карты в базе ~210 символов.
  if (t.length > 500) return 'At most 500 characters.'
  return null
}

/** Кто уже держит активный номер — для понятной ошибки вместо «unique constraint violated». */
export function holderOf(last4: string, cards: CardNumber[], employees: Employee[], exceptId?: string): string | null {
  const hit = cards.find((c) => c.active && c.last4 === last4 && c.id !== exceptId)
  if (!hit) return null
  if (hit.kind === 'not_a_card') return `${last4} is already recorded as not a card (${hit.reason ?? 'no reason'}).`
  if (hit.kind === 'shared_card') return `${last4} is already the company’s shared card.`
  const who = employees.find((e) => e.id === hit.employeeId)
  return `${last4} is already on ${who ? displayName(who.fullName) : 'another person'}.`
}

/**
 * Снять ли этим действием ПОСЛЕДНЮЮ активную карту во всей таблице. Автоматизация на пустом
 * списке карт отказывается работать (пустой список и сломанное чтение для неё неотличимы),
 * поэтому такое действие — только с подтверждением. Одному человеку остаться без карт — норма.
 */
export function removesLastCard(card: CardNumber, cards: CardNumber[]): boolean {
  if (card.kind !== 'employee_card' || !card.active) return false
  return cards.filter((c) => c.kind === 'employee_card' && c.active).length === 1
}

export function cardsOf(employeeId: string, cards: CardNumber[]): CardNumber[] {
  return cards
    .filter((c) => c.kind === 'employee_card' && c.employeeId === employeeId)
    .sort((a, b) => Number(b.active) - Number(a.active) || (a.issuer ?? '').localeCompare(b.issuer ?? '') || a.last4.localeCompare(b.last4))
}

export function lastSync(employees: Employee[]): string | null {
  return employees.reduce<string | null>((max, e) => (e.syncedAt && (!max || e.syncedAt > max) ? e.syncedAt : max), null)
}
