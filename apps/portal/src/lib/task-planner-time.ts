/**
 * Утилиты времени. Расписание считаем в минутах от полуночи (целые int),
 * формат "HH:MM" — на границах ввода/вывода. Зона America/New_York.
 */

export const TIMEZONE = 'America/New_York'

/** "HH:MM" → минуты от полуночи. */
export function hhmmToMin(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return 0
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
}

/** Минуты от полуночи → "HH:MM" (24ч). */
export function minToHHMM(min: number): string {
  const m = ((min % 1440) + 1440) % 1440
  const h = Math.floor(m / 60)
  const mm = m % 60
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

/** Минуты → "9:00 AM" (12ч с AM/PM, как в UI). */
export function minToAmPm(min: number): string {
  const m = ((min % 1440) + 1440) % 1440
  let h = Math.floor(m / 60)
  const mm = m % 60
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12
  if (h === 0) h = 12
  return `${h}:${String(mm).padStart(2, '0')} ${ampm}`
}

/** Минуты → "2h 15m" / "5h 0m". */
export function minToHm(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  return `${h}h ${m}m`
}

/** Часы (число или строка "1.5") → минуты (int). */
export function hoursToMin(hours: number | string): number {
  const n = typeof hours === 'string' ? parseFloat(hours) : hours
  return Number.isFinite(n) ? Math.round(n * 60) : 0
}

/** Минуты → часы с одним знаком ("2.0h"). */
export function minToHoursLabel(min: number): string {
  return `${(min / 60).toFixed(1)}h`
}
