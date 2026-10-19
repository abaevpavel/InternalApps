/**
 * Период по дате задачи — быстрые This week / Next week / This month, All dates и свои границы.
 * Один и тот же фильтр на своей стороне PM (My Tasks) и во вкладке Closed (BAS-1435).
 */
import { useState } from 'react'
import { Input } from '../../components/ui'
import { cn } from '../../lib/utils'
import { presetRange, RANGE_PRESETS, type RangePreset } from '../../domain/task-planner/own-side'

export type DateRange = { from: string; to: string } | null

/** Состояние фильтра: по умолчанию This week, как у PM. `range` null — без фильтра. */
export function useRangeFilter(today: string) {
  const [preset, setPreset] = useState<RangePreset | null>('this_week')
  const [range, setRange] = useState<DateRange>(() => presetRange('this_week', today))
  return {
    preset,
    range,
    badRange: !!range && range.from > range.to,
    pickPreset(p: RangePreset) {
      setPreset(p)
      setRange(presetRange(p, today))
    },
    setBound(key: 'from' | 'to', v: string) {
      if (!v) return
      setPreset(null)
      setRange((r) => ({ ...(r ?? { from: v, to: v }), [key]: v }))
    },
    clear() {
      setPreset(null)
      setRange(null)
    },
  }
}

export function RangeFilter({ f }: { f: ReturnType<typeof useRangeFilter> }) {
  const pill = (active: boolean) =>
    cn(
      'rounded-full border px-3 py-1 text-xs font-medium transition',
      active ? 'border-brand-blue bg-brand-blue text-white' : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300',
    )
  return (
    <div className="flex flex-wrap items-center gap-2">
      {RANGE_PRESETS.map((p) => (
        <button key={p.key} type="button" onClick={() => f.pickPreset(p.key)} className={pill(f.preset === p.key)}>
          {p.label}
        </button>
      ))}
      <button type="button" onClick={f.clear} className={pill(f.range === null)}>
        All dates
      </button>
      <div className="flex items-center gap-1.5 text-sm text-gray-500">
        <Input type="date" className="w-36 py-1" value={f.range?.from ?? ''} onChange={(e) => f.setBound('from', e.target.value)} />
        <span>–</span>
        <Input type="date" className="w-36 py-1" value={f.range?.to ?? ''} onChange={(e) => f.setBound('to', e.target.value)} />
      </div>
    </div>
  )
}
