import { NavLink } from 'react-router-dom'
import { cn } from '../lib/utils'

/**
 * Табы главной портала: «My Applications» (карточки апок) и «My Links» (внешние
 * инструменты). Полоса идёт сразу под хедером, поэтому она full-bleed, а контент
 * внутри выровнен по той же сетке, что и страницы (max-w-[1200px]).
 */
const TABS: [to: string, label: string][] = [
  ['/', 'My Applications'],
  ['/links', 'My Links'],
]

export function HomeTabs() {
  return (
    <div className="border-b border-gray-200 bg-white">
      <div className="mx-auto flex w-full max-w-[1200px] gap-1 px-4 sm:px-6">
        {TABS.map(([to, label]) => (
          <NavLink
            key={to}
            to={to}
            end
            className={({ isActive }) =>
              cn(
                '-mb-px border-b-2 px-3 py-3 text-sm font-medium transition sm:px-4',
                isActive
                  ? 'border-brand-amber text-gray-900'
                  : 'border-transparent text-gray-500 hover:text-gray-900',
              )
            }
          >
            {label}
          </NavLink>
        ))}
      </div>
    </div>
  )
}
