import { useEffect, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { disablePush, enablePush, getExistingSubscription, isPushSupported } from '../lib/push'

// Device-level web-push toggle, shown to every logged-in role in «More». Reflects the current
// permission + subscription state and enables/disables push via push.ts. Graceful no-op on
// browsers without push support (e.g. iOS Safari in a tab → shows the install hint).
export default function PushToggle() {
  const { profile } = useAuth()
  const { t } = useI18n()
  const [supported] = useState(isPushSupported)
  const [permission, setPermission] = useState<NotificationPermission>(
    () => (supported ? Notification.permission : 'default'),
  )
  const [subscribed, setSubscribed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    let alive = true
    if (!supported) {
      setReady(true)
      return
    }
    getExistingSubscription()
      .then((sub) => {
        if (!alive) return
        setSubscribed(Boolean(sub) && Notification.permission === 'granted')
        setPermission(Notification.permission)
      })
      .finally(() => {
        if (alive) setReady(true)
      })
    return () => {
      alive = false
    }
  }, [supported])

  const toggle = async () => {
    if (!profile || busy) return
    setBusy(true)
    setError(false)
    try {
      if (subscribed) {
        await disablePush(profile)
        setSubscribed(false)
      } else {
        await enablePush(profile)
        setSubscribed(true)
      }
      setPermission(Notification.permission)
    } catch {
      // Permission denied or a network/DB error — surface a generic hint; the denied-state
      // banner below covers the explicit "blocked in browser" case.
      setPermission(supported ? Notification.permission : 'default')
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  const denied = supported && permission === 'denied'

  return (
    <div className="card">
      <div style={{ fontWeight: 600 }}>{t('push_device_toggle')}</div>
      <p className="muted" style={{ marginTop: 4 }}>{t('push_device_hint')}</p>

      {!supported ? (
        <p className="muted" style={{ marginTop: 8 }}>{t('push_unsupported_hint')}</p>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
            <span className={`badge ${subscribed ? 'green' : 'amber'}`}>
              {subscribed ? t('push_state_on') : t('push_state_off')}
            </span>
            <button
              className={subscribed ? 'btn ghost small' : 'btn small'}
              onClick={toggle}
              disabled={busy || denied || !ready}
            >
              {busy ? t('push_working') : subscribed ? t('push_disable') : t('push_enable')}
            </button>
          </div>
          {denied && <p className="warn-msg" style={{ marginTop: 8 }}>{t('push_denied_hint')}</p>}
          {error && !denied && <p className="error-msg" style={{ marginTop: 8 }}>{t('push_toggle_failed')}</p>}
        </>
      )}
    </div>
  )
}
