/**
 * Запоминаем request_ID последнего запуска планировщика в localStorage,
 * чтобы пережить случайный refresh / уход со вкладки до материализации.
 * Чистится после успешного применения результата.
 */
const KEY = 'daly.pendingRequestId'

export function setPendingRequestId(id: string): void {
  try { localStorage.setItem(KEY, id) } catch { /* приватный режим — игнор */ }
}

export function getPendingRequestId(): string | null {
  try { return localStorage.getItem(KEY) } catch { return null }
}

export function clearPendingRequestId(): void {
  try { localStorage.removeItem(KEY) } catch { /* игнор */ }
}
