/**
 * Dev Apps · схема Airtable (02-Sales, 03-Projects): все поля Lead / Opportunity / Project.
 * Снимок — только структура, без записей (scripts/build_airtable_schema.py).
 */

export interface AirtableField {
  id: string
  name: string
  type: string
  description: string | null
  /** Вычисляется Airtable (формула, lookup, rollup, кнопка…) — руками не вводится. */
  computed: boolean
  primary: boolean
  /** Эвристика: копия, безымянное, временное, разовый оффер, опечатка. */
  junk: boolean
  formula?: string
  resultType?: string | null
  choices?: string[]
  linksTo?: string
  linkedTableId?: string
  via?: string | null
  source?: string
  label?: string | null
}

export interface AirtableTable {
  id: string
  name: string
  /** Роль в цепочке продаж для ключевых таблиц; null — вспомогательная. */
  role: string | null
  description: string | null
  fields: AirtableField[]
}

export interface AirtableBase {
  id: string
  name: string
  url: string
  tables: AirtableTable[]
}

export interface AirtableSnapshot {
  generatedAt: string
  bases: AirtableBase[]
}

const TYPE_LABELS: Record<string, string> = {
  singleLineText: 'Text',
  multilineText: 'Long text',
  richText: 'Rich text',
  email: 'Email',
  url: 'URL',
  phoneNumber: 'Phone',
  number: 'Number',
  currency: 'Currency',
  percent: 'Percent',
  checkbox: 'Checkbox',
  date: 'Date',
  dateTime: 'Date & time',
  singleSelect: 'Single select',
  multipleSelects: 'Multiple select',
  multipleRecordLinks: 'Link',
  multipleLookupValues: 'Lookup',
  rollup: 'Rollup',
  count: 'Count',
  formula: 'Formula',
  button: 'Button',
  multipleAttachments: 'Attachments',
  createdTime: 'Created time',
  lastModifiedTime: 'Last modified',
  autoNumber: 'Auto number',
  createdBy: 'Created by',
  lastModifiedBy: 'Modified by',
  singleCollaborator: 'Collaborator',
  multipleCollaborators: 'Collaborators',
  rating: 'Rating',
  duration: 'Duration',
  barcode: 'Barcode',
}

export function typeLabel(t: string): string {
  return TYPE_LABELS[t] ?? t
}

export type FieldFilter = 'all' | 'input' | 'computed' | 'junk'

export function matchesField(f: AirtableField, filter: FieldFilter, needle: string): boolean {
  if (filter === 'input' && f.computed) return false
  if (filter === 'computed' && !f.computed) return false
  if (filter === 'junk' && !f.junk) return false
  if (!needle) return true
  const n = needle.toLowerCase()
  return [f.name, f.description ?? '', f.formula ?? '', f.linksTo ?? '', f.source ?? '', f.via ?? '', ...(f.choices ?? [])]
    .some((x) => x.toLowerCase().includes(n))
}
