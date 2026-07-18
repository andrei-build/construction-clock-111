import { useEffect, useState } from 'react'
import { useI18n } from '../lib/i18n'
import { checkForUpdate } from '../lib/appUpdate'

// PWA-UPDATE-1 / NAV-STATE-1 — сторож свежести версии. Проверяет выход новой сборки на интервале
// (~5 мин) и один раз на старте. НОВОЕ: обновление больше НЕ применяется по фокусу/visibility вкладки
// (это «скидывало» экран посреди работы при возврате в приложение). Здесь мы только ОБНАРУЖИВАЕМ
// свежую сборку и показываем ненавязчивый тост; тихое применение происходит на переходах между
// экранами (см. App.tsx → checkAndApplyUpdateOnNavigate). Тост же позволяет обновиться вручную сразу.
const CHECK_INTERVAL_MS = 5 * 60 * 1000

export default function UpdateToast() {
  const { t } = useI18n()
  const [show, setShow] = useState(false)

  useEffect(() => {
    let alive = true

    const check = async () => {
      if (!alive) return
      const found = await checkForUpdate(true)
      if (alive && found) setShow(true)
    }

    const interval = setInterval(() => { void check() }, CHECK_INTERVAL_MS)
    // Первичная проверка на старте — вкладка могла простоять открытой через несколько деплоев.
    void check()

    return () => {
      alive = false
      clearInterval(interval)
    }
  }, [])

  if (!show) return null

  return (
    <div className="update-toast" role="status" aria-live="polite">
      <span className="update-toast-text">{t('update_available')}</span>
      <button type="button" className="update-toast-btn" onClick={() => window.location.reload()}>
        {t('update_reload')}
      </button>
    </div>
  )
}
