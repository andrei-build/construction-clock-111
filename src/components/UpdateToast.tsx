import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../lib/i18n'
import { getPendingOutboxCount } from '../lib/offlineOutbox'
import { readCurrentBundle, fetchLatestBundle, pingServiceWorkerUpdate, isUserTyping } from '../lib/appUpdate'

// PWA-UPDATE-1 — сторож свежести версии. Проверяет выход новой сборки на интервале (~5 мин) и при
// возврате фокуса/видимости вкладки (работает и в установленной PWA через visibilitychange/focus).
// Если новая версия найдена И это безопасно (пользователь не вводит текст И офлайн-очереди пусты) —
// тихо перезагружаемся (свежий index.html подтянет новые бандлы). Иначе показываем ненавязчивый
// тост «Вышло обновление — Обновить», который можно проигнорировать.
const CHECK_INTERVAL_MS = 5 * 60 * 1000

export default function UpdateToast() {
  const { t } = useI18n()
  const [show, setShow] = useState(false)
  // Идёт ли IME-композиция прямо сейчас — держим в ref, чтобы не пересобирать эффект.
  const composingRef = useRef(false)
  // Входной бандл, с которым загрузилась ЭТА вкладка. Читаем один раз; в dev — null (детект инертен).
  const currentBundleRef = useRef<string | null>(null)

  useEffect(() => {
    currentBundleRef.current = readCurrentBundle()
    let alive = true
    let reloading = false

    const doReload = () => {
      if (reloading) return
      reloading = true
      // Навигация проходит network-first через SW → свежий index.html и новые хешированные бандлы.
      window.location.reload()
    }

    const check = async () => {
      if (!alive || reloading) return
      const current = currentBundleRef.current
      if (!current) return // dev / бандл не распознан — сравнивать не с чем
      // Заодно (best-effort) просим SW обновить app-shell.
      void pingServiceWorkerUpdate()
      const latest = await fetchLatestBundle()
      if (!alive || reloading) return
      if (!latest || latest === current) return
      // Вышла новая сборка. Тихий reload ТОЛЬКО когда безопасно: не идёт ввод И очередь офлайн пуста.
      let pending = 0
      try {
        pending = await getPendingOutboxCount()
      } catch {
        // Очереди нечитаемы (нет IndexedDB и т.п.) — считаем пустыми, но это не мешает показу тоста.
        pending = 0
      }
      if (!alive || reloading) return
      if (!isUserTyping(composingRef.current) && pending === 0) {
        doReload()
      } else {
        // Вводит или есть неотправленные офлайн-записи — не трогаем, предлагаем обновиться вручную.
        setShow(true)
      }
    }

    const onVisible = () => { if (document.visibilityState === 'visible') void check() }
    const onFocus = () => void check()
    const onCompStart = () => { composingRef.current = true }
    const onCompEnd = () => { composingRef.current = false }

    const interval = setInterval(() => { void check() }, CHECK_INTERVAL_MS)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onFocus)
    document.addEventListener('compositionstart', onCompStart)
    document.addEventListener('compositionend', onCompEnd)
    // Первичная проверка на старте — вкладка могла простоять открытой через несколько деплоев.
    void check()

    return () => {
      alive = false
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('compositionstart', onCompStart)
      document.removeEventListener('compositionend', onCompEnd)
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
