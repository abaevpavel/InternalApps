import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'

/**
 * Регистр несохранённых правок.
 *
 * Экран, который копит изменения локально (чек-лист проекта), объявляет здесь: есть ли
 * несохранённое и как это сохранить или отбросить. Кнопка «Back» в шапке — единственная
 * точка выхода из апки — перед уходом спрашивает.
 *
 * Почему не `useBlocker` из react-router: он есть только у data-router (`createBrowserRouter`),
 * а портал собран на обычном `BrowserRouter`. Переводить весь роутинг ради одного экрана
 * дороже, чем завести явный регистр.
 */
interface UnsavedState {
  /** Есть ли что терять прямо сейчас. */
  isDirty: () => boolean
  /** Сохранить и дождаться. */
  save: () => Promise<void>
  /** Отбросить локальные правки. */
  discard: () => void
}

interface Ctx {
  register: (s: UnsavedState | null) => void
  current: () => UnsavedState | null
}

const UnsavedCtx = createContext<Ctx | null>(null)

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const ref = useRef<UnsavedState | null>(null)
  const [, force] = useState(0)

  const register = useCallback((s: UnsavedState | null) => {
    ref.current = s
    force((v) => v + 1)
  }, [])

  const value = useMemo<Ctx>(() => ({ register, current: () => ref.current }), [register])
  return <UnsavedCtx.Provider value={value}>{children}</UnsavedCtx.Provider>
}

export function useUnsavedRegistry(): Ctx {
  const c = useContext(UnsavedCtx)
  if (!c) throw new Error('useUnsavedRegistry must be used inside UnsavedChangesProvider')
  return c
}
