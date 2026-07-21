import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { Button, Card, Field, Input, PageTitle, Tabs, Textarea } from '../components/ui'
import { errMsg } from '../lib/utils'
import { appByCode, type AppConfig, type WebhookField } from '../app/appRegistry'
import { getSettingsMap, setSetting } from '../services/app-settings'
import { listBucketsSafe, probeTables } from '../services/resources'

type SettingsTab = 'general' | 'resources' | 'webhooks'

export function AppSettingsPage() {
  const { appCode = '' } = useParams()
  const nav = useNavigate()
  const app = appByCode(appCode)
  const [tab, setTab] = useState<SettingsTab>('general')

  if (!app) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10 text-center text-gray-400">
        Unknown app: <span className="font-mono">{appCode}</span>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <button
        onClick={() => nav(app.routePrefixes[0] ?? '/')}
        className="mb-6 inline-flex items-center gap-2 text-sm text-gray-500 hover:text-gray-800"
      >
        <ArrowLeft size={16} /> Back to app
      </button>
      <PageTitle title={`${app.label} — Settings`} subtitle="App-scoped configuration. Changes apply to everyone (admin only)." />
      <Tabs
        className="mb-6 max-w-md"
        tabs={[
          { key: 'general' as SettingsTab, label: 'General' },
          { key: 'resources' as SettingsTab, label: 'Resources' },
          ...(app.webhooks.length ? [{ key: 'webhooks' as SettingsTab, label: 'Webhooks' }] : []),
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'general' && <GeneralTab app={app} />}
      {tab === 'resources' && <ResourcesTab app={app} />}
      {tab === 'webhooks' && <WebhooksTab app={app} />}
    </div>
  )
}

