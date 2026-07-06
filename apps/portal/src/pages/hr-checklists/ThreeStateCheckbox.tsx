import { Check, Minus } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { TriState } from '../../domain/hr-checklists'

/** Тристатный чекбокс: unchecked (пусто) → checked (✓, зелёный) → not_applicable (–, серый). */
export function ThreeStateCheckbox({
  state,
  onClick,
  disabled,
}: {
  state: TriState
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-5 w-5 shrink-0 items-center justify-center rounded border transition disabled:opacity-50',
        state === 'checked' && 'border-green-500 bg-green-500 text-white',
        state === 'not_applicable' && 'border-gray-400 bg-gray-400 text-white',
        state === 'unchecked' && 'border-gray-300 bg-white hover:border-gray-400',
      )}
      title={state === 'checked' ? 'Done' : state === 'not_applicable' ? 'N/A' : 'Not done'}
    >
      {state === 'checked' && <Check size={13} />}
      {state === 'not_applicable' && <Minus size={13} />}
    </button>
  )
}
