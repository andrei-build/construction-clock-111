import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { isManagerRole } from '../lib/types'
import AboutPanel from '../components/AboutPanel'
import PushToggle from '../components/PushToggle'

export default function More() {
  const { profile, logout } = useAuth()
  const { t, lang, setLang } = useI18n()
  const manager = profile ? isManagerRole(profile.role) : false
  const salesAccess = profile ? manager || profile.role === 'sales' : false
  const isOwner = profile?.role === 'owner'

  // NAV-1: «Ещё / More» — три сгруппированные секции (РАБОТА / ФИНАНСЫ / АДМИН).
  // Верхнее меню держим коротким (см. src/components/Nav.tsx); всё остальное — здесь.
  // Экраны /daily, /gallery, /files больше не имеют пункта в меню (живут в хабе проекта),
  // но маршруты в src/App.tsx сохранены (глубокие ссылки продолжают работать).
  return (
    <div className="screen">
      <h1>⚙️ {t('more')}</h1>

      <div className="card">
        <div style={{ fontWeight: 700, fontSize: 18 }}>{profile?.name}</div>
        <span className="badge amber">{profile?.role}</span>
      </div>

      {/* РАБОТА / WORK */}
      <h2>{t('more_group_work')}</h2>
      <div className="more-group">
        {manager && <Link to="/dispatch" className="btn ghost small more-link">{t('dispatch')}</Link>}
        {manager && <Link to="/calendar" className="btn ghost small more-link">{t('calendar')}</Link>}
        {manager && <Link to="/stores" className="btn ghost small more-link">{t('stores')}</Link>}
        {manager && <Link to="/map" className="btn ghost small more-link">{t('map')}</Link>}
        {manager && <Link to="/timeline" className="btn ghost small more-link">{t('timeline')}</Link>}
        <Link to="/messages" className="btn ghost small more-link">{t('messages')}</Link>
      </div>

      {/* ФИНАНСЫ / FINANCE */}
      {salesAccess && (
        <>
          <h2>{t('more_group_finance')}</h2>
          <div className="more-group">
            <Link to="/sales" className="btn ghost small more-link">{t('sales')}</Link>
            {manager && <Link to="/clients" className="btn ghost small more-link">{t('clients')}</Link>}
            {manager && <Link to="/payroll" className="btn ghost small more-link">{t('payroll')}</Link>}
            {manager && <Link to="/documents" className="btn ghost small more-link">{t('documents')}</Link>}
            {manager && <Link to="/reports" className="btn ghost small more-link">{t('reports')}</Link>}
          </div>
        </>
      )}

      {/* АДМИН / ADMIN */}
      {manager && (
        <>
          <h2>{t('more_group_admin')}</h2>
          <div className="more-group">
            <Link to="/settings" className="btn ghost small more-link">{t('settings')}</Link>
            <Link to="/archive" className="btn ghost small more-link">{t('archive')}</Link>
            {/* TODO WF-1: move consents into worker dossier /team/:id. */}
            <Link to="/consents" className="btn ghost small more-link">{t('consents')}</Link>
          </div>
        </>
      )}

      <h2>{t('push_section')}</h2>
      <PushToggle />

      <h2>{t('language')}</h2>
      <div className="tabs">
        {(['ru', 'en', 'es'] as const).map((l) => (
          <button key={l} className={lang === l ? 'active' : ''} onClick={() => setLang(l)}>
            {l === 'ru' ? 'Русский' : l === 'en' ? 'English' : 'Español'}
          </button>
        ))}
      </div>

      <button className="btn red" style={{ marginTop: 24 }} onClick={logout}>{t('logout')}</button>

      {isOwner && <AboutPanel />}

      <p className="muted center" style={{ marginTop: 24 }}>
        Construction Clock v0.1 · Foundation
      </p>
    </div>
  )
}
