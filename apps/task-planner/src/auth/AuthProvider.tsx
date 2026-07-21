import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import { consumeSsoHandoff } from '../lib/sso'
import type { AppRole } from '../domain/types'

interface AuthUser {
  id: string
  email: string
  role: AppRole
  firstName?: string
  lastName?: string
}

interface AuthCtx {
  user: AuthUser | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<void>
  signInWithGoogle: () => Promise<void>
  signOut: () => Promise<void>
}

const Ctx = createContext<AuthCtx | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!supabase) {
      setLoading(false)
      return
    }
    // Сначала — SSO-хэндофф из портала (#sso=…): он должен успеть положить сессию
    // до getSession(), иначе пользователь увидит экран логина.
    consumeSsoHandoff().then(async () => {
      const { data } = await supabase!.auth.getSession()
      if (data.session?.user) await loadUser(data.session.user.id, data.session.user.email ?? '')
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (session?.user) loadUser(session.user.id, session.user.email ?? '')
      else setUser(null)
    })
    return () => sub.subscription.unsubscribe()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadUser(id: string, email: string) {
    let role: AppRole = 'pm'
    if (supabase) {
      const { data } = await supabase.from('tp_user_roles').select('role').eq('user_id', id).maybeSingle()
      if (data?.role) role = data.role as AppRole
    }
    setUser({ id, email, role })
  }

  async function signIn(email: string, password: string) {
    if (!supabase) throw new Error('Supabase is not configured')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
  }

  async function signInWithGoogle() {
    if (!supabase) throw new Error('Supabase is not configured')
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    })
    if (error) throw error
  }

  async function signOut() {
    if (supabase) await supabase.auth.signOut()
    setUser(null)
  }

  return (
    <Ctx.Provider value={{ user, loading, signIn, signInWithGoogle, signOut }}>{children}</Ctx.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
