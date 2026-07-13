import { requireSupabase } from '../lib/supabase'
import { resolveString } from './app-settings'
import { compressToJpeg } from '../lib/imageCompression'

/**
 * Сервис 03-Production — Send Buildertrend Schedule.
 * Проекты берём из Airtable «General Project Info» через edge-функцию `list-schedule-projects`
 * (тот же источник, по которому сценарий Make ищет проект — иначе имя не совпадёт). Файлы
 * (PDF-расписание или фото) льём в публичный бакет `buildertrend-schedule-photos` и шлём
 * public-URL'ы на Make-вебхук.
 *
 * ⚠️ Контракт вебхука — под существующий сценарий Make «SEND SCHEDULE JOTFORM» (formID
 * 241016020135133). Сценарий: CustomWebhook → parseJson(rawRequest) → Airtable-поиск по
 * `{{12.project}}` → HTTP GET `{{12.input119[1]}}` → Slack-загрузка + email клиенту с вложением
 * `{{12.input119}}`. Значит внутри `rawRequest` (JSON-строка) сценарию нужны ровно два поля:
 *   • project   — имя проекта (Airtable formula {Project Name} = '{{12.project}}')
 *   • input119  — массив public-URL файлов (Make индексирует с 1: input119[1] = первый)
 * Верхний уровень (JotForm-обёртка) сценарием не читается — держим для паритета/отладки.
 * «Перенос как есть»: прямой fetch из браузера, без HMAC (как sales / production-checklist).
 */

const PHOTO_BUCKET = 'buildertrend-schedule-photos'
const MAKE_WEBHOOK = import.meta.env.VITE_MAKE_BUILDERTREND_SCHEDULE as string | undefined

// Идентификаторы исходной JotForm-формы (для паритета обёртки; сценарий их не мапит).
const FORM_ID = '241016020135133'
const FORM_TITLE = 'PM-SEND SCHEDULE'

/** Проект для селектора: `name` — точное `Project Name` (шлём в вебхук), `label` — подпись. */
export interface ScheduleProject {
  name: string
  label: string
}

/** Живой список проектов из Airtable «General Project Info» (через edge-функцию). */
export async function listProjects(): Promise<ScheduleProject[]> {
  const sb = requireSupabase()
  const { data, error } = await sb.functions.invoke('list-schedule-projects')
  if (error) throw error
  if (data?.error) throw new Error(data.error)
  return (data?.projects ?? []) as ScheduleProject[]
}

export interface UploadedFile {
  url: string
  name: string
}

/**
 * Загрузить файл в публичный бакет и вернуть { public URL, имя }.
 * Картинки жмём в JPEG (≤1MB, ≤2000px); PDF и прочее — заливаем как есть (расписание = PDF).
 */
export async function uploadScheduleFile(file: File): Promise<UploadedFile> {
  const sb = requireSupabase()
  const isImage = file.type.startsWith('image/')

  let body: Blob = file
  let ext = (file.name.split('.').pop() || '').toLowerCase()
  let contentType = file.type || 'application/octet-stream'
  if (isImage) {
    body = await compressToJpeg(file, 1024, 2000)
    ext = 'jpg'
    contentType = 'image/jpeg'
  }

  const path = `schedules/${crypto.randomUUID()}.${ext || 'bin'}`
  const { error } = await sb.storage.from(PHOTO_BUCKET).upload(path, body, { upsert: false, contentType })
  if (error) throw error
  const { data } = sb.storage.from(PHOTO_BUCKET).getPublicUrl(path)
  return { url: data.publicUrl, name: file.name }
}

/**
 * POST JotForm-совместимой обёртки на Make-вебхук. Значимая часть — строка `rawRequest`
 * с полями `project` и `input119` (см. шапку файла).
 */
export async function sendSchedule(args: { project: ScheduleProject; files: UploadedFile[] }): Promise<void> {
  const webhook = await resolveString('buildertrend-schedule', 'schedule_webhook', MAKE_WEBHOOK)
  if (!webhook) throw new Error('Buildertrend schedule webhook is not configured (App Settings → Webhooks or .env)')

  const urls = args.files.map((f) => f.url)
  const names = args.files.map((f) => f.name)

  // Значимая нагрузка: сценарий Make парсит именно эту строку и читает project + input119.
  const rawRequest = JSON.stringify({
    slug: `submit/${FORM_ID}`,
    project: args.project.name, // ← Airtable: {Project Name} = '{{12.project}}'
    q115_project: args.project.name, // JotForm-паритет (сценарием не читается)
    input119: urls, // ← http get file {{12.input119[1]}} + email attachment {{12.input119}}
    temp_upload: { q119_input119: names },
    path: `/submit/${FORM_ID}`,
  })

  const payload = {
    action: '',
    webhookURL: webhook,
    username: 'basement_remodeling_com',
    formID: FORM_ID,
    type: 'WEB',
    formTitle: FORM_TITLE,
    submissionID: `${Date.now()}`,
    rawRequest,
    pretty: `Please select the Project:${args.project.name}, :${names.join(', ')}`,
    // служебное — сценарием не используется, для отладки/трассировки
    payload_from: 'buildertrend-schedule',
    sent_at: new Date().toISOString(),
  }

  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`Make webhook error: HTTP ${res.status}`)
}
