/**
 * GMB Agent · названия листингов (BAS-1543).
 *
 * `public.gmb_listings` — строка на листинг Google. Её заводит и обновляет агент на каждом
 * еженедельном прогоне, включая листинги, добавленные в Google позже. Экран пишет ТОЛЬКО три
 * колонки (`desired_name`, `enforce_override`, `updated_by`) — так раздан грант, строки не
 * добавляются и не удаляются.
 *
 * Как агент решает за строку (хендофф Никиты, дословно):
 *   name     = desired_name (trimmed), если не пусто,  иначе registry_name
 *   enforced = enforce_override, если не null,          иначе registry_approved
 * Экран показывает тот же итог заранее — ради этого вопроса его и открывают.
 */

export interface GmbListing {
  locationId: string
  liveTitle: string | null
  registryName: string | null
  registryApproved: boolean
  address: string | null
  storeCode: string | null
  lastSeenAt: string | null
  lastRenamedAt: string | null
  lastRenamedFrom: string | null
  desiredName: string | null
  enforceOverride: boolean | null
}

/** Трёхпозиционный: `null` — это НЕ `false`. `false` выключает проверку листинга. */
export type EnforceChoice = 'follow' | 'keep' | 'leave'

export const ENFORCE_OPTIONS: { value: EnforceChoice; label: string }[] = [
  { value: 'follow', label: 'Follow the agent' },
  { value: 'keep', label: 'Always keep this name' },
  { value: 'leave', label: 'Leave this listing alone' },
]

export function toChoice(v: boolean | null): EnforceChoice {
  return v === null ? 'follow' : v ? 'keep' : 'leave'
}

export function fromChoice(c: EnforceChoice): boolean | null {
  return c === 'follow' ? null : c === 'keep'
}

/** Пустое/пробельное имя сохраняем как NULL («нет мнения»), никогда как "". */
export function normalizeDesired(v: string | null): string | null {
  const t = (v ?? '').trim()
  return t ? t : null
}

export function effectiveName(l: Pick<GmbListing, 'desiredName' | 'registryName'>): string | null {
  return normalizeDesired(l.desiredName) ?? normalizeDesired(l.registryName)
}

export function effectiveEnforced(l: Pick<GmbListing, 'enforceOverride' | 'registryApproved'>): boolean {
  return l.enforceOverride ?? l.registryApproved
}

/** Итог строки одной-двумя фразами — по текущим (в т.ч. несохранённым) значениям. */
export function outcome(l: GmbListing): { line: string; drift: string | null } {
  const name = effectiveName(l)
  const enforced = effectiveEnforced(l)
  if (!enforced) return { line: 'Not checked: Google’s name stays as it is.', drift: null }
  // Агент никогда не ставит пустое имя.
  if (!name) return { line: 'Not checked: there is no name to keep.', drift: null }
  const drift =
    l.liveTitle != null && l.liveTitle !== name
      ? `Google currently shows ‘${l.liveTitle}’. The next check puts it back.`
      : null
  return { line: `Kept as: ${name}`, drift }
}

/**
 * Новый листинг, который агент только нашёл (`registry_approved = false`): агент следит
 * за именем, но не меняет его. Имя, введённое при «Follow the agent», для таких строк
 * НЕ применяется — об этом нужно сказать рядом с полем.
 */
export function newListingNote(l: GmbListing): { banner: string; ignoredName: string | null } | null {
  if (l.registryApproved) return null
  return {
    banner: 'New listing. The agent is watching its name but not changing it. Set a name and choose Always keep this name to start.',
    ignoredName:
      l.enforceOverride === null && normalizeDesired(l.desiredName)
        ? 'This name is not applied while the listing is on Follow the agent.'
        : null,
  }
}

/** Изменилась ли строка относительно сохранённой (после нормализации). */
export function listingChanged(before: GmbListing, after: GmbListing): boolean {
  return normalizeDesired(before.desiredName) !== normalizeDesired(after.desiredName) || before.enforceOverride !== after.enforceOverride
}

export const LISTINGS_HELPER =
  'The agent checks listing names once a week and puts back any name Google has changed. Changes here apply at the next weekly check. The name you set is the name customers see on Google.'
