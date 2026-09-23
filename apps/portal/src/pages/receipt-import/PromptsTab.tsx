import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Card, StatusBadge, Textarea } from '../../components/ui'
import { SaveBar } from '../../components/SaveBar'
import { usePendingActions } from '../../app/PendingActions'
import { errMsg } from '../../lib/utils'
import { loadPrompts, savePrompts } from '../../services/receipt-prompts'
import { lengthHint, validatePrompt, type PromptKey } from '../../domain/receipt-prompts'

/**
 * Receipts Matcher · промпты AI (BAS-1473).
 *
 * Поля — по каталогу `receipt_matcher_prompt_keys`: появится шестой ключ — появится шестое
 * поле. Обычная textarea без форматирования: промпт копируют наружу, переписывают и
 * вставляют обратно, и сохранено должно быть ровно то, что уйдёт модели.
 */
export function PromptsTab() {
  const qc = useQueryClient()
  const [edits, setEdits] = useState<Record<string, string>>({})

  const q = useQuery({ queryKey: ['receipt-prompts'], queryFn: loadPrompts })

  const baseline = useMemo(() => {
    const m: Record<string, { value: string; updatedAt: string | null }> = {}
    for (const v of q.data?.values ?? []) m[v.key] = { value: v.value, updatedAt: v.updatedAt }
    return m
  }, [q.data])

  const keys = q.data?.keys ?? []
  const valueOf = (key: string) => (key in edits ? edits[key] : baseline[key]?.value ?? '')

  // Сравниваем как есть, без trim: пробел в тексте промпта — тоже правка.
  const changed = useMemo(
    () => keys.filter((k) => k.key in edits && edits[k.key] !== (baseline[k.key]?.value ?? '')).map((k) => ({ key: k.key, value: edits[k.key] })),
    [keys, edits, baseline],
  )
  const errorsOf = (k: PromptKey) => validatePrompt(valueOf(k.key), k)
  const blocking = changed.filter((c) => {
    const k = keys.find((x) => x.key === c.key)
    return k ? errorsOf(k).length > 0 : false
  }).length

  const { confirmAndSchedule, busy } = usePendingActions()
  const saveM = useMutation({
    mutationFn: (v: { changes: typeof changed }) => savePrompts(v.changes),
    // Снимаем только правки, которые ушли в базу и не менялись за 10 секунд ожидания.
    onSuccess: async (_r, v) => {
      setEdits((prev) => {
        const next = { ...prev }
        for (const c of v.changes) if (prev[c.key] === c.value) delete next[c.key]
        return next
      })
      await qc.invalidateQueries({ queryKey: ['receipt-prompts'] })
    },
  })

  function onSave() {
    const names = changed.map((c) => keys.find((k) => k.key === c.key)?.label ?? c.key)
    const v = { changes: changed }
    void confirmAndSchedule(
      {
        title: `Save ${names.length === 1 ? 'this prompt' : `${names.length} prompts`}?`,
        body: <>The receipts AI is told the new text of <b>{names.join(', ')}</b> from its next run.</>,
        cta: 'Save',
      },
      { label: `Saving ${names.join(', ')}`, run: () => saveM.mutateAsync(v) },
    )
  }

  if (q.isLoading) return <p className="text-sm text-gray-500">Loading…</p>
  if (q.error) return <p className="text-sm text-red-600">{errMsg(q.error)}</p>

  return (
    <div className="max-w-4xl space-y-5">
      <p className="text-sm text-gray-500">
        What the receipts AI is told. Rewrite the wording freely, but keep the field names it answers with. A save takes effect on the next run.
      </p>

      {keys.map((k) => {
        const text = valueOf(k.key)
        const dirty = changed.some((c) => c.key === k.key)
        const errors = dirty ? errorsOf(k) : []
        // Высота — по содержимому: два системных промпта по ~3 КБ, подсказки в одну строку.
        const rows = Math.min(24, Math.max(3, Math.ceil(text.length / 90) + text.split('\n').length))
        return (
          <Card key={k.key} className="p-6">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="font-medium text-gray-900">{k.label}</span>
              <span className="font-mono text-xs text-gray-400">{k.key}</span>
              {dirty && <StatusBadge tone="warning">unsaved</StatusBadge>}
              {baseline[k.key]?.updatedAt && (
                <span className="ml-auto text-xs text-gray-400">
                  Last changed {new Date(baseline[k.key].updatedAt!).toLocaleString('en-US')}
                </span>
              )}
            </div>
            {k.whatItDoes && <p className="text-sm text-gray-600">{k.whatItDoes}</p>}
            {k.whereUsed && <p className="mb-3 text-xs text-gray-400">Runs: {k.whereUsed}</p>}

            <Textarea
              className="font-mono text-[13px] leading-relaxed"
              rows={rows}
              spellCheck={false}
              value={text}
              onChange={(e) => setEdits((prev) => ({ ...prev, [k.key]: e.target.value }))}
            />
            <div className="mt-1 flex flex-wrap items-start justify-between gap-2 text-xs text-gray-400">
              <span>{lengthHint(text, k)}</span>
              {dirty && (
                <button type="button" className="text-gray-500 hover:text-gray-800" onClick={() => setEdits(({ [k.key]: _, ...rest }) => rest)}>
                  Revert this prompt
                </button>
              )}
            </div>

            {k.requiredTokens.length > 0 && (
              <div className="mt-3 text-xs text-gray-500">
                <span className="mr-1">Must stay in the text:</span>
                {k.requiredTokens.map((t) => (
                  <code
                    key={t}
                    className={
                      'mr-1 mt-1 inline-block rounded px-1.5 py-0.5 font-mono ' +
                      (text.includes(t) ? 'bg-gray-100 text-gray-600' : 'bg-red-50 text-red-700 line-through')
                    }
                  >
                    {t}
                  </code>
                ))}
              </div>
            )}

            {errors.length > 0 && (
              <ul className="mt-3 space-y-1 text-sm text-red-600">
                {errors.map((e) => <li key={e}>{e}</li>)}
              </ul>
            )}
          </Card>
        )
      })}

      <SaveBar
        count={changed.length}
        blocking={blocking}
        saving={saveM.isPending || busy}
        saved={saveM.isSuccess && changed.length === 0}
        error={null}
        onSave={onSave}
        onDiscard={() => setEdits({})}
      />
    </div>
  )
}
