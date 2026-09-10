import { useEffect } from 'react'

/**
 * Предупреждение о несохранённых правках при перезагрузке и закрытии вкладки.
 *
 * Ответы в чек-листах сохраняются сразу по клику, но два окна остаются: запрос, который
 * ещё в полёте, и заметка, набранная за доли секунды до ухода (она уходит с задержкой).
 * Если в этот момент нажать F5, правка пропадёт молча.
 *
 * `beforeunload` показывает стандартный диалог браузера — свой текст туда подставить
 * нельзя, это ограничение самих браузеров. При обычном переходе внутри портала диалога
 * нет: там мы просто дописываем отложенное через `flush`, потому что спрашивать о том,
 * что можно сохранить самим, незачем.
 */
export function useUnsavedGuard(hasUnsaved: () => boolean, flush?: () => void): void {
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      // Пытаемся дописать отложенное — вдруг успеет уйти до закрытия.
      flush?.()
      if (!hasUnsaved()) return
      e.preventDefault()
      // Legacy-поле: часть браузеров без него диалог не показывает.
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [hasUnsaved, flush])
}
