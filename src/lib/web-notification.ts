// MSG-1: тонкая обёртка над Web Notification API. Разрешение спрашиваем ВЕЖЛИВО и один раз —
// не всплывающим окном на загрузке, а на первом жесте пользователя (pointerdown/keydown), как и
// разблокировка звука в notification-sound.ts. Всё деградирует в тихий no-op, если API нет
// (SSR, старые браузеры) или разрешение не выдано.

let permissionArmed = false

// Установить одноразовые слушатели жеста, которые запросят разрешение на уведомления при первом
// взаимодействии. Безопасно вызывать многократно (guard) и вне браузера (no-op).
export function armNotificationPermission(): void {
  if (permissionArmed) return
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return
  permissionArmed = true
  // Уже решено (granted/denied) — спрашивать нечего.
  if (Notification.permission !== 'default') return
  const ask = () => {
    try {
      void Notification.requestPermission()
    } catch {
      // Старый колбэк-стиль/ошибка — не критично, просто без уведомлений.
    }
    window.removeEventListener('pointerdown', ask)
    window.removeEventListener('keydown', ask)
  }
  window.addEventListener('pointerdown', ask, { once: true })
  window.addEventListener('keydown', ask, { once: true })
}

// Показать уведомление, только если разрешение выдано. Никогда не бросает наружу.
export function showNotification(title: string, body: string): void {
  if (typeof Notification === 'undefined') return
  if (Notification.permission !== 'granted') return
  try {
    new Notification(title, { body })
  } catch {
    // Best-effort: сбой уведомления не должен всплывать в UI.
  }
}
