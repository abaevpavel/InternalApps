/**
 * Лимит переработки бригады (BAS-1445). Обычный день — 8 часов; сверх него бригаде можно
 * работать не больше своего лимита (настраивается в Teams Availability, по умолчанию +2 ч —
 * прежнее общее правило «не больше 10 часов»). Больше лимита AI не ставит.
 *
 * Категории дня сохраняют прежние имена (их же возвращает AI), но смысл теперь от лимита:
 *   normal            — до 8 часов;
 *   overtime_8_to_10  — переработка в пределах лимита бригады;
 *   overtime_over_10  — сверх лимита бригады.
 */
export const NORMAL_DAY_MIN = 480
export const DEFAULT_OVERTIME_LIMIT_MIN = 120
export const MAX_OVERTIME_LIMIT_MIN = 480

export type DayCategory = 'normal' | 'overtime_8_to_10' | 'overtime_over_10'

export function maxWorkingMinutes(limitMin: number | null | undefined): number {
  return NORMAL_DAY_MIN + (limitMin ?? DEFAULT_OVERTIME_LIMIT_MIN)
}

export function dayCategory(workingMin: number, limitMin?: number | null): DayCategory {
  if (workingMin <= NORMAL_DAY_MIN) return 'normal'
  return workingMin <= maxWorkingMinutes(limitMin) ? 'overtime_8_to_10' : 'overtime_over_10'
}

/** «+2h», «+1h 30m», «none» — подпись лимита. */
export function overtimeLimitLabel(limitMin: number): string {
  if (limitMin <= 0) return 'none'
  const h = Math.floor(limitMin / 60)
  const m = limitMin % 60
  return `+${h ? `${h}h` : ''}${h && m ? ' ' : ''}${m ? `${m}m` : ''}`
}

/** Варианты лимита в выборе: 0…4 ч шагом 30 минут (+ текущее значение, если оно вне шага). */
export function overtimeLimitOptions(current?: number): number[] {
  const opts = Array.from({ length: 9 }, (_, i) => i * 30)
  if (current != null && !opts.includes(current)) opts.push(current)
  return opts.sort((a, b) => a - b)
}
