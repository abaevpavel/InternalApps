import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type ReactNode } from 'react'
import { AuthProvider } from '../auth/AuthProvider'
import { AppRoleProvider } from './AppRoleContext'

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
})

export function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      {/* AppRoleProvider — над Layout: апка публикует свой вид снизу (usePublishAppRole),
          оболочка читает его сверху для фильтрации меню. */}
      <AuthProvider>
        <AppRoleProvider>{children}</AppRoleProvider>
      </AuthProvider>
    </QueryClientProvider>
  )
}
