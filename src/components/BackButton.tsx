import { useLocation, useNavigate } from 'react-router-dom'
import { useI18n } from '../lib/i18n'
import { IconArrowLeft } from './icons'

// Root screens = every top-level nav destination (bottom tabs + desktop sidebar).
// Any route not in this set is a sub-screen and gets the back control.
const ROOT_PATHS = new Set([
  '/',
  '/checkin',
  '/timeline',
  '/messages',
  '/projects',
  '/daily',
  '/team',
  '/consents',
  '/dispatch',
  '/calendar',
  '/map',
  '/gallery',
  '/files',
  '/time',
  '/payroll',
  '/documents',
  '/reports',
  '/clients',
  '/sales',
  '/more',
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
