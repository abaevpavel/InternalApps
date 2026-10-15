import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

/**
 * Строка состояния апки под заголовком в шапке портала — канал «апка → оболочка», как
 * роли в `AppRoleContext`: Layout стоит выше роутов апки, поэтому апка публикует строку
 * снизу, а шапка читает сверху. Сейчас — время последнего синка Task Planner с Airtable.
 */
export interface AppHeaderNote {
  text: string
  tone?: 'muted' | 'warning'
  /** Подсказка при наведении (полное время, текст ошибки). */
  title?: string
}

const NoteValue = createContext<AppHeaderNote | null>(null)
const NoteSetter = createContext<(note: AppHeaderNote | null) => void>(() => {})

export function AppHeaderNoteProvider({ children }: { children: ReactNode }) {
  const [note, setNote] = useState<AppHeaderNote | null>(null)
  return (
    <NoteSetter.Provider value={setNote}>
      <NoteValue.Provider value={note}>{children}</NoteValue.Provider>
    </NoteSetter.Provider>
  )
}

export function useAppHeaderNote(): AppHeaderNote | null {
  return useContext(NoteValue)
}

/** Апка показывает строку в шапке; при уходе с её экранов строка убирается. */
export function usePublishAppHeaderNote(note: AppHeaderNote | null): void {
  const set = useContext(NoteSetter)
  const key = note ? `${note.tone ?? ''}|${note.text}|${note.title ?? ''}` : null
  useEffect(() => {
    set(note)
  }, [key, set])
  useEffect(() => () => set(null), [set])
}
