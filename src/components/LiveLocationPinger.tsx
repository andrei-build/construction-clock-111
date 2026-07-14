import { useEffect, useRef } from 'react'
import type { Profile } from '../lib/types'
import { captureGPS, getActiveLocationConsent, getTodayEvents, insertLiveLocation } from '../lib/api'
import { shiftState } from '../lib/time'

// GEO-1: пинг live-локации из открытой смены. Гейт — ОБА условия одновременно:
//   (1) активное GPS-согласие (worker_location_consents.revoked_at IS NULL), и
//   (2) открытая смена (shiftState(события дня) !== 'off').
// Пингуем не чаще, чем раз в 90с (в окне 60–120с из контракта). Каждый тик заново
// проверяет ОБА условия — согласие отозвано или смена закрыта → тик просто ничего не шлёт.
// Интервал снимается на размонтировании / смене профиля; best-effort — любые ошибки глотаем.
const PING_INTERVAL_MS = 90_000

export default function LiveLocationPinger({ profile }: { profile: Profile }) {
  const inFlight = useRef(false)

  useEffect(() => {
    // Пинг только для ролей в поле — worker/driver. Остальным эффект — no-op.
    if (profile.role !== 'worker' && profile.role !== 'driver') return
    let cancelled = false

    async function tick() {
      if (cancelled || inFlight.current) return
      // Оффлайн — пропускаем тик (ретенция ленты только на сервере, догонять нечего).
      if (typeof navigator !== 'undefined' && !navigator.onLine) return
      inFlight.current = true
      try {
        // Гейт: активное согласие И открытая смена — иначе выходим, ничего не пишем.
        const [consent, events] = await Promise.all([
          getActiveLocationConsent(profile.id),
          getTodayEvents(profile.id),
        ])
        if (cancelled || !consent) return
        if (shiftState(events).status === 'off') return
        const geo = await captureGPS()
        if (cancelled || geo.status !== 'good' || geo.lat === null || geo.lng === null) return
        await insertLiveLocation(profile, geo.lat, geo.lng, geo.accuracy)
      } catch {
        // best-effort телеметрия — никогда не мешаем работе приложения
      } finally {
        inFlight.current = false
      }
    }

    tick()
    const timer = window.setInterval(tick, PING_INTERVAL_MS)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [profile.id, profile.role])

  return null
}
