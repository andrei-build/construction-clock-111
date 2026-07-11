import { useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'

const ORG_SLUG = 'nwbuild' // одна организация — слаг фиксирован; мультиорг добавится позже

export default function Login() {
  const { loginEmail, loginPin } = useAuth()
  const { t } = useI18n()
  const [tab, setTab] = useState<'worker' | 'office'>('worker')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [pin, setPin] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submitEmail = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setErr(null)
    const r = await loginEmail(email.trim(), password)
    if (r) setErr(r)
    setBusy(false)
  }

  const pressKey = async (k: string) => {
    if (busy) return
    setErr(null)
    if (k === '⌫') { setPin((p) => p.slice(0, -1)); return }
    if (pin.length >= 8) return
    const next = pin + k
    setPin(next)
    if (next.length >= 4) {
      // автопопытка от 4 цифр — как в боевом Check Time
      setBusy(true)
      const r = await loginPin(ORG_SLUG, next)
      if (r === 'wrong_login' && next.length < 8) { setBusy(false); return } // может, PIN длиннее — ждём цифры
      if (r) { setErr(r); setPin('') }
      setBusy(false)
    }
  }

  return (
    <div className="screen" style={{ paddingTop: 40 }}>
      <h1 className="center">🏗️ {t('appName')}</h1>
      <div className="tabs">
        <button className={tab === 'worker' ? 'active' : ''} onClick={() => setTab('worker')}>{t('login_worker')}</button>
        <button className={tab === 'office' ? 'active' : ''} onClick={() => setTab('office')}>{t('login_office')}</button>
      </div>

      {tab === 'worker' && (
        <div>
          <p className="center muted">{t('enter_pin')}</p>
          <div className="pin-display">
            {[0, 1, 2, 3, 4, 5].slice(0, Math.max(4, pin.length)).map((i) => (
              <span key={i} className={`pin-dot ${i < pin.length ? 'filled' : ''}`} />
            ))}
          </div>
          <div className="keypad">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((k, i) =>
              k === '' ? <span key={i} /> : <button key={i} onClick={() => pressKey(k)}>{k}</button>,
            )}
          </div>
        </div>
      )}

      {tab === 'office' && (
        <form onSubmit={submitEmail}>
          <label>{t('email')}</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          <label>{t('password')}</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          <button className="btn" disabled={busy || !email || !password}>{t('signin')}</button>
        </form>
      )}

      {err && <p className="error-msg">{t(err)}</p>}
      {busy && <p className="center muted">…</p>}
    </div>
  )
}
