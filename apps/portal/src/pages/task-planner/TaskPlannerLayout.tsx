import { Outlet } from 'react-router-dom'

/**
 * Контейнер экранов Task Planner. Портальный Layout даёт голый <main>, а страницы
 * планировщика вёрстаны под ограниченную ширину с отступами (раньше это задавал
 * собственный layout апки). Держим здесь, чтобы не дублировать обёртку в каждом экране.
 */
export function TaskPlannerLayout() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <Outlet />
    </div>
  )
}
