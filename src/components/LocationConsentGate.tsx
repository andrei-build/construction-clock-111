import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { Profile } from '../lib/types'
import { getActiveLocationConsent } from '../lib/api'
import GpsConsent from '../screens/GpsConsent'

// Работник/водитель не попадает в приложение, пока не подпишет активное GPS-согласие (закон WA)
export default function LocationConsentGate({ profile, children }: { profile: Profile; children: ReactNode }) {
  const needsConsent = profile.role === 'worker' || profile.role === 'driver'
  const [checked, setChecked] = useState(false)
  const [hasConsent, setHasConsent] = useState(false)

  const check = useCallback(async () => {
    if (!needsConsent) {
      setHasConsent(true)
      setChecked(true)
      return
    }
    try {
      const active = await getActiveLocationConsent(profile.id)
      setHasConsent(Boolean(active))
    } catch {
      // На ошибке (в т.ч. offline) не пускаем без согласия — это юридическое требование
      setHasConsent(false)
    } finally {
      setChecked(true)
    }
  }, [needsConsent, profile.id])

  useEffect(() => { check() }, [check])

  if (!checked) return <div className="spinner">…</div>
  if (!hasConsent) return <GpsConsent onSigned={() => setHasConsent(true)} />
  return <>{children}</>
}
