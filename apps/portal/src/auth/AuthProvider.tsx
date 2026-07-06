import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import { checkAdmin, getMyProfile } from '../services/data'
import { roleIsAdmin, type Profile } from '../domain/types'

/**
 * Auth портала: Google OAuth (Supabase) + whitelist-гейт.
 * Залогиниться Google-аккаунтом может кто угодно, но доступ получает только тот,
 * у кого есть строка в `profiles` (её создаёт Lovable-триггер по приглашению).
 * Нет профиля → состояние `denied`.
 */
interface AuthCtx {
  authUser: { id: string; email: string } | null
  profile: Profile | null
  loading: boolean
  denied: boolean
  isAdmin: boolean
  signInWithGoogle: () => Promise<void>
  signOut: () => Promise<void>
  refreshProfile: () => Promise<void>
}

const Ctx = createContext<AuthCtx | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authUser, setAuthUser] = useState<{ id: string; email: string } | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [denied, setDenied] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!supabase) {
      setLoading(false)
      return
    }
    supabase.auth.getSession().then(async ({ data }) => {
      if (data.session?.user) await onSession(data.session.user.id, data.session.user.email ?? '')
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (session?.user) onSession(session.user.id, session.user.email ?? '')
      else reset()
    })
    return () => sub.subscription.unsubscribe()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function reset() {
    setAuthUser(null)
    setProfile(null)
    setIsAdmin(false)
    setDenied(false)
  }

  async function onSession(id: string, email: string) {
    setAuthUser({ id, email })
    await loadProfile(id, email)
  }

  async function loadProfile(id: string, email: string) {
    try {
      const p = await getMyProfile(id, email)
      setProfile(p)
      setDenied(!p)
      if (p) {
        // Основной путь — серверный RPC; фолбэк — детект по ролям профиля.
        const admin = (await checkAdmin(p.user_id ?? id)) || p.roles.some(roleIsAdmin)
        setIsAdmin(admin)
      } else {
        setIsAdmin(false)
      }
    } catch {
      setProfile(null)
      setDenied(true)
      setIsAdmin(false)
    }
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
    reset()
  }

  async function refreshProfile() {
    if (authUser) await loadProfile(authUser.id, authUser.email)
  }

  return (
    <Ctx.Provider value={{ authUser, profile, loading, denied, isAdmin, signInWithGoogle, signOut, refreshProfile }}>
      {children}
    </Ctx.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
