import { format } from 'date-fns'
import { requireSupabase } from '../lib/supabase'
import { resolveString } from './app-settings'

/**
 * 02-Sales-Send an offer email. Одна таблица email_templates + прямой POST в make-вебхук.
 * Вебхук берётся из app-settings (БД) с фолбэком на env.
 */

export interface EmailTemplate {
  id: string
  name: string
  subject: string
  content: string // HTML из Quill
  send_from: string | null
  sender_name: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

/* ---------------- CRUD ---------------- */

export async function listTemplates(): Promise<EmailTemplate[]> {
  const sb = requireSupabase()
  const { data, error } = await sb.from('email_templates').select('*').order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as EmailTemplate[]
}

export interface TemplateInput {
  name: string
  subject: string
  content: string
  send_from: string | null
  sender_name: string | null
}

export async function createTemplate(input: TemplateInput): Promise<EmailTemplate> {
  const sb = requireSupabase()
  const { data: auth } = await sb.auth.getUser()
  const { data, error } = await sb
    .from('email_templates')
    .insert({
      name: input.name.trim(),
      subject: input.subject,
      content: input.content,
      send_from: input.send_from,
      sender_name: input.sender_name,
      created_by: auth.user?.id ?? null,
    })
    .select('*')
    .single()
  if (error) throw error
  return data as EmailTemplate
}

export async function updateTemplate(id: string, input: TemplateInput): Promise<void> {
  const sb = requireSupabase()
  // updated_at проставляем явно (в оригинале не обновлялся — тут чиним)
  const { error } = await sb
    .from('email_templates')
    .update({
      name: input.name.trim(),
      subject: input.subject,
      content: input.content,
      send_from: input.send_from,
      sender_name: input.sender_name,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
  if (error) throw error
}

export async function renameTemplate(id: string, name: string): Promise<void> {
  const sb = requireSupabase()
  const { error } = await sb
    .from('email_templates')
    .update({ name: name.trim(), updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

export async function deleteTemplate(id: string): Promise<void> {
  const sb = requireSupabase()
  const { error } = await sb.from('email_templates').delete().eq('id', id)
  if (error) throw error
}

/* ---------------- HTML / dates ---------------- */

/** Эмпирическая чистка HTML из Quill перед отправкой (как в оригинале). */
export function cleanHtml(html: string): string {
  let s = html
  s = s.replace(/<p>\s*<\/p>/gi, '') // пустые абзацы
  s = s.replace(/<p>/gi, '') // открывающий <p> убираем
  s = s.replace(/<\/p>/gi, '<br>') // закрывающий </p> → <br>
  s = s.replace(/(<br\s*\/?>\s*)+(<(?:ul|ol)[^>]*>)/gi, '$2') // <br> перед списком
  s = s.replace(/(<\/(?:ul|ol)>)(\s*<br\s*\/?>)+/gi, '$1') // <br> после списка
  s = s.replace(/(<br\s*\/?>\s*){3,}/gi, '<br><br>') // 3+ <br> → 2
  s = s.replace(/^(\s*<br\s*\/?>)+/i, '') // ведущие <br>
  s = s.replace(/(<br\s*\/?>\s*)+$/i, '') // хвостовые <br>
  return s.trim()
}

/** Дата для payload: «Monday, 2025-07-14». */
export function formatDatePayload(d: Date): string {
  return format(d, 'EEEE, yyyy-MM-dd')
}

/** Дата для отображения: «Monday, July 14th, 2025». */
export function formatDateDisplay(d: Date): string {
  return format(d, 'EEEE, MMMM do, yyyy')
}

/* ---------------- Send ---------------- */

export interface OfferPayload {
  subject: string
  htmlContent: string
  date1: string | null
  date2: string | null
  date3: string | null
  sendFrom: string
  senderName: string
}

export async function sendOffer(payload: OfferPayload): Promise<void> {
  const webhook = await resolveString('sales', 'offer_webhook', import.meta.env.VITE_MAKE_SALES_OFFER_WEBHOOK)
  if (!webhook) throw new Error('Sales offer webhook is not configured (App Settings → Webhooks or .env)')
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`Make webhook error: HTTP ${res.status}`)
}
