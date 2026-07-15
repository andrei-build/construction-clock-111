import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { supabase, SUPABASE_URL, SUPABASE_KEY } from './supabase'
import { clearAllSnapshots } from './offlineFieldCache'
import { clearAllFieldActions } from './offlineFieldActions'
import { clearAllMediaUploads } from './offlineMediaQueue'
import { clearReadCache, clearOfflineCacheState, setFinanceCacheAllowed } from './offlineReadCache'
import { setClientErrorContext } from './clientErrors'
import { hasFinanceAccess } from './types'
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
  // A2: профиль + активные гибкие права (user_capabilities). finance_access выдаётся только
  // owner/admin (см. WorkerDetail), но действовать он должен везде — поэтому грузим здесь и кладём
  // на профиль как capabilities[], чтобы гейты (hasFinanceAccess) читали его из контекста авторизации.
  const [profileRes, capsRes] = await Promise.all([
    supabase.from('profiles')
      .select('id, org_id, name, role, language, is_active, project_access_mode, require_checkout_video, notif_mode')
      .eq('id', user.id).maybeSingle(),
    supabase.from('user_capabilities')
      .select('capability, granted')
      .eq('user_id', user.id)
      .eq('granted', true),
  ])
  const profile = (profileRes.data as Profile | null) ?? null
  if (!profile) return null
  const caps = (capsRes.data as { capability: string; granted: boolean }[] | null) ?? []
  return { ...profile, capabilities: caps.map((row) => row.capability) }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [profile, setProfile] = useState<Profile | null>(null)

  const refresh = async () => {
    const p = await fetchProfile()
    // OFFLINE-1: finance reads may only be cached for roles that pass hasFinanceAccess.
    setFinanceCacheAllowed(hasFinanceAccess(p))
    // A8: telemetry inserts need the authed org/profile (RLS ce_insert); clears to null when p is null.
    setClientErrorContext(p)
    setProfile(p)
  }

  useEffect(() => {
    refresh().finally(() => setLoading(false))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      // Session lost (token expiry / sign-out elsewhere): drop the finance gate too.
      if (!session) { setFinanceCacheAllowed(false); setClientErrorContext(null); setProfile(null) }
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

  const logout = async () => { clearAllSnapshots(); clearAllFieldActions(); void clearAllMediaUploads(); void clearReadCache(); clearOfflineCacheState(); setFinanceCacheAllowed(false); setClientErrorContext(null); await supabase.auth.signOut(); setProfile(null) }

  return <Ctx.Provider value={{ loading, profile, refresh, loginEmail, loginPin, logout }}>{children}</Ctx.Provider>
}

export const useAuth = () => useContext(Ctx)
