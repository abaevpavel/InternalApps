import { useEffect, useRef, useState } from 'react'
import { syncedAgo as ago, useNow } from '../../lib/sync-time'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchSyncStatus, runAutoSyncIfDue } from '../../services/task-planner/sync'
import { usePublishAppHeaderNote, type AppHeaderNote } from '../../app/AppHeaderNote'
import { errMsg } from '../../lib/utils'

/**
 * Автосинк с Airtable при входе в Task Planner и строка «Airtable synced … ago» в шапке.
 * Синк один раз на вход в апку; нужен ли он — решает база (не чаще раза в 10 минут,
 * не параллельно с чужим синком). Ручные кнопки в Directories работают как раньше
 * и тоже обновляют время.
 */
export function useTpAutoSync(enabled: boolean): void {
  const qc = useQueryClient()
  const started = useRef(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const status = useQuery({
    queryKey: ['tp-sync-status'],
    queryFn: fetchSyncStatus,
    enabled,
    refetchInterval: 60_000,
  })
  const now = useNow(30_000)

  useEffect(() => {
    if (!enabled || started.current) return
    started.current = true
    setRunning(true)
    runAutoSyncIfDue()
      .then((synced) => {
        // Справочники могли поменяться — экраны перечитают проекты, бригады, навыки.
        if (synced) void qc.invalidateQueries()
        else void qc.invalidateQueries({ queryKey: ['tp-sync-status'] })
      })
      .catch((e: unknown) => {
        setError(errMsg(e))
        void qc.invalidateQueries({ queryKey: ['tp-sync-status'] })
      })
      .finally(() => setRunning(false))
  }, [enabled, qc])

  const s = status.data
  let note: AppHeaderNote | null = null
  if (enabled) {
    if (running || s?.inProgress) {
      note = { text: 'Syncing with Airtable…' }
    } else if (error || s?.lastError) {
      const last = s?.lastSyncedAt ? `last successful ${ago(s.lastSyncedAt, now)}` : 'no successful sync yet'
      note = { text: `Airtable sync failed · ${last}`, tone: 'warning', title: error ?? s?.lastError ?? undefined }
    } else if (s?.lastSyncedAt) {
      note = { text: `Airtable synced ${ago(s.lastSyncedAt, now)}`, title: new Date(s.lastSyncedAt).toLocaleString('en-US') }
    } else if (s) {
      note = { text: 'Not synced with Airtable yet' }
    }
  }
  usePublishAppHeaderNote(note)
}

