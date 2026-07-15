import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { useI18n } from '../lib/i18n'

// ACC-1: минимальная длина нового пароля (совпадает с валидацией на login/reset).
export const MIN_PASSWORD_LENGTH = 8

// Общая форма «новый пароль + повтор». Используется и в «Мой аккаунт» (a),
// и на экране /reset (b): один и тот же вызов supabase.auth.updateUser({ password }).
export default function ChangePasswordForm({ onSuccess }: { onSuccess?: () => void }) {
  const { t } = useI18n()
  const [pw, setPw] = useState('')
  const [repeat, setRepeat] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null) // уже переведённый / сырой текст Supabase
  const [done, setDone] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setDone(false)
    if (!pw) { setError(t('pw_empty')); return }
    if (pw.length < MIN_PASSWORD_LENGTH) { setError(t('pw_too_short')); return }
    if (pw !== repeat) { setError(t('pw_mismatch')); return }
    setBusy(true)
    const { error: err } = await supabase.auth.updateUser({ password: pw })
    setBusy(false)
    if (err) {
      // Показываем сообщение Supabase как есть; на всякий случай — дружелюбный фолбэк.
      setError(err.message || t('pw_change_failed'))
      return
    }
    setPw('')
    setRepeat('')
    setDone(true)
    onSuccess?.()
  }

  return (
    <form onSubmit={submit}>
      <label>{t('new_password')}</label>
      <input
        type="password"
        value={pw}
        disabled={busy}
        autoComplete="new-password"
        onChange={(e) => { setPw(e.target.value); setError(null); setDone(false) }}
      />
      <label>{t('repeat_password')}</label>
      <input
        type="password"
        value={repeat}
        disabled={busy}
        autoComplete="new-password"
        onChange={(e) => { setRepeat(e.target.value); setError(null); setDone(false) }}
      />
      <button className="btn" disabled={busy || !pw || !repeat}>{t('change_password')}</button>
      {error && <p className="error-msg">{error}</p>}
      {done && <p className="ok-msg">{t('pw_changed')}</p>}
    </form>
  )
}
