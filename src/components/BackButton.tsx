import { useLocation, useNavigate } from 'react-router-dom'
import { useI18n } from '../lib/i18n'
import { IconArrowLeft } from './icons'

// Root screens = the per-role bottom-nav LANDING tabs only (see src/components/Nav.tsx).
// UI-NAV-2: root is narrow by design — just the home + top-level tab destinations. Every screen
// reached BELOW a tab (detail screens, /documents, /clients, /reports, /payroll, /calendar, /map,
// /trash, project/worker hubs, settings, …) is a sub-screen and gets the «← Назад» control.
// The set is the union of all four role tab bars so no role's home tab ever shows a back button.
const ROOT_PATHS = new Set([
  '/',          // home (Dashboard / CheckIn / Sales / Route by role)
  '/overview',  // manager tab «Обзор»
  '/dispatch',  // manager tab «Командный центр»
  '/projects',  // manager tab «Проекты»
  '/team',      // manager tab «Команда»
  '/more',      // «Ещё» (every role)
  '/route',     // driver tab «Маршрут»
  '/tasks',     // driver/worker tab «Задачи»
  '/messages',  // driver/sales tab «Сообщения»
  '/time',      // driver/worker tab «Мои часы»
  '/sales',     // sales tab «Продажи»
  '/checkin',   // worker tab «Отметка»
])

export default function BackButton() {
  const location = useLocation()
  const navigate = useNavigate()
  const { t } = useI18n()

  const path = location.pathname.replace(/\/+$/, '') || '/'
  if (ROOT_PATHS.has(path)) return null

  const goBack = () => {
    // react-router tracks position with history.state.idx; idx === 0 means we
    // landed here directly (deep link / external), so fall back to the root.
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0
    if (idx > 0) navigate(-1)
    else navigate('/')
  }

  return (
    <div className="app-back-bar">
      <button type="button" className="app-back-btn" onClick={goBack} aria-label={t('back')}>
        <IconArrowLeft />
        <span>{t('back')}</span>
      </button>
    </div>
  )
}
