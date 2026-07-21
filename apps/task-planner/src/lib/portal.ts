/**
 * URL портала-хаба. Task Planner — отдельное приложение (свой деплой, свой origin),
 * поэтому возврат «на главную» — не роут, а внешний переход.
 * Локально портал поднимается на :5175 (см. apps/portal/vite.config.ts).
 */
export const PORTAL_URL = (import.meta.env.VITE_PORTAL_URL ?? 'http://localhost:5175').replace(/\/$/, '')

/** Уйти в портал (лого в хедере и пункт «My Applications»). */
export function goToPortal(path = '/'): void {
  window.location.href = `${PORTAL_URL}${path}`
}
