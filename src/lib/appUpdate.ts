// PWA-UPDATE-1 — тихое автообновление ВЕРСИИ приложения (Закон Андрея 17.07 «свежесть»).
// Конвейер выкатывает по несколько сборок в день, а вкладка/установленная PWA держит СТАРЫЙ
// JS-бандл до ручной перезагрузки. Этот модуль — чистая ПОСТРАНИЧНАЯ логика детекта (SW не
// переписываем): сравниваем главный хешированный бандл, с которым загрузилась текущая вкладка,
// со свежим index.html с сервера. Отличается → вышла новая сборка.
//
// Почему именно так (без опоры на 'waiting' service worker): рукописный public/sw.js на install
// сразу делает skipWaiting(), поэтому состояние 'waiting' может вообще не появиться — детект на
// уровне страницы надёжнее. update() у регистрации всё равно дёргаем, чтобы SW подтянул новый
// app-shell в фоне.

// Vite хеширует имя входного бандла: /assets/index-<hash>.js. Ни один хеш не хардкодим —
// вытаскиваем регуляркой и из живого документа, и из свежего html.
const ENTRY_RE = /\/assets\/index-[A-Za-z0-9_-]+\.js/

// Имя входного бандла, с которым РЕАЛЬНО загрузилась текущая вкладка — читаем из документа один
// раз на старте. В dev вход — /src/main.tsx (нет /assets/index-*.js), поэтому вернётся null и весь
// детект становится no-op: сравнивать не с чем, а HMR в dev и так подхватывает изменения.
export function readCurrentBundle(): string | null {
  if (typeof document === 'undefined') return null
  const scripts = Array.from(document.querySelectorAll('script[type="module"][src]'))
  for (const s of scripts) {
    const src = (s as HTMLScriptElement).getAttribute('src') || ''
    const m = src.match(ENTRY_RE)
    if (m) return m[0]
  }
  return null
}

// Тянем свежий index.html (мимо HTTP-кеша, no-store) и достаём из него имя входного бандла.
// Любая сетевая/парсинг-ошибка → null, и вызывающий трактует «неизвестно» как «обновления нет»
// (в частности офлайн: fetch упадёт → детект молчит, ничего не перезагружаем без связи).
//
// Про service worker: no-store управляет HTTP-кешем, а не SW. Рукописный sw.js отдаёт index.html
// по stale-while-revalidate, поэтому ПЕРВОЕ чтение после деплоя может вернуть ещё старый html, но
// тем же запросом фоном обновляет кеш — СЛЕДУЮЩЕЕ чтение уже свежее. Отсюда лаг максимум в один
// цикл проверки; focus/visibility-триггеры делают циклы частыми. Когда SW нет (e2e его блокирует,
// либо ещё не контролирует страницу) — no-store бьёт прямо в сеть и отдаёт свежий html сразу.
export async function fetchLatestBundle(): Promise<string | null> {
  try {
    const res = await fetch('/index.html', { cache: 'no-store' })
    if (!res.ok) return null
    const html = await res.text()
    const m = html.match(ENTRY_RE)
    return m ? m[0] : null
  } catch {
    return null
  }
}

// Best-effort: просим service worker перепроверить /sw.js, чтобы он подтянул новый app-shell.
// Никогда не бросает — источник истины по версии всё равно постраничный диф бандла.
export async function pingServiceWorkerUpdate(): Promise<void> {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    const reg = await navigator.serviceWorker.getRegistration()
    await reg?.update()
  } catch {
    // SW-обновление — приятный бонус, а не обязательное условие; молча игнорируем.
  }
}

// true, когда пользователь в процессе ввода: сфокусировано текстовое поле / contenteditable, либо
// идёт IME-композиция (`composing` пробрасывает компонент, слушая compositionstart/end). Мы НИКОГДА
// не выдёргиваем страницу из-под нажатия клавиши — при вводе показываем ненавязчивый тост.
export function isUserTyping(composing: boolean): boolean {
  if (composing) return true
  if (typeof document === 'undefined') return false
  const el = document.activeElement as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true
  if (el.isContentEditable) return true
  return false
}
