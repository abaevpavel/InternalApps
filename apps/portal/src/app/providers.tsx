import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type ReactNode } from 'react'
import { AuthProvider } from '../auth/AuthProvider'
import { AppRoleProvider } from './AppRoleContext'
import { AppHeaderNoteProvider } from './AppHeaderNote'
import { UnsavedChangesProvider } from './UnsavedChangesContext'
import { PendingActionsProvider } from './PendingActions'

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
})

export function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      {/* AppRoleProvider — над Layout: апка публикует свой вид снизу (usePublishAppRole),
          оболочка читает его сверху для фильтрации меню. */}
      <AuthProvider>
        <AppRoleProvider>
          <AppHeaderNoteProvider>
            <UnsavedChangesProvider>
              {/* Подтверждение + 10 с на отмену для записей Receipts Matcher и GMB. */}
              <PendingActionsProvider>{children}</PendingActionsProvider>
            </UnsavedChangesProvider>
          </AppHeaderNoteProvider>
        </AppRoleProvider>
      </AuthProvider>
    </QueryClientProvider>
  )
}
