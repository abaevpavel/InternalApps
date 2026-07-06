import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { ShieldX } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { Button, Card } from '../components/ui'
import { errMsg } from '../lib/utils'

export function LoginPage() {
  const { authUser, profile, denied, loading, signInWithGoogle, signOut } = useAuth()
  const [error, setError] = useState<string | null>(null)

  if (loading) return <div className="p-10 text-gray-500">Loading…</div>
  if (authUser && profile && !denied) return <Navigate to="/" replace />

  async function google() {
    setError(null)
    try {
      await signInWithGoogle()
    } catch (e) {
      setError(errMsg(e))
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-center justify-center bg-brand-dark px-6 py-4">
        <img src="/logo.png" alt="Basement Remodeling" className="h-10 w-auto" />
      </header>

      <main className="flex flex-1 items-center justify-center p-6">
        <Card className="w-full max-w-md p-8 text-center">
          {denied ? (
            <>
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-50 text-red-500">
                <ShieldX size={26} />
              </div>
              <h1 className="text-xl font-bold text-gray-900">Access denied</h1>
              <p className="mt-2 text-sm text-gray-500">
                <span className="font-medium">{authUser?.email}</span> is not authorized to use this
                portal. Ask an administrator to add your email in User Management.
              </p>
              <Button variant="outline" className="mt-6 w-full" onClick={signOut}>
                Try another account
              </Button>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-bold text-gray-900">My Applications</h1>
              <p className="mt-2 text-sm text-gray-500">
                Sign in with your company Google account to access your workplace applications.
              </p>
              <Button variant="primary" className="mt-6 w-full py-2.5" onClick={google}>
                <GoogleIcon />
                Sign in with Google
              </Button>
              {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
            </>
          )}
        </Card>
      </main>
    </div>
  )
}

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
      <path fill="#4285F4" d="M23.5 12.3c0-.9-.1-1.5-.3-2.2H12v4.1h6.5c-.1 1.1-.8 2.7-2.4 3.8l-.02.15 3.5 2.7.24.03c2.2-2.1 3.5-5.1 3.5-8.6z" />
      <path fill="#34A853" d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.8-2.9c-1 .7-2.4 1.2-4.1 1.2-3.2 0-5.8-2.1-6.8-5l-.14.01-3.7 2.8-.05.13C3.3 21.3 7.3 24 12 24z" />
      <path fill="#FBBC05" d="M5.2 14.4c-.2-.7-.4-1.5-.4-2.4s.1-1.6.4-2.4l-.01-.16-3.7-2.9-.12.06C.5 8.2 0 10 0 12s.5 3.8 1.3 5.4l3.9-3z" />
      <path fill="#EB4335" d="M12 4.6c2.3 0 3.8 1 4.7 1.8l3.4-3.3C18 1.2 15.2 0 12 0 7.3 0 3.3 2.7 1.3 6.6l3.9 3c1-2.9 3.6-5 6.8-5z" />
    </svg>
  )
}
