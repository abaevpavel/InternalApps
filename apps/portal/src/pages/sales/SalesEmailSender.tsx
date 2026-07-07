import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import ReactQuill from 'react-quill-new'
import 'react-quill-new/dist/quill.snow.css'
import { ChevronDown, Pencil, Save, Send, Trash2 } from 'lucide-react'
import { Button, Card, Field, Input, Modal } from '../../components/ui'
import { cn, errMsg } from '../../lib/utils'
import { DatePicker } from './DatePicker'
import {
  cleanHtml,
  createTemplate,
  deleteTemplate,
  formatDatePayload,
  listTemplates,
  renameTemplate,
  sendOffer,
  updateTemplate,
  type EmailTemplate,
} from '../../services/sales'

/* ---------------- localStorage draft ---------------- */

const LS = {
  subject: 'sales-email-subject',
  content: 'sales-email-content',
  date1: 'sales-email-date1',
  date2: 'sales-email-date2',
  date3: 'sales-email-date3',
  from: 'sales-email-from',
  sender: 'sales-email-sender-name',
}
const lsDate = (k: string): Date | null => {
  const v = localStorage.getItem(k)
  return v ? new Date(v) : null
}
const setLsDate = (k: string, d: Date | null) => (d ? localStorage.setItem(k, d.toISOString()) : localStorage.removeItem(k))

/* ---------------- Quill config ---------------- */

const quillModules = {
  toolbar: [
    [{ header: [1, 2, 3, 4, 5, 6, false] }],
    [{ font: [] }],
    [{ size: ['small', false, 'large', 'huge'] }],
    ['bold', 'italic', 'underline', 'strike'],
    [{ color: [] }, { background: [] }],
    [{ script: 'sub' }, { script: 'super' }],
    [{ list: 'ordered' }, { list: 'bullet' }],
    [{ indent: '-1' }, { indent: '+1' }],
    [{ direction: 'rtl' }],
    [{ align: [] }],
    ['link', 'image', 'video'],
    ['blockquote', 'code-block'],
    ['clean'],
  ],
}

/* ---------------- helpers ---------------- */

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase())
const stripHtml = (html: string) =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim()

type Dialog = 'save' | 'update' | 'clear' | 'send' | 'load' | 'delete' | 'rename' | null