function ResourcesTab({ app }: { app: AppConfig }) {
  const r = app.resources
  const tables = r?.tables ?? []
  const declaredBuckets = r?.storageBuckets ?? []

  const tablesQ = useQuery({
    queryKey: ['probe-tables', app.code],
    queryFn: () => probeTables(tables),
    enabled: tables.length > 0,
  })
  const bucketsQ = useQuery({
    queryKey: ['probe-buckets'],
    queryFn: listBucketsSafe,
    enabled: declaredBuckets.length > 0,
  })

  if (!r) return <Card className="px-6 py-10 text-center text-sm text-gray-400">No resource info for this app.</Card>

  const liveByName = new Map((bucketsQ.data ?? []).map((b) => [b.name, b]))

  return (
    <Card className="space-y-5 p-6">
      <p className="text-sm text-gray-500">
        Live overview — tables show current row counts (verified against the DB); buckets show real public/private.
        Edge functions & external integrations are declared (can't be introspected from the client).
      </p>

      {r.database && <ResourceRow label="Database" items={[r.database]} />}

      {/* Tables — live row counts */}
      <div>
        <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">Tables</div>
        {tables.length === 0 ? (
          <span className="text-sm text-gray-400">—</span>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {tables.map((t) => {
              const probe = tablesQ.data?.find((p) => p.table === t)
              const loading = tablesQ.isLoading
              const badge = loading ? '…' : probe ? (probe.ok ? `${probe.count} rows` : 'unreachable') : ''
              const tone = loading
                ? 'border-gray-200 bg-gray-50 text-gray-500'
                : probe?.ok
                  ? 'border-green-200 bg-green-50 text-green-700'
                  : 'border-red-200 bg-red-50 text-red-700'
              return (
                <span key={t} className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs ${tone}`}>
                  <span className="font-mono">{t}</span>
                  <span className="opacity-70">· {badge}</span>
                </span>
              )
            })}
          </div>
        )}
      </div>

      {/* Storage buckets — real public/private */}
      <div>
        <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">Storage buckets</div>
        {declaredBuckets.length === 0 ? (
          <span className="text-sm text-gray-400">—</span>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {declaredBuckets.map((name) => {
              const live = liveByName.get(name)
              const unknown = bucketsQ.data == null // API недоступен
              const missing = !unknown && !live
              const tone = unknown
                ? 'border-gray-200 bg-gray-50 text-gray-600'
                : missing
                  ? 'border-red-200 bg-red-50 text-red-700'
                  : live!.public
                    ? 'border-amber-200 bg-amber-50 text-amber-700'
                    : 'border-green-200 bg-green-50 text-green-700'
              const tag = bucketsQ.isLoading ? '…' : unknown ? 'declared' : missing ? 'missing' : live!.public ? 'public' : 'private'
              return (
                <span key={name} className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs ${tone}`}>
                  <span className="font-mono">{name}</span>
                  <span className="opacity-70">· {tag}</span>
                </span>
              )
            })}
          </div>
        )}
      </div>

      <ResourceRow label="Edge functions (declared)" items={r.edgeFunctions} mono empty="—" />

      {r.external && r.external.length > 0 && (
        <div>
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">
            External integrations (declared)
          </div>
          <ul className="space-y-1.5">
            {r.external.map((x, i) => (
              <li key={i} className="text-sm text-gray-700">
                <span className="font-medium">{x.name}</span>
                {x.detail && <span className="text-gray-500"> — {x.detail}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  )
}

function ResourceRow({ label, items, mono, empty }: { label: string; items?: string[]; mono?: boolean; empty?: string }) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">{label}</div>
      {items && items.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {items.map((it, i) => (
            <span
              key={i}
              className={
                'inline-flex items-center rounded-md border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs text-gray-700' +
                (mono ? ' font-mono' : '')
              }
            >
              {it}
            </span>
          ))}
        </div>
      ) : (
        <span className="text-sm text-gray-400">{empty ?? '—'}</span>
      )}
    </div>
  )
}

function GeneralTab({ app }: { app: AppConfig }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['app-settings', app.code], queryFn: () => getSettingsMap(app.code) })
  return (
    <Card className="p-6">
      <DescriptionField
        appCode={app.code}
        current={q.data?.description as string | undefined}
        onSaved={() => qc.invalidateQueries({ queryKey: ['app-settings', app.code] })}
      />
    </Card>
  )
}

function DescriptionField({
  appCode,
  current,
  onSaved,
}: {
  appCode: string
  current: string | undefined
  onSaved: () => void
}) {
  const [value, setValue] = useState(current ?? '')
  useEffect(() => {
    if (current !== undefined) setValue(current)
  }, [current])

  const saveM = useMutation({
    mutationFn: () => setSetting(appCode, 'description', value.trim()),
    onSuccess: onSaved,
  })

  return (
    <Field label="Project description" hint="Free-text description of this app/project. Stored in app_settings.">
      <Textarea rows={5} value={value} onChange={(e) => setValue(e.target.value)} placeholder="Describe this project…" />
      <div className="mt-2 flex items-center gap-2">
        <Button variant="primary" disabled={saveM.isPending} onClick={() => saveM.mutate()}>
          Save
        </Button>
        {saveM.isSuccess && <span className="text-sm text-green-600">Saved ✓</span>}
        {saveM.error && <span className="text-sm text-red-600">{errMsg(saveM.error)}</span>}
      </div>
    </Field>
  )
}

function WebhooksTab({ app }: { app: AppConfig }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['app-settings', app.code], queryFn: () => getSettingsMap(app.code) })

  if (app.webhooks.length === 0) {
    return <Card className="px-6 py-10 text-center text-sm text-gray-400">No webhooks for this app.</Card>
  }

  return (
    <Card className="space-y-6 p-6">
      {app.webhooks.map((w) => (
        <WebhookRow
          key={w.key}
          appCode={app.code}
          field={w}
          current={q.data?.[w.key] as string | undefined}
          onSaved={() => qc.invalidateQueries({ queryKey: ['app-settings', app.code] })}
        />
      ))}
    </Card>
  )
}

function WebhookRow({
  appCode,
  field,
  current,
  onSaved,
}: {
  appCode: string
  field: WebhookField
  current: string | undefined
  onSaved: () => void
}) {
  const [value, setValue] = useState(current ?? field.envDefault ?? '')
  useEffect(() => {
    if (current !== undefined) setValue(current)
  }, [current])

  const saveM = useMutation({
    mutationFn: () => setSetting(appCode, field.key, value.trim()),
    onSuccess: onSaved,
  })

  const overridden = current !== undefined

  return (
    <Field label={field.label} hint={field.hint}>
      <div className="flex gap-2">
        <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://…" />
        <Button variant="primary" disabled={saveM.isPending} onClick={() => saveM.mutate()}>
          Save
        </Button>
      </div>
      <p className="mt-1 text-xs text-gray-400">
        {overridden ? 'Overridden in DB.' : 'Using the built-in default (env). Saving stores an override in the DB.'}
        {saveM.isSuccess && <span className="text-green-600"> · Saved ✓</span>}
        {saveM.error && <span className="text-red-600"> · {errMsg(saveM.error)}</span>}
      </p>
    </Field>
  )
}
