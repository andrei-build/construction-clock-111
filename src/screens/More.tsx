import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'

export default function More() {
  const { profile, logout } = useAuth()
  const { t, lang, setLang } = useI18n()

  return (
    <div className="screen">
      <h1>⚙️ {t('more')}</h1>

      <div className="card">
        <div style={{ fontWeight: 700, fontSize: 18 }}>{profile?.name}</div>
        <span className="badge amber">{profile?.role}</span>
      </div>

      <h2>{t('communication')}</h2>
      <Link to="/messages" className="btn ghost small more-link">{t('messages')}</Link>

      <h2>{t('language')}</h2>
      <div className="tabs">
        {(['ru', 'en', 'es'] as const).map((l) => (
          <button key={l} className={lang === l ? 'active' : ''} onClick={() => setLang(l)}>
            {l === 'ru' ? 'Русский' : l === 'en' ? 'English' : 'Español'}
          </button>
        ))}
      </div>

      <button className="btn red" style={{ marginTop: 24 }} onClick={logout}>{t('logout')}</button>

      <p className="muted center" style={{ marginTop: 24 }}>
        Construction Clock v0.1 · Foundation
      </p>
    </div>
  )
}
