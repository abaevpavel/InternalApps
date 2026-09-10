import { useEffect, useMemo, useRef } from 'react'

/**
 * Возвращает debounce-обёртку колбэка (по умолчанию 600мс). Чистит таймер при размонтировании.
 * У обёртки есть `.flush()` — выполнить отложенный вызов немедленно; нужен там, где сразу
 * после ввода идёт действие, которому важно, чтобы правка уже уехала в БД (напр. Send).
 */
export interface DebouncedCallback<A extends unknown[]> {
  (...args: A): void
  /** Выполнить отложенный вызов прямо сейчас (если он есть). */
  flush: () => void
  /** Есть ли невыполненный отложенный вызов — то есть несохранённая правка. */
  hasPending: () => boolean
}

export function useDebouncedCallback<A extends unknown[]>(
  fn: (...args: A) => void,
  delay = 600,
): DebouncedCallback<A> {
  const fnRef = useRef(fn)
  fnRef.current = fn
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<A | null>(null)

  const debounced = useMemo(() => {
    const run = (...args: A) => {
      if (timer.current) clearTimeout(timer.current)
      pending.current = args
      timer.current = setTimeout(() => {
        timer.current = null
        pending.current = null
        fnRef.current(...args)
      }, delay)
    }
    run.flush = () => {
      if (!timer.current) return
      clearTimeout(timer.current)
      timer.current = null
      const args = pending.current
      pending.current = null
      if (args) fnRef.current(...args)
    }
    run.hasPending = () => timer.current !== null
    return run as DebouncedCallback<A>
  }, [delay])

  // При размонтировании выполняем отложенный вызов, а не выбрасываем его: человек ушёл
  // со страницы через 200 мс после ввода — правка должна доехать, а не исчезнуть.
  useEffect(
    () => () => {
      if (!timer.current) return
      clearTimeout(timer.current)
      timer.current = null
      const args = pending.current
      pending.current = null
      if (args) fnRef.current(...args)
    },
    [],
  )
  return debounced
}
