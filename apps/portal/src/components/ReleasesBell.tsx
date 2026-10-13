import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, GitCommitHorizontal } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { appByCode } from '../app/appRegistry'
import { commitUrl, listReleases, type Release } from '../services/releases'
import { getPreferences, saveGroupState } from '../services/preferences'
import { Modal } from './ui'
import { cn } from '../lib/utils'

/**
 * Колокольчик обновлений в хедере портала — только для портальной роли Developer.
 *
 * Панель — список выкатов свёрнутыми строками (приложение · версия · дата · сколько пунктов),
 * полный список изменений и подпись (кто пушил, репозиторий, ветка, коммит) — в модалке по клику.
 * Точка на колокольчике — есть выкаты, которых человек ещё не видел; «видел» хранится за ним
 * в user_preferences (группа `releases`) и проставляется при открытии панели.
 */
const SEEN_GROUP = 'releases'

export function appLabel(code: string): string {
  if (code === 'portal') return 'Portal'
  const app = appByCode(code)
  return app?.shortLabel ?? app?.label ?? code
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/**
 * Пункт изменения. Подробность — всплывающая карточка (белая, с тенью) у пункта: при наведении,
 * на телефоне — по тапу. Рендерится в body через портал и позиционируется по экрану, чтобы её
 * не обрезала прокрутка модалки и чтобы она не сдвигала соседние пункты.
 */
function ReleaseItem({ text, detail }: { text: string; detail?: string }) {
  const ref = useRef<HTMLLIElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null)
  const [pinned, setPinned] = useState(false)

  function place() {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const width = Math.min(320, window.innerWidth - 16)
    const left = Math.min(Math.max(8, r.left + 24), window.innerWidth - width - 8)
    const above = r.bottom + 140 > window.innerHeight
    setPos({ left, top: above ? r.top - 6 : r.bottom + 6, above })
  }

  useEffect(() => {
    if (!pinned) return
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) { setPinned(false); setPos(null) }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [pinned])

  return (
    <li
      ref={ref}
      className={cn('flex gap-2 rounded-md px-2 py-1.5 text-sm text-gray-700', detail && 'cursor-help hover:bg-gray-50')}
      onMouseEnter={() => detail && place()}
      onMouseLeave={() => !pinned && setPos(null)}
      onClick={() => {
        if (!detail) return
        if (pinned) { setPinned(false); setPos(null) } else { setPinned(true); place() }
      }}
    >
      <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-gray-400" />
      <span className={cn(detail && 'underline decoration-gray-300 decoration-dotted underline-offset-4')}>{text}</span>
      {detail && pos && createPortal(
        <div
          role="tooltip"
          className="pointer-events-none fixed z-[100] w-[min(20rem,calc(100vw-1rem))] rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-xs leading-relaxed text-gray-700 shadow-lg"
          style={{ left: pos.left, top: pos.top, transform: pos.above ? 'translateY(-100%)' : undefined }}
        >
          {detail}
        </div>,
        document.body,
      )}
    </li>
  )
}

