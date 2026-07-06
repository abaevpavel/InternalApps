import { useState } from 'react'
import { format } from 'date-fns'
import { Check, Pencil, X } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { updateProfileName } from '../services/data'
import { Badge, Button, Card, Input } from '../components/ui'
import { errMsg, initials } from '../lib/utils'
import { fullName } from '../domain/types'

export function MyAccountPage() {
  const { profile, refreshProfile } = useAuth()
  const [editing, setEditing] = useState(false)
  const [first, setFirst] = useState('')
  const [last, setLast] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!profile) return null

  const name = fullName(profile)

  function startEdit() {
    setFirst(profile!.first_name ?? '')
    setLast(profile!.last_name ?? '')
    setError(null)
    setEditing(true)
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      await updateProfileName(profile!.id, first.trim() || null, last.trim() || null)
      await refreshProfile()
      setEditing(false)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <Card className="flex items-center gap-8 p-8">
        <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-full bg-purple-100 text-2xl font-semibold text-purple-700">
          {initials(name, profile.email)}
        </div>

        <div className="min-w-0">
          {editing ? (
            <div className="flex flex-wrap items-center gap-2">
              <Input value={first} onChange={(e) => setFirst(e.target.value)} placeholder="First" className="max-w-[10rem]" autoFocus />
              <Input value={last} onChange={(e) => setLast(e.target.value)} placeholder="Last" className="max-w-[10rem]" />
              <Button variant="primary" onClick={save} disabled={saving} aria-label="save">
                <Check size={15} />
              </Button>
              <Button variant="outline" onClick={() => setEditing(false)} aria-label="cancel">
                <X size={15} />
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <h2 className="truncate text-3xl font-bold text-gray-900">{name || profile.email}</h2>
              <button onClick={startEdit} className="text-gray-400 hover:text-gray-600" aria-label="edit name">
                <Pencil size={17} />
              </button>
            </div>
          )}
          {error && <p className="mt-1 text-sm text-red-600">{error}</p>}

          <p className="mt-1 text-gray-500">{profile.email}</p>

          <div className="mt-3 flex flex-wrap gap-2">
            {profile.roles.length ? (
              profile.roles.map((r) => (
                <Badge key={r.id} className="bg-green-50 text-green-700">{r.name}</Badge>
              ))
            ) : (
              <Badge className="bg-gray-100 text-gray-500">No role</Badge>
            )}
          </div>

          <p className="mt-4 text-sm text-gray-600">
            <span className="font-semibold">Joined:</span>{' '}
            {format(new Date(profile.created_at), 'MMMM d, yyyy')}
          </p>
        </div>
      </Card>
    </div>
  )
}
