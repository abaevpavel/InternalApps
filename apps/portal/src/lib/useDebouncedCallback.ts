import { useEffect, useMemo, useRef } from 'react'

/** Возвращает debounce-обёртку колбэка (по умолчанию 600мс). Чистит таймер при размонтировании. */
export function useDebouncedCallback<A extends unknown[]>(fn: (...args: A) => void, delay = 600) {
  const fnRef = useRef(fn)
  fnRef.current = fn
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const debounced = useMemo(
    () =>
      (...args: A) => {
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => fnRef.current(...args), delay)
      },
    [delay],
  )

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  return debounced
}
