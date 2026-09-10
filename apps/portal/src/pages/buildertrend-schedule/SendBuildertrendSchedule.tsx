import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, FileText, Send, UploadCloud, X } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { Button, Card, PageTitle, StatusBadge, Tabs } from '../../components/ui'
import { SearchableCombobox, type ComboOption } from '../hr-checklists/SearchableCombobox'
import { cn, errMsg } from '../../lib/utils'
import {
  listProjects,
  listSends,
  sendSchedule,
  uploadScheduleFile,
  type ScheduleProject,
  type ScheduleSend,
  type UploadedFile,
} from '../../services/buildertrend-schedule'

/** Выбранный файл: PDF или картинка. previewUrl задан только для картинок (objectURL — чистим). */
interface FilePick {
  id: string
  file: File
  isImage: boolean
  previewUrl: string | null
}

const ACCEPT = 'image/*,application/pdf'
const isAccepted = (f: File) => f.type.startsWith('image/') || f.type === 'application/pdf'

export function SendBuildertrendSchedulePage() {
  const [projects, setProjects] = useState<ScheduleProject[]>([])
  const [loadingProjects, setLoadingProjects] = useState(true)
  const [projectName, setProjectName] = useState<string | null>(null)
  const [picks, setPicks] = useState<FilePick[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [status, setStatus] = useState<{ type: 'success' | 'error'; msg: string } | null>(null)
  const [tab, setTab] = useState<'send' | 'history'>('send')
  const inputRef = useRef<HTMLInputElement>(null)
  const picksRef = useRef<FilePick[]>([])
  picksRef.current = picks

  useEffect(() => {
    listProjects()
      .then(setProjects)
      .catch((e) => setStatus({ type: 'error', msg: errMsg(e) }))
      .finally(() => setLoadingProjects(false))
  }, [])

  // освобождаем objectURL превью при размонтировании (последний снимок picks — через ref)
  useEffect(() => () => picksRef.current.forEach((p) => p.previewUrl && URL.revokeObjectURL(p.previewUrl)), [])

  const options: ComboOption[] = useMemo(
    () => projects.map((p) => ({ value: p.name, label: p.label })),
    [projects],
  )
  const project = projects.find((p) => p.name === projectName) ?? null

  function addFiles(files: FileList | File[]) {
    const accepted = Array.from(files).filter(isAccepted)
    if (!accepted.length) return
    setStatus(null)
    setPicks((prev) => [
      ...prev,
      ...accepted.map((file) => {
        const isImage = file.type.startsWith('image/')
        return {
          id: crypto.randomUUID(),
          file,
          isImage,
          previewUrl: isImage ? URL.createObjectURL(file) : null,
        }
      }),
    ])
  }

  function removePick(id: string) {
    setPicks((prev) => {
      const gone = prev.find((p) => p.id === id)
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl)
      return prev.filter((p) => p.id !== id)
    })
  }

  const canSubmit = !!project && picks.length > 0 && !submitting

  async function submit() {
    if (!project || picks.length === 0) return
    setSubmitting(true)
    setStatus(null)
    try {
      const uploaded: UploadedFile[] = []
      for (const p of picks) uploaded.push(await uploadScheduleFile(p.file))
      await sendSchedule({ project, files: uploaded })
      picks.forEach((p) => p.previewUrl && URL.revokeObjectURL(p.previewUrl))
      setPicks([])
      setProjectName(null)
      setStatus({
        type: 'success',
        msg: `Schedule sent for “${project.name}” (${uploaded.length} file${uploaded.length > 1 ? 's' : ''}).`,
      })
    } catch (e) {
      setStatus({ type: 'error', msg: errMsg(e) })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-10 sm:px-6">
      <PageTitle title="Send Buildertrend Schedule" subtitle="Pick a project, attach the schedule (PDF or photos), and submit." />

      <Tabs<'send' | 'history'>
        className="mb-6 max-w-xs"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'send', label: 'Send' },
          { key: 'history', label: 'History' },
        ]}
      />

      {tab === 'history' && <HistoryTab />}

      {tab === 'send' && (
      <Card className="p-6">
        {/* Шаг 1 — проект */}
        <label className="mb-1.5 block text-sm font-semibold text-gray-900">
          Project <span className="text-red-500">*</span>
        </label>
        <SearchableCombobox
          value={projectName}
          onChange={(v) => {
            setProjectName(v)
            setStatus(null)
          }}
          options={options}
          placeholder={loadingProjects ? 'Loading projects…' : 'Select a project'}
          searchPlaceholder="Search projects…"
          disabled={loadingProjects}
        />

        {/* Шаг 2 — файлы (PDF-расписание или фото) */}
        <label className="mb-1.5 mt-6 block text-sm font-semibold text-gray-900">
          Schedule files <span className="text-red-500">*</span>
        </label>
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            addFiles(e.dataTransfer.files)
          }}
          onClick={() => inputRef.current?.click()}
          className={cn(
            'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center transition',
            dragOver ? 'border-accent-500 bg-accent-50' : 'border-gray-300 bg-gray-50 hover:bg-gray-100',
          )}
        >
          <UploadCloud size={30} className="text-gray-400" />
          <div className="text-sm font-medium text-gray-700">Drag &amp; drop the schedule (PDF or photos), or click to browse</div>
          <div className="text-xs text-gray-400">PDFs are sent as-is; images are compressed before upload</div>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files)
              e.target.value = ''
            }}
          />
        </div>

        {picks.length > 0 && (
          <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-4">
            {picks.map((p) => (
              <div
                key={p.id}
                className="group relative aspect-square overflow-hidden rounded-lg border border-gray-200 bg-gray-100"
              >
                {p.isImage && p.previewUrl ? (
                  <img src={p.previewUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 p-2 text-center">
                    <FileText size={26} className="text-red-500" />
                    <span className="line-clamp-2 break-all text-[11px] leading-tight text-gray-600">{p.file.name}</span>
                  </div>
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    removePick(p.id)
                  }}
                  className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white opacity-0 transition group-hover:opacity-100"
                  aria-label="Remove file"
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="mt-6 flex items-center justify-between gap-3">
          <span className="text-xs text-gray-400">
            {picks.length > 0 ? `${picks.length} file${picks.length > 1 ? 's' : ''} attached` : 'No files yet'}
          </span>
          <Button variant="blue" onClick={submit} disabled={!canSubmit}>
            <Send size={16} /> {submitting ? 'Submitting…' : 'Submit'}
          </Button>
        </div>

        {status && (
          <div
            className={cn(
              'mt-4 flex items-start gap-2 rounded-lg px-3 py-2 text-sm',
              status.type === 'success' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700',
            )}
          >
            {status.type === 'success' ? (
              <CheckCircle2 size={15} className="mt-0.5 shrink-0" />
            ) : (
              <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            )}
            <span>{status.msg}</span>
          </div>
        )}
      </Card>
      )}
    </div>
  )
}

/**
 * История отправок. Раньше от отправки не оставалось следа: в базу приложение не писало,
 * а в бакете лежал файл под случайным uuid — без проекта, автора и отметки, что его
 * отправили. Теперь каждая попытка пишется в `bts_sends`, включая неудачные.
 */
function HistoryTab() {
  const q = useQuery({ queryKey: ['bts-sends'], queryFn: () => listSends(100) })

  if (q.isLoading) return <Card className="px-6 py-12 text-center text-sm text-gray-400">Loading…</Card>
  if (q.error) return <Card className="px-6 py-12 text-center text-sm text-red-600">{errMsg(q.error)}</Card>

  const rows = q.data ?? []
  if (rows.length === 0) {
    return (
      <Card className="px-6 py-12 text-center text-sm text-gray-400">
        Nothing sent yet. History starts from the first submission after this update.
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      {rows.map((r: ScheduleSend) => (
        <Card key={r.id} className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-gray-900">{r.project_name}</span>
                <StatusBadge tone={r.status === 'sent' ? 'success' : 'danger'}>
                  {r.status === 'sent' ? 'Sent' : 'Failed'}
                </StatusBadge>
              </div>
              <div className="mt-1 text-xs text-gray-500">{new Date(r.sent_at).toLocaleString('en-US')}</div>
              {r.error && <div className="mt-1 text-xs text-red-600">{r.error}</div>}
            </div>
            <div className="flex flex-wrap gap-2">
              {(r.files ?? []).map((f, i) => (
                <a
                  key={i}
                  href={f.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50"
                >
                  <FileText size={13} className="text-gray-400" />
                  {f.name}
                </a>
              ))}
            </div>
          </div>
        </Card>
      ))}
    </div>
  )
}
