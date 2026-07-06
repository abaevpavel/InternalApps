import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Объединяет classnames с разрешением конфликтов Tailwind. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Человекочитаемый текст любой ошибки. Чинит «[object Object]»: Supabase/PostgREST
 * кидают обычный объект (не Error) с полями message/details/hint/code.
 */
export function errMsg(e: unknown): string {
  if (e == null) return 'Unknown error'
  if (typeof e === 'string') return e
  if (e instanceof Error) return e.message
  if (typeof e === 'object') {
    const o = e as Record<string, unknown>
    const parts = [o.message, o.details, o.hint, o.code]
      .filter((x) => typeof x === 'string' && x)
      .map(String)
    if (parts.length) return parts.join(' · ')
    try { return JSON.stringify(e) } catch { return String(e) }
  }
  return String(e)
}

/** Инициалы для аватарки: из имени («Pavel Abaev» → PA) либо из email. */
export function initials(name?: string | null, email?: string | null): string {
  const src = (name ?? '').trim()
  if (src) {
    const parts = src.split(/\s+/)
    return ((parts[0][0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase()
  }
  return (email ?? '?').slice(0, 2).toUpperCase()
}
