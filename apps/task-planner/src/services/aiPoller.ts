/** Авто-поллинг результата планировщика из Supabase по request_id. */
import { fetchScheduleRun } from './data'
import type { ScheduleRun } from '../domain/types'

export interface PollOptions {
  intervalMs?: number
  timeoutMs?: number
  signal?: AbortSignal
}

/** Поллит schedule_runs пока status != processing (done/error) или таймаут. */
export async function pollScheduleRun(
  requestId: string,
  opts: PollOptions = {},
): Promise<ScheduleRun> {
  const interval = opts.intervalMs ?? 2500
  const timeout = opts.timeoutMs ?? 10 * 60 * 1000
  const started = performance.now()

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (opts.signal?.aborted) throw new Error('aborted')
    const run = await fetchScheduleRun(requestId)
    if (run && run.status !== 'processing') return run
    if (performance.now() - started > timeout) {
      throw new Error('Таймаут ожидания результата AI')
    }
    await new Promise((r) => setTimeout(r, interval))
  }
}
