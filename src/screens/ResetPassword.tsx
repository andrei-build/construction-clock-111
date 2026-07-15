import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useI18n } from '../lib/i18n'
import ChangePasswordForm from '../components/ChangePasswordForm'

// ACC-1 (b): экран восстановления пароля. Пользователь приходит по ссылке из письма
// (resetPasswordForEmail(redirectTo=<origin>/reset)). Supabase поднимает recovery-сессию —
// либо синхронно уже есть session, либо приходит событие 'PASSWORD_RECOVERY'.
export default function ResetPassword() {
  const { t } = useI18n()
  // null = проверяем, true/false = есть ли пригодная сессия для смены пароля
  const [hasSession, setHasSession] = useState<boolean | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    let mounted = true
    supabase.auth.getSession().then(({ data }) => {
      if (mounted && data.session) setHasSession(true)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (!mounted) return
      if (event === 'PASSWORD_RECOVERY' || session) setHasSession(true)
    })
    // Небольшая отсрочка: если по хэшу так и не появилось сессии — считаем ссылку негодной.
    const timer = setTimeout(() => { if (mounted) setHasSession((s) => (s === null ? false : s)) }, 1500)
    return () => { mounted = false; sub.subscription.unsubscribe(); clearTimeout(timer) }
  }, [])

  return (
    <div className="screen" style={{ paddingTop: 40 }}>
      <h1 className="center">🔑 {t('reset_password_title')}</h1>

      {hasSession === null && <p className="center muted">…</p>}

      {hasSession === false && !done && (
        <div className="card">
          <p className="error-msg">{t('reset_no_session')}</p>
          <Link to="/" className="btn ghost">{t('back_to_login')}</Link>
        </div>
      )}

      {hasSession === true && !done && (
        <div className="card">
          <p className="muted">{t('reset_password_intro')}</p>
          <ChangePasswordForm onSuccess={() => setDone(true)} />
        </div>
      )}

      {done && (
        <div className="card">
          <p className="ok-msg">{t('reset_success')}</p>
          <Link to="/" className="btn">{t('back_to_login')}</Link>
        </div>
      )}
    </div>
  )
}