export function SalesEmailSenderPage() {
  const qc = useQueryClient()

  const [subject, setSubject] = useState(() => localStorage.getItem(LS.subject) ?? '')
  const [content, setContent] = useState(() => localStorage.getItem(LS.content) ?? '')
  const [date1, setDate1] = useState<Date | null>(() => lsDate(LS.date1))
  const [date2, setDate2] = useState<Date | null>(() => lsDate(LS.date2))
  const [date3, setDate3] = useState<Date | null>(() => lsDate(LS.date3))
  const [sendFrom, setSendFrom] = useState(() => localStorage.getItem(LS.from) ?? '')
  const [senderName, setSenderName] = useState(() => localStorage.getItem(LS.sender) ?? '')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // persist to localStorage
  useEffect(() => localStorage.setItem(LS.subject, subject), [subject])
  useEffect(() => localStorage.setItem(LS.content, content), [content])
  useEffect(() => setLsDate(LS.date1, date1), [date1])
  useEffect(() => setLsDate(LS.date2, date2), [date2])
  useEffect(() => setLsDate(LS.date3, date3), [date3])
  useEffect(() => localStorage.setItem(LS.from, sendFrom), [sendFrom])
  useEffect(() => localStorage.setItem(LS.sender, senderName), [senderName])

  const templatesQ = useQuery({ queryKey: ['email-templates'], queryFn: listTemplates })
  const selected = templatesQ.data?.find((t) => t.id === selectedId) ?? null

  const [dialog, setDialog] = useState<Dialog>(null)
  const [saveName, setSaveName] = useState('')
  const [pendingLoad, setPendingLoad] = useState<EmailTemplate | null>(null)
  const [pendingDelete, setPendingDelete] = useState<EmailTemplate | null>(null)
  const [renameTarget, setRenameTarget] = useState<EmailTemplate | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const canSend = !!(subject.trim() && stripHtml(content) && sendFrom.trim() && senderName.trim())
  const canSaveNew = !!(saveName.trim() && subject.trim() && stripHtml(content))

  function applyTemplate(t: EmailTemplate) {
    setSubject(t.subject)
    setContent(t.content)
    setSendFrom(t.send_from ?? '')
    setSenderName(t.sender_name ?? '')
    setSelectedId(t.id)
  }

  const invalidate = () => qc.invalidateQueries({ queryKey: ['email-templates'] })

  const saveM = useMutation({
    mutationFn: () =>
      createTemplate({ name: saveName, subject, content, send_from: sendFrom || null, sender_name: senderName || null }),
    onSuccess: (t) => {
      invalidate()
      setSelectedId(t.id)
      setDialog(null)
      setSaveName('')
    },
    onError: (e) => setErr(errMsg(e)),
  })
  const updateM = useMutation({
    mutationFn: () =>
      updateTemplate(selected!.id, {
        name: selected!.name,
        subject,
        content,
        send_from: sendFrom || null,
        sender_name: senderName || null,
      }),
    onSuccess: () => {
      invalidate()
      setDialog(null)
    },
    onError: (e) => setErr(errMsg(e)),
  })
  const deleteM = useMutation({
    mutationFn: (id: string) => deleteTemplate(id),
    onSuccess: (_r, id) => {
      invalidate()
      if (selectedId === id) setSelectedId(null)
      setDialog(null)
      setPendingDelete(null)
    },
    onError: (e) => setErr(errMsg(e)),
  })
  const renameM = useMutation({
    mutationFn: () => renameTemplate(renameTarget!.id, renameValue),
    onSuccess: () => {
      invalidate()
      setDialog(null)
      setRenameTarget(null)
    },
    onError: (e) => setErr(errMsg(e)),
  })
  const sendM = useMutation({
    mutationFn: () =>
      sendOffer({
        subject: subject.trim(),
        htmlContent: cleanHtml(content),
        date1: date1 ? formatDatePayload(date1) : null,
        date2: date2 ? formatDatePayload(date2) : null,
        date3: date3 ? formatDatePayload(date3) : null,
        sendFrom: sendFrom.trim().toLowerCase(),
        senderName: senderName.trim(),
      }),
    onSuccess: () => setDialog(null),
    onError: (e) => setErr(errMsg(e)),
  })

  function clearAll() {
    Object.values(LS).forEach((k) => localStorage.removeItem(k))
    setSubject('')
    setContent('')
    setDate1(null)
    setDate2(null)
    setDate3(null)
    setSendFrom('')
    setSenderName('')
    setSelectedId(null)
    setDialog(null)
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <Card className="p-8">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900">
            <Send size={22} className="text-brand-blue" /> Sales Email Composer
          </h1>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => { setSaveName(''); setErr(null); setDialog('save') }}>
              <Save size={16} /> Save as New
            </Button>
            <Button variant="outline" disabled={!selected} onClick={() => { setErr(null); setDialog('update') }}>
              <Save size={16} /> Update Template
            </Button>
          </div>
        </div>

        <div className="grid gap-5 md:grid-cols-2">
          <Field label="Email Subject">
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject…" />
          </Field>
          <Field label="Load Template">
            <TemplatePicker
              templates={templatesQ.data ?? []}
              selected={selected}
              onPick={(t) => { setPendingLoad(t); setErr(null); setDialog('load') }}
              onRename={(t) => { setRenameTarget(t); setRenameValue(t.name); setErr(null); setDialog('rename') }}
              onDelete={(t) => { setPendingDelete(t); setErr(null); setDialog('delete') }}
            />
          </Field>
        </div>

        <div className="mt-5 grid gap-5 md:grid-cols-3">
          <Field label="Date 1"><DatePicker value={date1} onChange={setDate1} /></Field>
          <Field label="Date 2"><DatePicker value={date2} onChange={setDate2} /></Field>
          <Field label="Date 3"><DatePicker value={date3} onChange={setDate3} /></Field>
        </div>

        <div className="mt-5">
          <label className="mb-1 block text-sm font-medium text-gray-700">Email Content (HTML Format)</label>
          <ReactQuill theme="snow" value={content} onChange={setContent} modules={quillModules} />
        </div>

        <div className="mt-6 grid items-end gap-5 md:grid-cols-3">
          <Field label="Send Email From">
            <Input
              type="email"
              value={sendFrom}
              onChange={(e) => setSendFrom(e.target.value.toLowerCase())}
              placeholder="you@basementremodeling.com"
            />
          </Field>
          <Field label="Sender Name">
            <Input value={senderName} onChange={(e) => setSenderName(titleCase(e.target.value))} placeholder="First Last" />
          </Field>
          <div className="flex items-center justify-end gap-2">
            <Button variant="subtle" onClick={() => { setErr(null); setDialog('clear') }}>
              Clear
            </Button>
            <Button variant="blue" disabled={!canSend} onClick={() => { setErr(null); setDialog('send') }}>
              <Send size={16} /> Send Email
            </Button>
          </div>
        </div>
        <p className="mt-2 text-right text-xs text-gray-400">
          Note: "Send Email" sends a payload to the "Email with sales offer" webhook in make.com.
        </p>
      </Card>

      {/* ---------- dialogs ---------- */}

      <Modal
        open={dialog === 'save'}
        title="Save as new template"
        onClose={() => setDialog(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button>
            <Button variant="primary" disabled={!canSaveNew || saveM.isPending} onClick={() => saveM.mutate()}>Save</Button>
          </>
        }
      >
        <Field label="Template name" required>
          <Input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="e.g. Past-client re-engagement" autoFocus />
        </Field>
        {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
      </Modal>

      <ConfirmModal
        open={dialog === 'update'}
        title="Update template?"
        body={`Overwrite "${selected?.name}" with the current content?`}
        confirmLabel="Update"
        pending={updateM.isPending}
        err={err}
        onCancel={() => setDialog(null)}
        onConfirm={() => updateM.mutate()}
      />

      <ConfirmModal
        open={dialog === 'load'}
        title="Load template?"
        body="This replaces the current subject, content and sender fields. Unsaved changes will be lost."
        confirmLabel="Load"
        err={err}
        onCancel={() => { setDialog(null); setPendingLoad(null) }}
        onConfirm={() => { if (pendingLoad) applyTemplate(pendingLoad); setDialog(null); setPendingLoad(null) }}
      />

      <ConfirmModal
        open={dialog === 'delete'}
        title="Delete template?"
        body={`Delete "${pendingDelete?.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        danger
        pending={deleteM.isPending}
        err={err}
        onCancel={() => { setDialog(null); setPendingDelete(null) }}
        onConfirm={() => pendingDelete && deleteM.mutate(pendingDelete.id)}
      />

      <ConfirmModal
        open={dialog === 'clear'}
        title="Clear the form?"
        body="This clears all fields and the saved draft."
        confirmLabel="Clear"
        danger
        onCancel={() => setDialog(null)}
        onConfirm={clearAll}
      />

      <ConfirmModal
        open={dialog === 'send'}
        title="Send offer email?"
        body="This sends the payload to the make.com webhook, which will email the recipient list from Airtable."
        confirmLabel={sendM.isPending ? 'Sending…' : 'Send'}
        pending={sendM.isPending}
        err={err}
        onCancel={() => setDialog(null)}
        onConfirm={() => sendM.mutate()}
      />

      <Modal
        open={dialog === 'rename'}
        title="Rename template"
        onClose={() => setDialog(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button>
            <Button variant="primary" disabled={!renameValue.trim() || renameM.isPending} onClick={() => renameM.mutate()}>Save</Button>
          </>
        }
      >
        <Field label="Name" required>
          <Input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} autoFocus />
        </Field>
        {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
      </Modal>
    </div>
  )
}

/* ---------------- template picker ---------------- */

function TemplatePicker({
  templates,
  selected,
  onPick,
  onRename,
  onDelete,
}: {
  templates: EmailTemplate[]
  selected: EmailTemplate | null
  onPick: (t: EmailTemplate) => void
  onRename: (t: EmailTemplate) => void
  onDelete: (t: EmailTemplate) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm transition hover:bg-gray-50 focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
      >
        <span className={cn('truncate', !selected && 'text-gray-400')}>{selected?.name ?? 'Select a template…'}</span>
        <ChevronDown size={15} className={cn('shrink-0 text-gray-400 transition', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
          {templates.length === 0 && <div className="px-3 py-2 text-sm text-gray-400">No templates yet</div>}
          {templates.map((t) => (
            <div key={t.id} className="group flex items-center gap-1 px-2 hover:bg-gray-50">
              <button
                type="button"
                onClick={() => { onPick(t); setOpen(false) }}
                className={cn('flex-1 truncate py-2 pl-1 text-left text-sm', selected?.id === t.id ? 'font-medium text-gray-900' : 'text-gray-700')}
              >
                {t.name}
              </button>
              <button
                type="button"
                onClick={() => { onRename(t); setOpen(false) }}
                className="rounded p-1 text-gray-300 opacity-0 hover:bg-gray-100 hover:text-gray-600 group-hover:opacity-100"
                title="Rename"
              >
                <Pencil size={14} />
              </button>
              <button
                type="button"
                onClick={() => { onDelete(t); setOpen(false) }}
                className="rounded p-1 text-gray-300 opacity-0 hover:bg-red-50 hover:text-red-600 group-hover:opacity-100"
                title="Delete"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ---------------- confirm modal ---------------- */

function ConfirmModal({
  open,
  title,
  body,
  confirmLabel,
  danger,
  pending,
  err,
  onCancel,
  onConfirm,
}: {
  open: boolean
  title: string
  body: string
  confirmLabel: string
  danger?: boolean
  pending?: boolean
  err?: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} disabled={pending} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {body}
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
    </Modal>
  )
}
