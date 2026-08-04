import { Button } from './ui'

/**
 * Общий экран «нет доступа». Используется двумя гейтами:
 *  - `AppAccessGuard` — у роли нет самой апки (`applications`);
 *  - гейт внутри апки — апка есть, но ни один её вид роли не назначен
 *    (напр. Task Planner: ни Planner Admin, ни Team Lead — см. App Settings → Roles).
 */
export function AccessDenied({ reason }: { reason?: string }) {
  return (
    <div className="mx-auto max-w-lg px-6 py-24 text-center">
      <h2 className="text-2xl font-bold text-gray-900">Access denied</h2>
      <p className="mt-3 text-gray-500">
        {reason ??
          'You don’t have access to this application. Ask an administrator to grant your role access, then try again.'}
      </p>
      <div className="mt-8">
        <Button onClick={() => { window.location.href = '/' }}>Back to My Applications</Button>
      </div>
    </div>
  )
}
