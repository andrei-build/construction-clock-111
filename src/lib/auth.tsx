import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { supabase, SUPABASE_URL, SUPABASE_KEY } from './supabase'
import type { Profile } from './types'

interface AuthState {
  loading: boolean
  profile: Profile | null
  refresh: () => Promise<void>
  loginEmail: (email: string, password: string) => Promise<string | null>
  loginPin: (orgSlug: string, pin: string) => Promise<string | null>
  logout: () => Promise<void>
}

const Ctx = createContext<AuthState>(null as unknown as AuthState)

async function fetchProfile(): Promise<Profile | null> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data } = await supabase.from('profiles')
    .select('id, org_id, name, role, language, is_active, project_access_mode, require_checkout_video')
    .eq('id', user.id).maybeSingle()
  return (data as Profile | null) ?? null
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [profile, setProfile] = useState<Profile | null>(null)

  const refresh = async () => setProfile(await fetchProfile())

  useEffect(() => {
    refresh().finally(() => setLoading(false))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (!session) setProfile(null)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  const loginEmail = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) return 'wrong_login'
    await refresh()
    return null
  }

  const loginPin = async (orgSlug: string, pin: string) => {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/pin-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY },
        body: JSON.stringify({ org_slug: orgSlug, pin }),
      })
      const body = await res.json()
      if (res.status === 429) return 'locked'
      if (!res.ok) return 'wrong_login'
      const { error } = await supabase.auth.setSession(body.session)
      if (error) return 'wrong_login'
      await refresh()
      return null
    } catch {
      return 'error'
    }
  }

  const logout = async () => { await supabase.auth.signOut(); setProfile(null) }

  return <Ctx.Provider value={{ loading, profile, refresh, loginEmail, loginPin, logout }}>{children}</Ctx.Provider>
}

export const useAuth = () => useContext(Ctx)
