import { DEFAULT_ANSWERS, collectLeaves, type ItemNode } from '../../domain/production-checklist'

/** Read-only предпросмотр шаблона: блоки (root) + вопросы (листья) с вариантами ответа. */
export function ChecklistPreview({ tree }: { tree: ItemNode[] }) {
  if (!tree.length) return <div className="py-6 text-center text-sm text-gray-400">Empty template.</div>

  return (
    <div className="space-y-5">
      {tree.map((block) => {
        const questions = collectLeaves(block)
        return (
          <div key={block.id} className="rounded-lg border border-gray-100">
            <div className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 font-semibold text-gray-900">
              {block.label}
            </div>
            <div className="divide-y divide-gray-50">
              {questions.map((q) => {
                const options = q.answer_options?.length ? q.answer_options : [...DEFAULT_ANSWERS]
                return (
                  <div key={q.id} className="px-4 py-3">
                    <div className="text-sm text-gray-800">{q.label}</div>
                    {q.description && <div className="mt-0.5 text-xs text-gray-500">{q.description}</div>}
                    <div className="mt-2 flex flex-wrap gap-2">
                      {options.map((opt, i) => (
                        <span
                          key={opt}
                          className={
                            'min-w-[56px] rounded-md border px-3 py-1 text-center text-xs font-medium ' +
                            (i === 0
                              ? 'border-green-200 text-green-700'
                              : i === 1
                                ? 'border-red-200 text-red-700'
                                : 'border-gray-200 text-gray-500')
                          }
                        >
                          {opt}
                        </span>
                      ))}
                    </div>
                    {q.photos && q.photos.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {q.photos.map((url, i) => (
                          <img key={i} src={url} alt="" className="h-16 w-16 rounded border border-gray-200 object-cover" />
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
