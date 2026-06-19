import { useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { Button, Card, Input, Field, PageTitle } from '../components/ui'

export function ProfilePage() {
  const { user } = useAuth()
  const [first, setFirst] = useState(user?.firstName ?? '')
  const [last, setLast] = useState(user?.lastName ?? '')

  return (
    <div>
      <PageTitle title="Profile" subtitle="Manage your personal information and preferences." />
      <Card className="mb-6 p-6">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Personal Information</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First Name" required>
            <Input value={first} onChange={(e) => setFirst(e.target.value)} />
          </Field>
          <Field label="Last Name" required>
            <Input value={last} onChange={(e) => setLast(e.target.value)} />
          </Field>
        </div>
        <Field label="Email Address" className="mt-4">
          <Input value={user?.email ?? ''} disabled />
        </Field>
        <div className="mt-5 flex justify-end">
          <Button variant="accent">Save Profile</Button>
        </div>
      </Card>

      <Card className="p-6">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Change Password</h2>
        <Field label="New Password" required>
          <Input type="password" placeholder="Enter new password" />
        </Field>
        <div className="mt-5 flex justify-end">
          <Button variant="accent">Update Password</Button>
        </div>
      </Card>
    </div>
  )
}
