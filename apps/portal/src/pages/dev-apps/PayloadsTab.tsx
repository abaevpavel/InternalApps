import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Card, StatusBadge } from '../../components/ui'
import { STAGES, type CatalogSnapshot } from '../../domain/make-catalog'

/**
 * Что приходит во вебхуки сценариев цепочки (BAS-1504): параметр → где используется.
 * Параметр, который нигде в сценарии не читается, — кандидат на удаление (BAS-1505).
 */
export function PayloadsTab({ catalog }: { catalog: CatalogSnapshot }) {
  const [unusedOnly, setUnusedOnly] = useState(false)
  const withHooks = catalog.scenarios.filter((s) => s.webhook)
  const unusedTotal = withHooks.reduce((n, s) => n + (s.webhook?.fields.filter((f) => f.unused).length ?? 0), 0)

  if (!catalog.generatedAt) {
    return <p className="text-sm text-gray-500">The payload catalogue is empty until the snapshot is built from the Make blueprints.</p>
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-gray-600">
          {withHooks.length} webhooks · <b className="text-amber-700">{unusedTotal}</b> parameters used nowhere
        </span>
        <label className="ml-auto flex items-center gap-2 text-gray-600">
          <input type="checkbox" checked={unusedOnly} onChange={(e) => setUnusedOnly(e.target.checked)} />
          Unused only
        </label>
      </div>

      {STAGES.map((st) =>
        withHooks
          .filter((s) => s.stage === st.key)
          .map((s) => {
            const fields = (s.webhook?.fields ?? []).filter((f) => !unusedOnly || f.unused)
            if (!fields.length) return null
            return (
              <Card key={s.id} className="p-4">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-xs text-gray-400">{st.label}</span>
                  <span className="font-medium text-gray-900">{s.name}</span>
                  {s.webhook?.name && <span className="font-mono text-xs text-gray-400">{s.webhook.name}</span>}
                  <a href={s.url} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800">
                    Open in Make <ExternalLink size={12} />
                  </a>
                </div>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-gray-400">
                      <th className="py-1 pr-3 font-normal">Parameter</th>
                      <th className="py-1 pr-3 font-normal">Type</th>
                      <th className="py-1 pr-3 font-normal">Example</th>
                      <th className="py-1 font-normal">Used in</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {fields.map((f) => (
                      <tr key={f.path} className="align-top">
                        <td className="py-1 pr-3 font-mono text-gray-900">{f.path}</td>
                        <td className="py-1 pr-3 text-gray-500">{f.type ?? '—'}</td>
                        <td className="max-w-[16rem] truncate py-1 pr-3 text-gray-500" title={f.example == null ? '' : String(JSON.stringify(f.example))}>
                          {f.example == null ? '—' : JSON.stringify(f.example)}
                        </td>
                        <td className="py-1 text-gray-600">
                          {f.unused ? (
                            <StatusBadge tone="pending">unused</StatusBadge>
                          ) : (
                            f.usedIn.map((u, i) => (
                              <span key={i} className="mr-2 inline-block">
                                <span className="font-mono text-gray-400">{u.moduleId}</span> {u.where}
                              </span>
                            ))
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )
          }),
      )}
    </div>
  )
}
