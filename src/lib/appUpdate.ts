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

import { getPendingOutboxCount } from './offlineOutbox'

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

// PWA-INPUT: типы <input>, чьё непустое значение считаем несохранённым черновиком. Чекбоксы,
// радио, кнопки, файлы, скрытые/служебные поля намеренно исключены — их «значение» либо не
// теряется при reload, либо не является вводом пользователя.
const DRAFT_INPUT_TYPES = new Set(['text', 'search', 'email', 'tel', 'url', 'password', 'number', 'date', 'datetime-local', 'time', 'month', 'week'])

// PWA-INPUT: есть ли на экране непустое текстовое поле / textarea, даже РАСфокусированное. Тихий
// reload затёр бы такой черновик (заметка, имя, сумма, набранная позиция накладной), поэтому его
// наличие — повод отложить обновление и лишь предложить тост.
function hasNonEmptyTextField(): boolean {
  const fields = document.querySelectorAll('input, textarea')
  for (const node of Array.from(fields)) {
    const el = node as HTMLInputElement | HTMLTextAreaElement
    if (el.disabled || el.readOnly) continue
    if (el.tagName === 'INPUT' && !DRAFT_INPUT_TYPES.has((el as HTMLInputElement).type)) continue
    if (el.value.trim().length > 0) return true
  }
  return false
}

// PWA-INPUT: расширенный сторож несохранённого ввода для тихого автообновления. Тихий reload
// допустим лишь когда экран действительно «пуст». Откладываем обновление (показываем тост), если:
//   • пользователь печатает / идёт IME-композиция (isUserTyping);
//   • открыта модалка/диалог (aria-modal|role=dialog) — человек в середине задачи;
//   • на канвасе нарисована подпись (ТБ/доставка) — canvas помечает себя data-signed при первом
//     штрихе; reload стёр бы неотправленную подпись;
//   • есть непустое (даже расфокусированное) текстовое поле/textarea — черновик заметки/суммы/позиции.
// Чистая happy-path (пустой экран) по-прежнему обновляется тихо.
export function hasUnsavedInput(composing: boolean): boolean {
  if (isUserTyping(composing)) return true
  if (typeof document === 'undefined') return false
  if (document.querySelector('[aria-modal="true"], [role="dialog"]')) return true
  if (document.querySelector('canvas[data-signed="true"]')) return true
  if (hasNonEmptyTextField()) return true
  return false
}

// NAV-STATE-1 — применяем обновление ВЕРСИИ на переходах между экранами, а НЕ по фокусу/visibility
// вкладки. Возврат в приложение (из соседней вкладки браузера, после просмотра файла) больше не
// дёргает reload посреди работы и не «скидывает» экран на Обзор. Свежую сборку помечаем ожидающей и
// применяем тихо на следующей смене экрана (когда это безопасно) — либо пользователь жмёт тост.

// Имя бандла текущей вкладки — читаем один раз и мемоизируем (readCurrentBundle детерминирован).
let currentBundle: string | null | undefined
function getCurrentBundle(): string | null {
  if (currentBundle === undefined) currentBundle = readCurrentBundle()
  return currentBundle
}

// Обнаружена ли новая сборка (ждёт применения). Модульный флаг общий для тоста и навигации.
let pendingUpdate = false
export function isUpdatePending(): boolean { return pendingUpdate }

// Последняя проверка свежести — лёгкий троттлинг, чтобы частая навигация не била по сети.
let lastCheckAt = 0
const CHECK_THROTTLE_MS = 15 * 1000

// Проверка «вышла ли новая сборка». Помечает pendingUpdate и возвращает true, когда обновление есть.
// В dev (бандл не распознан) — всегда false. Сетевые ошибки трактуются как «обновления нет».
export async function checkForUpdate(force = false): Promise<boolean> {
  if (pendingUpdate) return true
  const cur = getCurrentBundle()
  if (!cur) return false
  const now = Date.now()
  if (!force && now - lastCheckAt < CHECK_THROTTLE_MS) return false
  lastCheckAt = now
  // Заодно (best-effort) просим SW обновить app-shell.
  void pingServiceWorkerUpdate()
  const latest = await fetchLatestBundle()
  if (latest && latest !== cur) { pendingUpdate = true; return true }
  return false
}

// Применить накопившееся обновление, если это безопасно (нет несохранённого ввода/подписи/модалки И
// офлайн-очередь пуста). Иначе — ничего не делаем (останется ненавязчивый тост). Возвращает true,
// если reload инициирован.
export async function applyPendingUpdateIfSafe(): Promise<boolean> {
  if (!pendingUpdate) return false
  if (hasUnsavedInput(false)) return false
  let pending = 0
  try {
    pending = await getPendingOutboxCount()
  } catch {
    // Очереди нечитаемы (нет IndexedDB и т.п.) — считаем пустыми.
    pending = 0
  }
  if (pending > 0) return false
  window.location.reload()
  return true
}

// Хук навигации: на КАЖДОЙ смене экрана обнаруживаем свежую сборку и, если безопасно, применяем её.
// Именно так (а не по visibilitychange/focus) обновление доходит до пользователя без потери контекста.
export async function checkAndApplyUpdateOnNavigate(): Promise<void> {
  await checkForUpdate()
  await applyPendingUpdateIfSafe()
}
