import { useEffect, useRef, useState } from 'react'
import { MapPin } from 'lucide-react'
import { Input } from '../../components/task-planner-ui'
import { suggestPlaces, type PlaceSuggestion } from '../../services/task-planner/maps'

/**
 * Поле адреса с подсказками Google Places (BAS-1410). Ввод свободный: подсказка лишь
 * подставляет полный адрес. Если Places недоступен (нет ключа, API выключен), поле
 * работает как обычный ввод — без ошибок на экране.
 */
export function AddressAutocomplete({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  const [items, setItems] = useState<PlaceSuggestion[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  // Не искать заново сразу после выбора подсказки.
  const picked = useRef<string | null>(null)

  useEffect(() => {
    if (picked.current === value) return
    const q = value.trim()
    if (q.length < 3) {
      setItems([])
      return
    }
    let cancelled = false
    const t = setTimeout(() => {
      suggestPlaces(q)
        .then((r) => {
          if (cancelled) return
          setItems(r)
          setActive(-1)
          setOpen(r.length > 0)
        })
        .catch(() => {
          if (!cancelled) setItems([])
        })
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [value])

  function pick(s: PlaceSuggestion) {
    picked.current = s.text
    onChange(s.text)
    setOpen(false)
    setItems([])
  }

  return (
    <div className="relative">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => items.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (!open || !items.length) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((i) => Math.min(items.length - 1, i + 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((i) => Math.max(0, i - 1))
          } else if (e.key === 'Enter' && active >= 0) {
            e.preventDefault()
            pick(items[active])
          } else if (e.key === 'Escape') {
            setOpen(false)
          }
        }}
        placeholder={placeholder}
        autoComplete="off"
      />
      {open && items.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
          {items.map((s, i) => (
            <li key={s.id}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(s)}
                className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm ${i === active ? 'bg-gray-100' : 'hover:bg-gray-50'}`}
              >
                <MapPin size={14} className="mt-0.5 shrink-0 text-gray-400" />
                <span className="text-gray-800">{s.text}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