export function ReleasesBell() {
  const { authUser, profile } = useAuth()
  const isDeveloper = (profile?.roles ?? []).some((r) => r.name === 'Developer')
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [app, setApp] = useState<string | null>(null)
  const [opened, setOpened] = useState<Release | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  const releasesQ = useQuery({ queryKey: ['portal-releases'], queryFn: listReleases, enabled: isDeveloper, staleTime: 60_000 })
  const prefsQ = useQuery({
    queryKey: ['user-preferences', authUser?.id ?? null],
    queryFn: getPreferences,
    enabled: isDeveloper && !!authUser,
    staleTime: 60_000,
  })
  const seen = prefsQ.data?.uiState[SEEN_GROUP] ?? {}
  const releases = releasesQ.data ?? []
  const unread = releases.filter((r) => !seen[r.id]).length

  const markSeen = useMutation({
    mutationFn: () => saveGroupState(SEEN_GROUP, Object.fromEntries(releases.map((r) => [r.id, true]))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['user-preferences'] }),
  })

  // Клик вне панели закрывает её (модалка рендерится поверх и сама закрывается).
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !opened) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, opened])

  const apps = useMemo(() => [...new Set(releases.map((r) => r.appCode))].sort((a, b) => appLabel(a).localeCompare(appLabel(b))), [releases])
  const shown = app ? releases.filter((r) => r.appCode === app) : releases

  if (!isDeveloper) return null

  function toggle() {
    const next = !open
    setOpen(next)
    if (next && unread > 0 && !markSeen.isPending) markSeen.mutate()
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={toggle}
        className="relative rounded-md border border-white/30 p-2 hover:bg-white/10"
        aria-label="App updates"
        title="App updates"
      >
        <Bell size={18} />
        {unread > 0 && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-brand-amber ring-2 ring-brand-dark" />}
      </button>

      {open && (
        <div className="absolute right-0 top-12 z-40 w-[min(26rem,calc(100vw-2rem))] rounded-lg border border-gray-200 bg-white text-gray-800 shadow-lg">
          <div className="border-b px-4 py-3">
            <div className="text-sm font-semibold">App updates</div>
            <div className="text-xs text-gray-500">Visible to developers only</div>
          </div>

          {apps.length > 1 && (
            <div className="flex flex-wrap gap-1.5 border-b px-4 py-2">
              {[null, ...apps].map((code) => (
                <button
                  key={code ?? 'all'}
                  onClick={() => setApp(code)}
                  className={cn(
                    'rounded-full border px-2.5 py-0.5 text-xs font-medium transition',
                    app === code ? 'border-brand-blue bg-brand-blue text-white' : 'border-gray-200 text-gray-600 hover:border-gray-300',
                  )}
                >
                  {code ? appLabel(code) : 'All'}
                </button>
              ))}
            </div>
          )}

          <div className="max-h-[60vh] overflow-y-auto">
            {releasesQ.isLoading && <div className="px-4 py-6 text-center text-sm text-gray-400">Loading…</div>}
            {releasesQ.error && <div className="px-4 py-6 text-center text-sm text-red-600">Could not load updates.</div>}
            {!releasesQ.isLoading && !releasesQ.error && shown.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-gray-400">No updates yet.</div>
            )}
            {shown.map((r) => (
              <button
                key={r.id}
                onClick={() => setOpened(r)}
                className="flex w-full items-center gap-3 border-b px-4 py-2.5 text-left last:border-0 hover:bg-gray-50"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">
                    <span className="font-medium text-gray-900">{appLabel(r.appCode)}</span>{' '}
                    <span className="text-gray-500">{r.version}</span>
                  </div>
                  <div className="text-xs text-gray-400">
                    {fmtDate(r.releasedAt)} · {r.items.length} {r.items.length === 1 ? 'change' : 'changes'}
                  </div>
                </div>
                {!seen[r.id] && <span className="h-2 w-2 shrink-0 rounded-full bg-brand-amber" />}
              </button>
            ))}
          </div>
        </div>
      )}

      {opened && (
        <Modal
          open
          title={`${appLabel(opened.appCode)} ${opened.version}`}
          subtitle={fmtDate(opened.releasedAt)}
          onClose={() => setOpened(null)}
        >
          {opened.details.some(Boolean) && (
            <p className="mb-3 text-xs text-gray-400">Hover over a change (tap on a phone) to see the details.</p>
          )}
          <ul className="space-y-1">
            {opened.items.map((it, i) => <ReleaseItem key={i} text={it} detail={opened.details[i]} />)}
          </ul>
          <div className="mt-5 flex flex-wrap items-center gap-x-2 gap-y-1 border-t pt-3 text-xs text-gray-500">
            <GitCommitHorizontal size={14} className="text-gray-400" />
            <span>{opened.pushedBy ?? 'Unknown'}</span>
            {opened.repo && <span>· {opened.repo}</span>}
            {opened.branch && <span>· {opened.branch}</span>}
            {opened.commitSha && (
              commitUrl(opened)
                ? <a href={commitUrl(opened)!} target="_blank" rel="noreferrer" className="font-mono text-brand-blue hover:underline">· {opened.commitSha}</a>
                : <span className="font-mono">· {opened.commitSha}</span>
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}
