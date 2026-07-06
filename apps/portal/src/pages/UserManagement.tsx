import { useState } from 'react'
import { Shield, Users } from 'lucide-react'
import { Tabs } from '../components/ui'
import { UsersTab } from './um/UsersTab'
import { RolesTab } from './um/RolesTab'

type Tab = 'users' | 'roles'

export function UserManagementPage() {
  const [tab, setTab] = useState<Tab>('users')

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <Tabs<Tab>
        className="mb-8 w-fit"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'users', label: <span className="flex items-center gap-2 px-4"><Users size={15} /> Users</span> },
          { key: 'roles', label: <span className="flex items-center gap-2 px-4"><Shield size={15} /> Roles</span> },
        ]}
      />
      {tab === 'users' ? <UsersTab /> : <RolesTab />}
    </div>
  )
}
