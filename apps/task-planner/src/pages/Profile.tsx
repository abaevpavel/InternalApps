import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useAuth } from '../auth/AuthProvider'
import { Button, Card, Input, Field, PageTitle } from '../components/ui'
import { fetchMyProfile, updateMyProfile, updateMyPassword } from '../services/data'
import { errMsg } from '../lib/utils'

export function ProfilePage() {
  const { user } = useAuth()
  const profile = useQuery({ queryKey: ['myProfile'], queryFn: fetchMyProfile })

  const [first, setFirst] = useState('')
  const [last, setLast] = useState('')
  // подставляем значения из БД, когда подгрузились
  useEffect(() => {
    if (profile.data) { setFirst(profile.data.first_name); setLast(profile.data.last_name) }
  }, [profile.data])

  const saveProfile = useMutation({
    mutationFn: () => updateMyProfile(first.trim(), last.trim()),
  })

  const [password, setPassword] = useState('')
  const savePassword = useMutation({
    mutationFn: async () => {
      if (password.length < 8) throw new Error('Password must be at least 8 characters')
      await updateMyPassword(password)
    },
    onSuccess: () => setPassword(''),
  })

  return (
    <div>
      <PageTitle title="Profile" subtitle="Manage your personal information and preferences." />

      <Card className="mb-6 p-6">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Personal Information</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First Name">
            <Input value={first} onChange={(e) => setFirst(e.target.value)} disabled={profile.isLoading} />
          </Field>
          <Field label="Last Name">
            <Input value={last} onChange={(e) => setLast(e.target.value)} disabled={profile.isLoading} />
          </Field>
        </div>
        <Field label="Email Address" className="mt-4">
          <Input value={user?.email ?? ''} disabled />
        </Field>
        <div className="mt-5 flex items-center justify-end gap-3">
          {profile.isError && <span className="text-sm text-red-600">⚠ {errMsg(profile.error)}</span>}
          {saveProfile.isError && <span className="text-sm text-red-600">⚠ {errMsg(saveProfile.error)}</span>}
          {saveProfile.isSuccess && <span className="text-sm text-green-600">✓ Saved</span>}
          <Button variant="accent" disabled={saveProfile.isPending || profile.isLoading} onClick={() => saveProfile.mutate()}>
            {saveProfile.isPending ? 'Saving…' : 'Save Profile'}
          </Button>
        </div>
      </Card>

      <Card className="p-6">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Change Password</h2>
        <Field label="New Password">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" />
        </Field>
        <div className="mt-5 flex items-center justify-end gap-3">
          {savePassword.isError && <span className="text-sm text-red-600">⚠ {errMsg(savePassword.error)}</span>}
          {savePassword.isSuccess && <span className="text-sm text-green-600">✓ Password updated</span>}
          <Button variant="accent" disabled={savePassword.isPending || !password} onClick={() => savePassword.mutate()}>
            {savePassword.isPending ? 'Updating…' : 'Update Password'}
          </Button>
        </div>
      </Card>
    </div>
  )
}
