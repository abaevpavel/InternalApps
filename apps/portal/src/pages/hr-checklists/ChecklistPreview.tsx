import { DEFAULT_ANSWERS, type ItemNode } from '../../domain/hr-checklists'
import { itemPhotoUrl as itemPhotoUrlSafe } from '../../services/hr-checklists'

/** Read-only предпросмотр шаблона: вложенное дерево пунктов с вариантами ответа. */
export function ChecklistPreview({ tree }: { tree: ItemNode[] }) {
  if (!tree.length) return <div className="py-6 text-center text-sm text-gray-400">Empty checklist.</div>
  return (
    <div className="space-y-1">
      {tree.map((n) => (
        <PreviewNode key={n.id} node={n} depth={0} />
      ))}
    </div>
  )
}

function PreviewNode({ node, depth }: { node: ItemNode; depth: number }) {
  const options = node.answer_options?.length ? node.answer_options : [...DEFAULT_ANSWERS]
  const isLeaf = node.children.length === 0
  return (
    <div>
      <div className="flex items-start gap-2 py-1.5" style={{ paddingLeft: depth * 20 }}>
        <span className={isLeaf ? 'mt-0.5 h-4 w-4 shrink-0 rounded border border-gray-300' : 'font-semibold text-gray-900'}>
          {isLeaf ? '' : node.label}
        </span>
        {isLeaf && (
          <div className="min-w-0 flex-1">
            <div className="text-sm text-gray-800">{node.label}</div>
            {node.description && <div className="text-xs text-gray-500">{node.description}</div>}
            <div className="mt-1 flex flex-wrap gap-1.5">
              {options.map((opt, i) => (
                <span
                  key={opt}
                  className={
                    'rounded border px-2 py-0.5 text-xs ' +
                    (i === 0 ? 'border-green-200 text-green-700' : i === 1 ? 'border-red-200 text-red-700' : 'border-gray-200 text-gray-500')
                  }
                >
                  {opt}
                </span>
              ))}
            </div>
            {node.photos && node.photos.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1.5">
                {node.photos.map((p, i) => (
                  <img key={i} src={itemPhotoUrlSafe(p)} alt="" className="h-14 w-14 rounded border border-gray-200 object-cover" />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {node.children.map((c) => (
        <PreviewNode key={c.id} node={c} depth={depth + 1} />
      ))}
    </div>
  )
}
