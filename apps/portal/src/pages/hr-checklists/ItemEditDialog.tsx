import { useState } from 'react'
import { Plus, Trash2, Upload, X } from 'lucide-react'
import { Button, Field, Input, Modal, Textarea } from '../../components/ui'
import { errMsg } from '../../lib/utils'
import { itemPhotoUrl, uploadItemPhoto } from '../../services/hr-checklists'
import { DEFAULT_ANSWERS, type ChecklistItem, type ItemLink } from '../../domain/hr-checklists'

const MAX_ANSWERS = 10

export interface ItemPatch {
  label: string
  description: string | null
  links: ItemLink[]
  photos: string[]
  answer_options: string[]
}

/** Нормализация ссылки как в оригинале: label → UPPERCASE, url без протокола → https://. */
function normalizeLink(l: ItemLink): ItemLink {
  let url = l.url.trim()
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`
  return { label: l.label.trim().toUpperCase(), url }
}

/** Редактор пункта: label, description, links[], photos[], answer_options[] (≤10). */
export function ItemEditDialog({
  item,
  onClose,
  onSave,
}: {
  item: ChecklistItem
  onClose: () => void
  onSave: (patch: ItemPatch) => void
}) {
  const [label, setLabel] = useState(item.label)
  const [description, setDescription] = useState(item.description ?? '')
  const [links, setLinks] = useState<ItemLink[]>(item.links ?? [])
  const [photos, setPhotos] = useState<string[]>(item.photos ?? [])
  const [answers, setAnswers] = useState<string[]>(
    item.answer_options?.length ? item.answer_options : [...DEFAULT_ANSWERS],
  )
  const [uploading, setUploading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true)
    setErr(null)
    try {
      const name = await uploadItemPhoto(file, item.id)
      setPhotos((p) => [...p, name])
    } catch (x) {
      setErr(errMsg(x))
    } finally {
      setUploading(false)
    }
  }

  function save() {
    onSave({
      label: label.trim(),
      description: description.trim() || null,
      links: links.map(normalizeLink).filter((l) => l.url),
      photos,
      answer_options: answers.map((a) => a.trim()).filter(Boolean),
    })
  }

  return (
    <Modal
      open
      size="lg"
      title="Edit item"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={!label.trim()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="Label" required>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} autoFocus />
        </Field>

        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        </Field>

        <Field label="Answer options" hint={`Up to ${MAX_ANSWERS}. First = green, second = red, rest = gray.`}>
          <div className="space-y-2">
            {answers.map((a, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input value={a} onChange={(e) => setAnswers((arr) => arr.map((x, j) => (j === i ? e.target.value : x)))} />
                <Button variant="ghost" className="text-red-600" onClick={() => setAnswers((arr) => arr.filter((_, j) => j !== i))}>
                  <X size={15} />
                </Button>
              </div>
            ))}
            {answers.length < MAX_ANSWERS && (
              <Button variant="subtle" onClick={() => setAnswers((arr) => [...arr, ''])}>
                <Plus size={14} /> Add option
              </Button>
            )}
          </div>
        </Field>

        <Field label="Links" hint="Label saved as UPPERCASE; URL auto-prefixed with https://">
          <div className="space-y-2">
            {links.map((l, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  className="w-1/3"
                  placeholder="Label"
                  value={l.label}
                  onChange={(e) => setLinks((arr) => arr.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                />
                <Input
                  placeholder="example.com/…"
                  value={l.url}
                  onChange={(e) => setLinks((arr) => arr.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))}
                />
                <Button variant="ghost" className="text-red-600" onClick={() => setLinks((arr) => arr.filter((_, j) => j !== i))}>
                  <X size={15} />
                </Button>
              </div>
            ))}
            <Button variant="subtle" onClick={() => setLinks((arr) => [...arr, { label: '', url: '' }])}>
              <Plus size={14} /> Add link
            </Button>
          </div>
        </Field>

        <Field label="Photos">
          <div className="flex flex-wrap gap-3">
            {photos.map((name, i) => (
              <div key={i} className="relative">
                <img src={itemPhotoUrl(name)} alt="" className="h-20 w-20 rounded-lg border border-gray-200 object-cover" />
                <button
                  onClick={() => setPhotos((arr) => arr.filter((_, j) => j !== i))}
                  className="absolute -right-2 -top-2 rounded-full bg-red-500 p-1 text-white"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            <label className="flex h-20 w-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-gray-300 text-xs text-gray-400 hover:bg-gray-50">
              <Upload size={16} />
              {uploading ? 'Uploading…' : 'Add'}
              <input type="file" accept="image/*" className="hidden" onChange={onPickPhoto} disabled={uploading} />
            </label>
          </div>
        </Field>

        {err && <p className="text-sm text-red-600">{err}</p>}
      </div>
    </Modal>
  )
}
