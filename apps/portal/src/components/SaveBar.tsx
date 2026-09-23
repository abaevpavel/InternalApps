import { Button } from './ui'

/**
 * Нижняя панель «N unsaved changes · Discard · Save changes» для экранов настроек
 * (GMB Agent, Receipts Matcher). Пока правок нет — скрыта; после сохранения — «Saved ✓».
 */
export function SaveBar({
  count, blocking, saving, saved, error, onSave, onDiscard,
}: {
  count: number
  blocking: number
  saving: boolean
  saved: boolean
  error: string | null
  onSave: () => void
  onDiscard: () => void
}) {
  if (count === 0) {
    return saved ? (
      <div className="fixed inset-x-0 bottom-0 border-t border-gray-100 bg-white/95 py-3 text-center text-sm text-green-600 backdrop-blur">
        Saved ✓
      </div>
    ) : null
  }
  return (
    <div className="fixed inset-x-0 bottom-0 border-t border-gray-100 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-3xl items-center gap-3 px-6 py-3">
        <span className="text-sm text-gray-600">
          {count} unsaved {count === 1 ? 'change' : 'changes'}
          {blocking > 0 && <span className="text-red-600"> · {blocking} with errors</span>}
        </span>
        <div className="flex-1" />
        {error && <span className="text-sm text-red-600">{error}</span>}
        <Button variant="ghost" onClick={onDiscard} disabled={saving}>Discard</Button>
        <Button variant="primary" onClick={onSave} disabled={saving || blocking > 0}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </div>
  )
}
