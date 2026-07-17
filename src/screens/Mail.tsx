import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import VoiceMic from '../components/VoiceMic'
import {
  addMailAllowlist,
  createCalendarEvent,
  createTask,
  deleteMailAllowlist,
  emitMailUnreadChanged,
  getMailAccounts,
  getMailAllowlist,
  getMailAttachments,
  getMailMessageBodies,
  getMailMessagesPage,
  markMailSeen,
  sendMail,
  triggerMailSync,
} from '../lib/api'
import type { MailAccount, MailAllowlistEntry, MailAttachment, MailListMessage, MailMessageBody } from '../lib/api/mail'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { useLiveRefresh } from '../lib/useLiveRefresh'

// MAIL-2-UI: отправка писем ИЗ приложения (compose/reply) поверх экрана MAIL-1. Модалка «Написать»
// шлёт через edge `mail-send`; строку исходящего вставляет сам edge (direction='out', seen=true),
// поэтому после успеха просто рефетчим ящик. Исходящие письма в списке помечаем «↑ Исходящее»,
// собеседник для них — to_addr; в бейдж непрочитанного они не попадают (только direction='in').

// Состояние модалки компоновки письма (новое письмо или ответ).
interface ComposeState {
  accountKey: string // mail_accounts.key ('buildpro'|'customhomes') — отправитель
  to: string
  subject: string
  body: string
  inReplyTo: string | null // message_id письма, на которое отвечаем (null для нового)
}

// «Re: …» без двойного префикса (учёт уже существующего 'Re:' в любом регистре).
function replySubject(subject: string | null): string {
  const base = (subject ?? '').trim()
  if (/^re:/i.test(base)) return base
  return base ? `Re: ${base}` : 'Re:'
}

// Цитата оригинала для тела ответа: каждая строка с префиксом «> ». MAIL-FIX-1: тело письма теперь
// живёт не в строке списка, а в отдельно догруженной карте тел — принимаем текст явно (fallback на
// snippet, если тело ещё не подтянулось).
function quoteBody(bodyText: string | null, snippet: string | null): string {
  const orig = (bodyText ?? snippet ?? '').trim()
  if (!orig) return ''
  return `\n\n${orig.split('\n').map((l) => `> ${l}`).join('\n')}`
}

// MAIL-1-UI: экран «Почта» (owner/admin). Читает развёрнутый mail-бэкенд через RLS. Чистый фронт:
// список писем по вкладкам двух ящиков, карточка письма (body_text ТЕКСТОМ, без
// dangerouslySetInnerHTML), два действия «в задачу / в событие» из письма (ДНК §13), ручной
// refresh через edge `mail-sync`. Пустой/ошибочный ящик — НЕ баг (секреты могут быть не введены):
// показываем аккуратные пустые/ошибочные состояния. Глобальный «← Назад» уже рендерит App.tsx —
// свой back-кнопки НЕ добавляем; в карточке письма — обычный «Закрыть» (это не навигация).

function senderLabel(m: MailListMessage, unknown: string): string {
  return (m.from_name && m.from_name.trim()) || (m.from_addr && m.from_addr.trim()) || unknown
}

// MAIL-3-UI: дубль в белом списке — Postgres unique_violation (SQLSTATE 23505). Если constraint
// есть, ловим мягко (тост «уже в белом списке»); иначе insert просто пройдёт и мы рефетчим.
function isUniqueViolation(error: unknown): boolean {
  return String((error as { code?: string | null } | null)?.code ?? '') === '23505'
}

// MAIL-4-UI: домен из адреса (часть после последнего '@'); '' если '@' нет.
function domainOf(addr: string): string {
  const at = addr.lastIndexOf('@')
  return at >= 0 ? addr.slice(at + 1).trim() : ''
}

// MAIL-4-UI: клиентский предикат «письмо скрыто». blocks — нормализованные (trim+lower) entry
// block-записей: точный адрес ('john@x.com') ИЛИ домен в форме '@x.com'. Письмо скрыто, если
// from_addr точно равен адресной block-записи ИЛИ заканчивается на '@domain' (регистронезависимо).
function isBlockedAddr(fromAddr: string | null, blocks: string[]): boolean {
  const addr = (fromAddr ?? '').trim().toLowerCase()
  if (!addr) return false
  return blocks.some((b) => (b.startsWith('@') ? addr.endsWith(b) : addr === b))
}

function fmtRowDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function fmtTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function fmtFullDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// MAIL-5-UI: размер вложения человекочитаемо (B/KB/MB). null/некорректный → ''.
function fmtBytes(n: number | null): string {
  if (n === null || !Number.isFinite(n) || n < 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// MAIL-5-UI: ТРЕДЫ. Ключ цепочки письма: thread_key (если есть), иначе одиночная цепочка по id —
// письма без thread_key показываем как тред из одного письма (fallback), не теряем их.
function threadKeyOf(m: MailListMessage): string {
  const k = (m.thread_key ?? '').trim()
  return k || `id:${m.id}`
}

// Дата письма для сортировки внутри треда (sent_at приоритетно, иначе created_at).
function msgTime(m: MailListMessage): number {
  const t = Date.parse(m.sent_at ?? m.created_at ?? '')
  return Number.isNaN(t) ? 0 : t
}

// Цепочка писем (одна строка в списке): messages в порядке от API (свежие сверху), last — самое
// свежее письмо цепочки (для строки списка), unread — есть ли непрочитанное входящее в цепочке.
interface MailThread {
  key: string
  messages: MailListMessage[]
  last: MailListMessage
  unread: boolean
}

// MAIL-5-UI: КОНСЕРВАТИВНЫЙ САНИТАЙЗЕР HTML-тела письма — без npm-зависимостей. Парсим HTML в
// ИНЕРТНЫЙ документ через DOMParser (скрипты НЕ выполняются, ресурсы НЕ грузятся до вставки в DOM),
// затем удаляем опасные узлы/атрибуты и возвращаем очищенный innerHTML для dangerouslySetInnerHTML.
// Вырезаем: <script>/<style>/<iframe>/<object>/<embed> (+ <link>/<meta>/<base>/<form>/<noscript>);
// все on*-атрибуты; javascript:-URL в href/src/action. Картинки по умолчанию НЕ грузим (приватность):
// реальный src уходит в data-src, реальный src подставляется только когда showImages=true (кнопка
// «Показать изображения»). Ссылки открываем безопасно (target=_blank, rel=noopener).
const MAIL_BLOCKED_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'noscript', 'title',
])
// MAIL-FIX-1: URL-атрибуты делим на два класса:
//  • навигационные (ссылки/действия) — чистим по ALLOWLIST схем (всё вне списка вырезаем);
//  • ресурсные (грузят внешний контент) — ГЕЙТИМ за «показать изображения»: до нажатия реальный URL
//    в DOM не попадает (уходит в data-*), после — подставляется провалидированным.
const NAV_URL_ATTRS = new Set(['href', 'action', 'formaction', 'xlink:href'])
const RES_URL_ATTRS = new Set(['src', 'srcset', 'poster', 'background'])
// ALLOWLIST схем. Навигация: пользователь кликает ссылку (открывается в новой вкладке) — http/https/
// mailto/tel безопасны; всё остальное (javascript:, data:, vbscript:, file: …) вырезаем. Ресурсы:
// только http/https (внешние картинки) — data:image разрешаем отдельно (инлайн-картинки писем).
const NAV_SCHEMES = new Set(['http', 'https', 'mailto', 'tel'])
const RES_SCHEMES = new Set(['http', 'https'])

// MAIL-FIX-1: нормализация URL перед проверкой схемы — вырезаем управляющие/невидимые символы
// (\x00-\x20, DEL/C1, zero-width, разделители строк), которыми маскируют схему (напр. «java\x00script:»
// или «java script:» → после чистки «javascript:», ловится allowlist'ом). '' для пустого.
function normalizeUrl(raw: string): string {
  return raw.replace(/[\u0000-\u0020\u007F-\u00A0\u200B-\u200D\u2028\u2029\uFEFF]/g, '').trim()
}

// Схема URL в нижнем регистре ('' если относительный/якорь/без схемы). '//host' (протокол-относительный)
// трактуем как https (браузер догрузит по текущему протоколу).
function urlScheme(normalized: string): string {
  if (normalized.startsWith('//')) return 'https'
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(normalized)
  return m ? m[1].toLowerCase() : ''
}

// Навигационный URL по allowlist. Относительные/якорные (без схемы) пропускаем — внешних ресурсов
// они не грузят. Возвращает нормализованный URL или null (атрибут вырезать).
function safeNavUrl(raw: string): string | null {
  const norm = normalizeUrl(raw)
  if (!norm) return null
  const scheme = urlScheme(norm)
  if (scheme === '') return norm
  return NAV_SCHEMES.has(scheme) ? norm : null
}

// Ресурсный (картиночный) URL по allowlist. data:image разрешён (инлайн-картинки писем); прочие data:
// (например data:text/html) вырезаем. Относительные — пропускаем (внешний ресурс не грузят).
function safeImageUrl(raw: string): string | null {
  const norm = normalizeUrl(raw)
  if (!norm) return null
  const scheme = urlScheme(norm)
  if (scheme === 'data') return /^data:image\//i.test(norm) ? norm : null
  if (scheme === '') return norm
  return RES_SCHEMES.has(scheme) ? norm : null
}

// srcset — список «url дескриптор, url дескриптор». Валидируем каждый URL через safeImageUrl,
// невалидные кандидаты выкидываем. Пусто → ''.
function sanitizeSrcset(value: string): string {
  return value
    .split(',')
    .map((part) => {
      const trimmed = part.trim()
      if (!trimmed) return ''
      const bits = trimmed.split(/\s+/)
      const safe = safeImageUrl(bits[0])
      if (!safe) return ''
      return bits.length > 1 ? `${safe} ${bits.slice(1).join(' ')}` : safe
    })
    .filter(Boolean)
    .join(', ')
}

// Инлайн-style. Опасные конструкции (expression()/js:/vbscript:) → выкинуть весь style (null).
// url(...) — это внешний фон/картинка: ДО «показать изображения» вырезаем ВСЕ url(...) (ни один
// ресурс не грузится), ПОСЛЕ — оставляем только url() с разрешённой схемой. Возвращает очищенный
// style, либо null если весь атрибут надо удалить.
function sanitizeStyle(value: string, showImages: boolean): string | null {
  if (/expression\s*\(|javascript:|vbscript:/i.test(value)) return null
  if (!/url\s*\(/i.test(value)) return value
  if (!showImages) {
    const stripped = value.replace(/url\s*\([^)]*\)/gi, '')
    return stripped.trim() ? stripped : null
  }
  return value.replace(/url\s*\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (_full, _q, u) => {
    const safe = safeImageUrl(String(u))
    return safe ? `url("${safe}")` : ''
  })
}

function sanitizeMailHtml(html: string, showImages: boolean): string {
  if (typeof window === 'undefined' || typeof window.DOMParser === 'undefined') return ''
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return ''
  }
  // Ресурсный URL-атрибут (src/srcset/poster/background): реальный URL до showImages НЕ оставляем в
  // DOM (сохраняем в data-<name>), после — подставляем провалидированный. srcset валидируем поштучно.
  const gateResourceAttr = (el: Element, name: string): void => {
    const raw = el.getAttribute(name) ?? el.getAttribute(`data-${name}`) ?? ''
    el.removeAttribute(name)
    const safe = name === 'srcset' ? sanitizeSrcset(raw) : (raw ? safeImageUrl(raw) : null)
    if (safe) {
      el.setAttribute(`data-${name}`, safe)
      if (showImages) el.setAttribute(name, safe)
    } else {
      el.removeAttribute(`data-${name}`)
    }
  }
  const walk = (node: Element): void => {
    for (const el of Array.from(node.children)) {
      const tag = el.tagName.toLowerCase()
      if (MAIL_BLOCKED_TAGS.has(tag)) {
        el.remove()
        continue
      }
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase()
        if (name.startsWith('on')) {
          el.removeAttribute(attr.name)
          continue
        }
        if (name === 'style') {
          const clean = sanitizeStyle(attr.value, showImages)
          if (clean === null) el.removeAttribute(attr.name)
          else if (clean !== attr.value) el.setAttribute('style', clean)
          continue
        }
        if (NAV_URL_ATTRS.has(name)) {
          const safe = safeNavUrl(attr.value)
          if (!safe) el.removeAttribute(attr.name)
          else if (safe !== attr.value) el.setAttribute(attr.name, safe)
          continue
        }
        if (RES_URL_ATTRS.has(name)) {
          gateResourceAttr(el, name)
          continue
        }
      }
      if (tag === 'img') el.setAttribute('data-mail-img', '1')
      if (tag === 'a') {
        el.setAttribute('target', '_blank')
        el.setAttribute('rel', 'noopener noreferrer nofollow')
      }
      walk(el)
    }
  }
  walk(doc.body)
  return doc.body.innerHTML
}

// Есть ли в HTML-теле картинки (решаем, показывать ли кнопку «Показать изображения»).
function htmlHasImages(html: string | null): boolean {
  return !!html && /<img[\s/>]/i.test(html)
}

// MAIL-FIX-1: размер страницы ленты (писем на «страницу»/«показать ещё»).
const MAIL_PAGE_SIZE = 50

export default function Mail() {
  const { profile } = useAuth()
  const { t, lang } = useI18n()
  const isAdminOrOwner = profile?.role === 'owner' || profile?.role === 'admin'
  // MAIL-3-UI: белый список / «в белый список» — строго owner-only (RLS mail_allowlist owner-only).
  const isOwner = profile?.role === 'owner'

  const [accounts, setAccounts] = useState<MailAccount[]>([])
  // MAIL-FIX-1: лента держит ТОЛЬКО лёгкие строки (без тел) — тела догружаем при открытии треда.
  const [messages, setMessages] = useState<MailListMessage[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  // MAIL-5-UI: открыт ТРЕД (по thread_key/fallback-id), а не одно письмо — раскрываем цепочку целиком.
  const [openKey, setOpenKey] = useState<string | null>(null)
  // Вложения раскрытого треда: message_id → строки mail_attachments (грузим по требованию на раскрытие).
  const [attachmentsByMsg, setAttachmentsByMsg] = useState<Record<string, MailAttachment[]>>({})
  // MAIL-FIX-1: тела писем (body_html/body_text) по id — накапливаем при открытии тредов, переживают
  // silent-рефетч (лента их не хранит). bodyLoadingKey — ключ треда, чьи тела сейчас грузятся.
  const [bodiesById, setBodiesById] = useState<Record<string, MailMessageBody>>({})
  const [bodyLoadingKey, setBodyLoadingKey] = useState<string | null>(null)
  // Письма, для которых пользователь нажал «Показать изображения» (по умолчанию картинки не грузим).
  const [imagesShownIds, setImagesShownIds] = useState<Set<string>>(() => new Set())
  const [compose, setCompose] = useState<ComposeState | null>(null)
  const [sending, setSending] = useState(false)
  // MAIL-3-UI: модал «Белый список» + его список/форма (owner-only).
  const [allowlistOpen, setAllowlistOpen] = useState(false)
  const [allowlist, setAllowlist] = useState<MailAllowlistEntry[]>([])
  const [allowlistLoading, setAllowlistLoading] = useState(false)
  const [alEntry, setAlEntry] = useState('')
  const [alNote, setAlNote] = useState('')
  const [alSaving, setAlSaving] = useState(false)
  // MAIL-4-UI: мини-меню «Скрыть навсегда» — открыто для конкретного письма треда (owner-only).
  const [hideMenuMsgId, setHideMenuMsgId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // MAIL-FIX-1: ошибка загрузки ленты (показываем сообщение + «повторить»); спиннер снимается всегда.
  const [loadError, setLoadError] = useState(false)
  // MAIL-FIX-1: пагинация ленты. Пагинируем на уровне ПИСЕМ по PAGE_SIZE; треды группируются поверх
  // всех загруженных страниц. pageCountRef — сколько страниц сейчас в ленте (для silent-рефетча тем же
  // окном, чтобы «показать ещё» не схлопывалось при фоновом обновлении). hasMore — есть ли ещё страницы.
  const pageCountRef = useRef(1)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number | null>(null)

  const flashToast = useCallback((text: string) => {
    setToast(text)
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => {
      setToast(null)
      toastTimer.current = null
    }, 3200)
  }, [])
  useEffect(() => () => { if (toastTimer.current !== null) window.clearTimeout(toastTimer.current) }, [])

  // LIVE-REFRESH-1: silent=true — фоновый рефетч (60с-поллинг/возврат на вкладку) без спиннера.
  // Обновляет только массивы ящиков/писем/белого списка; активную вкладку сохраняем, открытое
  // письмо/модалку компоновки/белого списка НЕ трогаем (это отдельный локальный стейт).
  const load = useCallback(async (silent = false) => {
    if (!isAdminOrOwner) return
    if (!silent) setLoading(true)
    // MAIL-FIX-1: тянем ПЕРВУЮ пачку писем лёгким select'ом (без тел). На silent-рефетче сохраняем
    // текущее окно (pageCountRef*PAGE_SIZE), чтобы уже раскрытая «показать ещё» не схлопнулась.
    const wanted = Math.max(1, silent ? pageCountRef.current : 1) * MAIL_PAGE_SIZE
    try {
      // MAIL-4-UI: block-список тянем сразу (owner-only) — он нужен клиентскому фильтру ленты, а не
      // только модалу. Не-владельцу RLS отдаст [] (мягко); ему фильтр скрытых и не адресован.
      const [accs, msgs, al] = await Promise.all([
        getMailAccounts(),
        getMailMessagesPage({ offset: 0, limit: wanted }),
        isOwner ? getMailAllowlist() : Promise.resolve([] as MailAllowlistEntry[]),
      ])
      setAccounts(accs)
      setMessages(msgs)
      setAllowlist(al)
      if (!silent) pageCountRef.current = 1
      setHasMore(msgs.length >= wanted) // полное окно ⇒ вероятно есть ещё страницы
      setActiveId((prev) => (prev && accs.some((a) => a.id === prev) ? prev : accs[0]?.id ?? null))
      setLoadError(false)
    } catch {
      // MAIL-FIX-1: ошибка загрузки ленты. На первичной загрузке показываем состояние ошибки с
      // кнопкой «повторить»; на silent-рефетче не рушим уже показанные данные (тихо оставляем как есть).
      if (!silent) setLoadError(true)
    } finally {
      // MAIL-FIX-1: спиннер снимаем ВСЕГДА (в т.ч. после ошибки/при silent) — чтобы не висел вечно.
      setLoading(false)
    }
  }, [isAdminOrOwner, isOwner])

  useEffect(() => { void load() }, [load])

  // MAIL-FIX-1: «показать ещё» — дотягиваем следующую страницу писем и дописываем в ленту (дедуп по id
  // на случай сдвига окна фоновым рефетчем). Старые письма/треды становятся достижимы без потери свежих.
  const loadMore = useCallback(async () => {
    if (loadingMore) return
    setLoadingMore(true)
    try {
      const offset = pageCountRef.current * MAIL_PAGE_SIZE
      const more = await getMailMessagesPage({ offset, limit: MAIL_PAGE_SIZE })
      setMessages((prev) => {
        const seen = new Set(prev.map((x) => x.id))
        return [...prev, ...more.filter((m) => !seen.has(m.id))]
      })
      pageCountRef.current += 1
      setHasMore(more.length >= MAIL_PAGE_SIZE)
    } catch {
      flashToast(t('mail_load_more_failed'))
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, flashToast, t])

  // LIVE-REFRESH-1: дашборд «Почта» — мягкий 60с-поллинг (только пока вкладка видима) + рефетч на
  // возврат/фокус. Почта приходит по mail-sync без realtime-канала, поэтому поллинг здесь основной.
  useLiveRefresh(() => { void load(true).catch(() => {}) }, 60000)
  // MAIL-5-UI: при смене/закрытии открытого треда — закрываем мини-меню «Скрыть навсегда» и
  // сбрасываем «показанные картинки» (следующий тред снова открывается с приватным гейтом картинок).
  useEffect(() => { setHideMenuMsgId(null); setImagesShownIds(new Set()) }, [openKey])

  const activeAccount = useMemo(
    () => accounts.find((a) => a.id === activeId) ?? null,
    [accounts, activeId],
  )
  // MAIL-4-UI: записи белого/чёрного списков делим по kind. allow — секция белого списка (MAIL-3),
  // block — секция «Скрытые» + источник клиентского фильтра ленты. Неизвестный kind считаем allow.
  const allowEntries = useMemo(() => allowlist.filter((a) => a.kind !== 'block'), [allowlist])
  const blockEntries = useMemo(() => allowlist.filter((a) => a.kind === 'block'), [allowlist])
  // Нормализованные block-entry для предиката (trim+lower, пустые отброшены).
  const blockKeys = useMemo(
    () => blockEntries.map((b) => b.entry.trim().toLowerCase()).filter(Boolean),
    [blockEntries],
  )
  const activeMessages = useMemo(
    () =>
      activeId
        ? messages.filter((m) => m.account_id === activeId && !isBlockedAddr(m.from_addr, blockKeys))
        : [],
    [messages, activeId, blockKeys],
  )
  // MAIL-5-UI: группируем письма активного ящика в ТРЕДЫ по threadKeyOf. activeMessages уже
  // отсортированы свежие-сверху (из API), поэтому первый встреченный ключ = самый свежий тред, а
  // messages[0] внутри треда = самое свежее письмо — порядок цепочек в списке сохраняется (по дате
  // последнего письма, свежие сверху), как требует закон Андрея.
  const threads = useMemo<MailThread[]>(() => {
    const map = new Map<string, MailListMessage[]>()
    const order: string[] = []
    for (const m of activeMessages) {
      const k = threadKeyOf(m)
      const bucket = map.get(k)
      if (bucket) bucket.push(m)
      else { map.set(k, [m]); order.push(k) }
    }
    return order.map((k) => {
      const msgs = map.get(k) as MailListMessage[]
      return {
        key: k,
        messages: msgs,
        last: msgs[0],
        unread: msgs.some((m) => m.direction !== 'out' && !m.seen),
      }
    })
  }, [activeMessages])
  // Открытый тред (если его письма не отфильтровались, например после «Скрыть навсегда»). Раскрытие —
  // от старого к новому (asc по дате), как читается переписка.
  const activeThread = useMemo(
    () => (openKey ? threads.find((th) => th.key === openKey) ?? null : null),
    [openKey, threads],
  )
  const activeThreadMessages = useMemo(
    () => (activeThread ? [...activeThread.messages].sort((a, b) => msgTime(a) - msgTime(b)) : []),
    [activeThread],
  )
  const unreadByAccount = useMemo(() => {
    // MAIL-2-UI: непрочитанные считаем ТОЛЬКО по входящим (direction='in') — исходящие письма
    // (seen=true) не должны раздувать бейдж вкладки. Совпадает с фильтром getMailUnreadCount.
    const map = new Map<string, number>()
    for (const m of messages) {
      if (m.direction !== 'out' && !m.seen) map.set(m.account_id, (map.get(m.account_id) ?? 0) + 1)
    }
    return map
  }, [messages])

  if (!isAdminOrOwner) {
    // Дружелюбный отказ (маршрут в App.tsx и так редиректит не-owner/admin) — не падаем.
    return (
      <div className="screen">
        <h1>✉️ {t('mail')}</h1>
        <div className="card muted">{t('mail_owner_only')}</div>
      </div>
    )
  }

  // MAIL-5-UI: раскрыть ТРЕД. Помечаем прочитанными все непрочитанные входящие цепочки (markMailSeen
  // по каждому — существующую логику отметки НЕ трогаем, вызываем её для каждого письма) и подгружаем
  // вложения писем треда одним запросом (только те, у кого has_attachments). Всё best-effort: ошибки
  // markMailSeen откатываем локально, вложения деградируют в [] (RLS/не-владелец → пусто).
  const openThread = async (th: MailThread) => {
    setOpenKey(th.key)
    // MAIL-FIX-1: тела писем треда догружаем отдельным запросом (лента их не держит). Тянем только
    // те id, которых ещё нет в bodiesById (повторное открытие не перезапрашивает). Ставим loading
    // СРАЗУ (до отметки прочитанным), чтобы под телом не мелькал snippet. best-effort: при ошибке
    // getMailMessageBodies отдаёт [] — тело просто не покажется, тред не падает.
    const needBodies = th.messages.map((m) => m.id).filter((id) => !bodiesById[id])
    const loadBodies = needBodies.length > 0
      ? (async () => {
        setBodyLoadingKey(th.key)
        try {
          const bodies = await getMailMessageBodies(needBodies)
          setBodiesById((prev) => {
            const next = { ...prev }
            // Заглушка по каждому запрошенному id (даже если тело не пришло) — чтобы не дёргать запрос
            // повторно и корректно показать «пустое тело» (fallback на snippet).
            for (const id of needBodies) next[id] = next[id] ?? { id, body_text: null, body_html: null }
            for (const b of bodies) next[b.id] = b
            return next
          })
        } finally {
          setBodyLoadingKey((k) => (k === th.key ? null : k))
        }
      })()
      : Promise.resolve()

    const unread = th.messages.filter((m) => m.direction !== 'out' && !m.seen)
    if (unread.length > 0) {
      const ids = new Set(unread.map((m) => m.id))
      setMessages((prev) => prev.map((x) => (ids.has(x.id) ? { ...x, seen: true } : x)))
      try {
        await Promise.all(unread.map((m) => markMailSeen(m.id)))
        emitMailUnreadChanged()
      } catch {
        // best-effort: если update не прошёл (например, RLS), возвращаем как было
        setMessages((prev) => prev.map((x) => (ids.has(x.id) ? { ...x, seen: false } : x)))
      }
    }
    const attIds = th.messages.filter((m) => m.has_attachments).map((m) => m.id)
    if (attIds.length > 0) {
      const atts = await getMailAttachments(attIds)
      setAttachmentsByMsg((prev) => {
        const next = { ...prev }
        for (const id of attIds) next[id] = [] // помеченные has_attachments, но без строк (напр. RLS) → пустой список
        for (const a of atts) (next[a.message_id] ??= []).push(a)
        return next
      })
    }
    await loadBodies
  }

  const doSync = async () => {
    setSyncing(true)
    try {
      const res = await triggerMailSync()
      if (res.error) {
        flashToast(t('mail_sync_failed'))
      } else {
        await load()
        emitMailUnreadChanged()
        if (res.results.length === 0) {
          flashToast(t('mail_sync_done'))
        } else {
          const parts = res.results.map((r) => {
            const box = r.display_name || r.key || r.email || r.account || t('mail')
            if (r.error) return t('mail_sync_box_error').replace('{box}', box)
            const fresh = r.new ?? r.sent ?? r.fetched ?? 0
            return fresh > 0
              ? t('mail_sync_new').replace('{box}', box).replace('{n}', String(fresh))
              : t('mail_sync_none').replace('{box}', box)
          })
          flashToast(parts.join(' · '))
        }
      }
    } catch {
      flashToast(t('mail_sync_failed'))
    } finally {
      setSyncing(false)
    }
  }

  const makeTask = async (m: MailListMessage) => {
    if (!profile) return
    const from = senderLabel(m, t('mail_unknown_sender'))
    const snippet = (m.snippet ?? '').trim()
    const description = `${snippet}${snippet ? '\n\n' : ''}${t('mail_from')}: ${from}`
    try {
      await createTask(profile, {
        project_id: null, // «Общая задача» без проекта
        title: m.subject?.trim() || t('mail_no_subject'),
        task_type: 'work',
        priority: 'medium',
        description,
      })
      flashToast(t('mail_task_created'))
    } catch {
      flashToast(t('mail_action_failed'))
    }
  }

  const makeEvent = async (m: MailListMessage) => {
    if (!profile) return
    const from = senderLabel(m, t('mail_unknown_sender'))
    const snippet = (m.snippet ?? '').trim()
    try {
      // Enum calendar_event_type = meeting|inspection|measure|delivery|other — значения 'note'
      // в схеме НЕТ, поэтому «заметка» = 'other' (иначе insert упадёт), контекст письма в notes.
      // starts_at NOT NULL → ставим «сейчас».
      await createCalendarEvent(profile, {
        title: m.subject?.trim() || t('mail_no_subject'),
        event_type: 'other',
        starts_at: new Date().toISOString(),
        permit_number: null,
        inspection_status: null,
        notes: `${snippet}${snippet ? '\n\n' : ''}${t('mail_from')}: ${from}`,
      })
      flashToast(t('mail_event_created'))
    } catch {
      flashToast(t('mail_action_failed'))
    }
  }

  // Ящик по умолчанию для нового письма — активная вкладка, иначе первый активный аккаунт.
  const defaultComposeKey = (): string =>
    (activeAccount?.active ? activeAccount.key : '') || accounts.find((a) => a.active)?.key || ''

  const openCompose = () => {
    setCompose({ accountKey: defaultComposeKey(), to: '', subject: '', body: '', inReplyTo: null })
  }

  const openReply = (m: MailListMessage) => {
    // Отправитель ответа = ящик самого письма; собеседник = from_addr; тема «Re: …»; цитата в теле.
    // MAIL-FIX-1: тело для цитаты берём из догруженной карты тел (тред уже открыт), fallback на snippet.
    const acct = accounts.find((a) => a.id === m.account_id)
    setCompose({
      accountKey: (acct?.active ? acct.key : '') || defaultComposeKey(),
      to: (m.from_addr ?? '').trim(),
      subject: replySubject(m.subject),
      body: quoteBody(bodiesById[m.id]?.body_text ?? null, m.snippet),
      inReplyTo: m.message_id,
    })
  }

  const canSend = !!compose
    && compose.accountKey.length > 0
    && compose.to.trim().length > 0
    && compose.subject.trim().length > 0
    && compose.body.trim().length > 0
    && !sending

  const doSend = async () => {
    if (!compose || !canSend) return
    setSending(true)
    try {
      const res = await sendMail({
        account_key: compose.accountKey,
        to: compose.to.trim(),
        subject: compose.subject.trim(),
        body: compose.body,
        in_reply_to: compose.inReplyTo,
      })
      if (res.ok) {
        flashToast(t('mail_sent_ok'))
        setCompose(null)
        // Строку исходящего вставил сам edge — просто перечитываем текущий ящик и бейдж.
        await load()
        emitMailUnreadChanged()
      } else {
        flashToast(
          res.error
            ? t('mail_send_failed_reason').replace('{reason}', res.error)
            : t('mail_send_failed'),
        )
      }
    } catch {
      flashToast(t('mail_send_failed'))
    } finally {
      setSending(false)
    }
  }

  // MAIL-3-UI: org_id для INSERT в mail_allowlist (у колонки НЕТ дефолта). Источник — org_id строк
  // mail_accounts, которые владелец уже загрузил: берём активный ящик, иначе первый аккаунт.
  const ownerOrgId = (): string | null => activeAccount?.org_id ?? accounts[0]?.org_id ?? null

  const loadAllowlist = useCallback(async () => {
    setAllowlistLoading(true)
    setAllowlist(await getMailAllowlist())
    setAllowlistLoading(false)
  }, [])

  const openAllowlist = () => {
    setAllowlistOpen(true)
    void loadAllowlist()
  }

  // «В белый список» с открытого письма: entry=from_addr, note=from_name.
  const addSenderToAllowlist = async (m: MailListMessage) => {
    const orgId = ownerOrgId()
    const from = (m.from_addr ?? '').trim()
    if (!orgId || !from) return
    const label = (m.from_name && m.from_name.trim()) || from
    try {
      await addMailAllowlist({ org_id: orgId, entry: from, note: (m.from_name ?? '').trim() || null })
      flashToast(t('mail_allowlist_added').replace('{sender}', label))
      if (allowlistOpen) void loadAllowlist()
    } catch (e) {
      if (isUniqueViolation(e)) flashToast(t('mail_allowlist_exists').replace('{sender}', label))
      else flashToast(t('mail_allowlist_add_failed'))
    }
  }

  // MAIL-4-UI: «Скрыть навсегда» с открытого письма. scope='sender' → entry=from_addr; 'domain' →
  // entry='@'+домен. Вставляем block-запись (kind='block'). НЕ удаляем письмо из mail_messages
  // (у него нет RLS DELETE — тихо не сработает): после insert рефетчим block-список, и клиентский
  // фильтр ленты сам убирает письма отправителя/домена. Открытое письмо закрываем (оно скрыто).
  const hideSender = async (m: MailListMessage, scope: 'sender' | 'domain') => {
    const orgId = ownerOrgId()
    const from = (m.from_addr ?? '').trim()
    if (!orgId || !from) return
    const domain = domainOf(from)
    const entry = scope === 'domain' ? (domain ? `@${domain}` : '') : from
    if (!entry) return
    setHideMenuMsgId(null)
    try {
      await addMailAllowlist({ org_id: orgId, entry, kind: 'block', note: (m.from_name ?? '').trim() || null })
      flashToast(scope === 'domain' ? t('mail_domain_hidden') : t('mail_sender_hidden'))
      await loadAllowlist() // рефетч block-списка → лента перерисуется без этих писем
      setOpenKey(null)
    } catch (e) {
      if (isUniqueViolation(e)) flashToast(t('mail_already_hidden'))
      else flashToast(t('mail_hide_failed'))
    }
  }

  // Форма «Добавить» в модале белого списка: адрес-или-домен + note (опц.).
  const submitAllowlist = async () => {
    const orgId = ownerOrgId()
    const entry = alEntry.trim()
    if (!orgId || !entry || alSaving) return
    setAlSaving(true)
    try {
      await addMailAllowlist({ org_id: orgId, entry, note: alNote.trim() || null })
      setAlEntry('')
      setAlNote('')
      await loadAllowlist()
    } catch (e) {
      if (isUniqueViolation(e)) flashToast(t('mail_allowlist_exists').replace('{sender}', entry))
      else flashToast(t('mail_allowlist_add_failed'))
    } finally {
      setAlSaving(false)
    }
  }

  const removeAllowlist = async (id: string) => {
    const prev = allowlist
    setAllowlist((xs) => xs.filter((x) => x.id !== id)) // оптимистично убираем строку
    try {
      await deleteMailAllowlist(id)
    } catch {
      setAllowlist(prev)
      flashToast(t('mail_allowlist_delete_failed'))
    }
  }

  const syncLabel = (a: MailAccount): string => {
    if (!a.last_sync_at) return t('mail_never_synced')
    return t('mail_last_sync').replace('{time}', fmtTime(a.last_sync_at))
  }

  // MAIL-4-UI: подпись бейджа режима фильтра ящика — читаем из filter_mode (не из work_only).
  const filterModeLabel = (a: MailAccount): string => {
    if (a.filter_mode === 'smart') return t('mail_filter_mode_smart')
    if (a.filter_mode === 'allowlist') return t('mail_filter_mode_allowlist')
    return t('mail_filter_mode_off')
  }

  // MAIL-5-UI: показать реальные картинки в теле письма (по клику «Показать изображения»).
  const showMessageImages = (id: string) =>
    setImagesShownIds((prev) => {
      const next = new Set(prev)
      next.add(id)
      return next
    })

  // MAIL-5-UI/FIX-1: тело письма. Тело живёт в отдельно догруженной карте bodiesById (лента его не
  // держит). Пока тело не пришло: показываем «загрузка тела…» (если грузится) или snippet (fallback).
  // body_html → консервативно санитайзим и рендерим в изолированном контейнере (картинки под приватным
  // гейтом); иначе body_text ПЛОСКИМ ТЕКСТОМ (как MAIL-1).
  const renderMessageBody = (m: MailListMessage) => {
    const body = bodiesById[m.id]
    if (!body) {
      if (bodyLoadingKey === openKey) {
        return <div className="mail-body muted">{t('mail_body_loading')}</div>
      }
      return (
        <div className="mail-body" style={{ whiteSpace: 'pre-wrap' }}>
          {m.snippet ?? ''}
        </div>
      )
    }
    if (body.body_html) {
      const showImages = imagesShownIds.has(m.id)
      const hasImages = htmlHasImages(body.body_html)
      const safe = sanitizeMailHtml(body.body_html, showImages)
      return (
        <>
          {hasImages && !showImages && (
            <div className="mail-img-gate">
              <span className="muted">{t('mail_images_hidden')}</span>
              <button type="button" className="btn ghost small" onClick={() => showMessageImages(m.id)}>
                {t('mail_show_images')}
              </button>
            </div>
          )}
          {/* Санитизированный HTML в изолированном контейнере (.mail-html ограничивает влияние на layout). */}
          <div className="mail-body mail-html" dangerouslySetInnerHTML={{ __html: safe }} />
        </>
      )
    }
    return (
      <div className="mail-body" style={{ whiteSpace: 'pre-wrap' }}>
        {body.body_text ?? m.snippet ?? ''}
      </div>
    )
  }

  // MAIL-5-UI: вложения письма. Контент пока НЕ качаем (r2_key null → «файл появится позже», без
  // ссылки; скачивание/миниатюры — MAIL-6). Для image/* — пометка «фото». Пусто/ещё грузится → null.
  const renderAttachments = (m: MailListMessage) => {
    if (!m.has_attachments) return null
    const atts = attachmentsByMsg[m.id]
    if (!atts || atts.length === 0) return null
    return (
      <div className="mail-attachments">
        <div className="mail-attachments-title muted">{t('mail_attachments')} · {atts.length}</div>
        <ul className="mail-attachment-list">
          {atts.map((a) => {
            const isImg = !!a.mime && a.mime.toLowerCase().startsWith('image/')
            const size = fmtBytes(a.size_bytes)
            return (
              <li key={a.id} className="mail-attachment">
                <span className="mail-att-name">📎 {a.filename}</span>
                {isImg && <span className="badge mail-att-photo">{t('mail_attachment_photo')}</span>}
                {size && <span className="mail-att-size muted">{size}</span>}
                {!a.r2_key && <span className="mail-att-later muted">{t('mail_attachment_later')}</span>}
              </li>
            )
          })}
        </ul>
      </div>
    )
  }

  // MAIL-5-UI: одно письмо внутри раскрытого треда — шапка (кто/адрес/дата), тело, вложения и
  // действия (Ответить / → Задача / → Событие / В белый список / Скрыть навсегда). Действия per-письмо
  // работают ровно как в MAIL-1..4, только теперь по конкретному письму цепочки.
  const renderThreadMessage = (m: MailListMessage) => {
    const isOut = m.direction === 'out'
    const who = isOut
      ? ((m.to_addr && m.to_addr.trim()) || t('mail_unknown_recipient'))
      : senderLabel(m, t('mail_unknown_sender'))
    const addr = isOut ? (m.to_addr ?? '').trim() : (m.from_addr ?? '').trim()
    const hasFromAddr = !!(m.from_addr && m.from_addr.trim())
    return (
      <div key={m.id} className={`mail-msg${isOut ? ' outgoing' : ''}`}>
        <div className="mail-msg-head">
          <div className="mail-msg-who">
            {isOut && <span className="mail-out-tag">↑ {t('mail_outgoing')}</span>}
            <span className="mail-msg-name">{who}</span>
            {addr && <span className="muted mail-msg-addr"> · {addr}</span>}
          </div>
          <span className="muted mail-msg-date">{fmtFullDate(m.sent_at ?? m.created_at)}</span>
        </div>

        {renderMessageBody(m)}
        {renderAttachments(m)}

        <div className="mail-actions row" style={{ gap: 8, marginTop: 12 }}>
          <button type="button" className="btn small" onClick={() => openReply(m)}>
            {t('mail_reply')}
          </button>
          <button type="button" className="btn small" onClick={() => makeTask(m)}>
            {t('mail_to_task')}
          </button>
          <button type="button" className="btn small" onClick={() => makeEvent(m)}>
            {t('mail_to_event')}
          </button>
          {isOwner && (
            <button
              type="button"
              className="btn small"
              onClick={() => { void addSenderToAllowlist(m) }}
              disabled={!hasFromAddr}
            >
              {t('mail_add_to_allowlist')}
            </button>
          )}
          {isOwner && (
            <div className="mail-hide-wrap">
              <button
                type="button"
                className="btn small"
                onClick={() => setHideMenuMsgId((cur) => (cur === m.id ? null : m.id))}
                disabled={!hasFromAddr}
                aria-expanded={hideMenuMsgId === m.id}
              >
                {t('mail_hide_forever')}
              </button>
              {hideMenuMsgId === m.id && (
                <div className="mail-hide-menu" role="menu">
                  <button
                    type="button"
                    className="btn ghost small"
                    role="menuitem"
                    onClick={() => { void hideSender(m, 'sender') }}
                  >
                    {t('mail_hide_sender')}
                  </button>
                  <button
                    type="button"
                    className="btn ghost small"
                    role="menuitem"
                    onClick={() => { void hideSender(m, 'domain') }}
                    disabled={!domainOf((m.from_addr ?? '').trim())}
                  >
                    {t('mail_hide_domain')}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="screen mail-screen">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>✉️ {t('mail')}</h1>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          {isOwner && (
            <button type="button" className="btn ghost small" onClick={openAllowlist}>
              {t('mail_allowlist_open')}
            </button>
          )}
          <button type="button" className="btn small" onClick={openCompose} disabled={loading || accounts.length === 0}>
            {t('mail_compose')}
          </button>
          <button type="button" className="btn ghost small" onClick={doSync} disabled={syncing}>
            {syncing ? t('mail_refreshing') : t('mail_refresh')}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="spinner">{t('mail_loading')}</div>
      ) : loadError ? (
        // MAIL-FIX-1: ошибка загрузки ленты — сообщение + «повторить» (спиннер не висит вечно).
        <div className="card muted mail-error" role="alert">
          <div>{t('mail_load_error')}</div>
          <button type="button" className="btn small" style={{ marginTop: 8 }} onClick={() => { void load() }}>
            {t('mail_retry')}
          </button>
        </div>
      ) : accounts.length === 0 ? (
        <div className="card muted">{t('mail_no_accounts')}</div>
      ) : (
        <>
          <div className="mail-tabs" role="tablist">
            {accounts.map((a) => {
              const unread = unreadByAccount.get(a.id) ?? 0
              return (
                <button
                  key={a.id}
                  type="button"
                  role="tab"
                  aria-selected={a.id === activeId}
                  className={`mail-tab${a.id === activeId ? ' active' : ''}`}
                  onClick={() => { setActiveId(a.id); setOpenKey(null) }}
                >
                  {a.display_name}
                  {unread > 0 && <span className="badge red mail-tab-badge">{unread > 99 ? '99+' : unread}</span>}
                </button>
              )
            })}
          </div>

          {activeAccount && (
            <div className="mail-meta muted">
              {syncLabel(activeAccount)}
              {/* MAIL-4-UI: единый бейдж режима фильтра из filter_mode (smart/allowlist/off) —
                  заменяет прежний work_only-бейдж, чтобы не показывать ложный «фильтр включён». */}
              <span className={`badge mail-filter-badge mode-${activeAccount.filter_mode}`}>
                {activeAccount.filter_mode !== 'off' && '🔒 '}
                {filterModeLabel(activeAccount)}
              </span>
            </div>
          )}

          {activeAccount?.last_error && (
            <div className="mail-banner error-msg" role="alert">
              {t('mail_box_not_connected')}: {activeAccount.last_error}
            </div>
          )}

          {activeThread ? (
            <div className="card mail-detail">
              {/* MAIL-5-UI: раскрытый ТРЕД — шапка (тема + счётчик писем + «Закрыть»), затем письма
                  цепочки от старого к новому (каждое со своим телом, вложениями и действиями). */}
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div>
                  <div className="mail-detail-subject">{activeThread.last.subject?.trim() || t('mail_no_subject')}</div>
                  {activeThread.messages.length > 1 && (
                    <div className="muted mail-detail-count">
                      {t('mail_thread_count').replace('{n}', String(activeThread.messages.length))}
                    </div>
                  )}
                </div>
                <button type="button" className="btn ghost small" onClick={() => setOpenKey(null)}>
                  {t('mail_close')}
                </button>
              </div>

              <div className="mail-thread">
                {activeThreadMessages.map((m) => renderThreadMessage(m))}
              </div>
            </div>
          ) : threads.length === 0 ? (
            <div className="card muted mail-empty">{t('mail_empty')}</div>
          ) : (
            <>
            <div className="mail-list">
              {threads.map((th) => {
                // MAIL-5-UI: одна строка = ЦЕПОЧКА. Показываем последнее письмо (th.last) + счётчик
                // «N писем», если писем больше одного. Исходящее последнее письмо → собеседник это
                // to_addr и метка «↑ Исходящее»; unread — есть ли непрочитанное входящее в цепочке.
                const m = th.last
                const isOut = m.direction === 'out'
                const counterparty = isOut
                  ? ((m.to_addr && m.to_addr.trim()) || t('mail_unknown_recipient'))
                  : senderLabel(m, t('mail_unknown_sender'))
                const count = th.messages.length
                return (
                  <button
                    key={th.key}
                    type="button"
                    className={`mail-row${th.unread ? ' unread' : ''}${isOut ? ' outgoing' : ''}`}
                    onClick={() => { void openThread(th) }}
                  >
                    <div className="mail-row-top">
                      <span className="mail-row-sender">
                        {isOut && <span className="mail-out-tag">↑ {t('mail_outgoing')}</span>}
                        {counterparty}
                        {count > 1 && (
                          <span className="badge mail-thread-count">{t('mail_thread_count').replace('{n}', String(count))}</span>
                        )}
                      </span>
                      <span className="mail-row-date muted">{fmtRowDate(m.sent_at ?? m.created_at)}</span>
                    </div>
                    <div className="mail-row-subject">{m.subject?.trim() || t('mail_no_subject')}</div>
                    {m.snippet && <div className="mail-row-snippet muted">{m.snippet}</div>}
                  </button>
                )
              })}
            </div>
            {/* MAIL-FIX-1: пагинация — «показать ещё» дотягивает следующую страницу писем (старые
                треды/письма достижимы, не пропадают после ~1000). Кнопка видна, пока в БД есть ещё. */}
            {hasMore && (
              <div className="mail-load-more">
                <button type="button" className="btn ghost small" onClick={() => { void loadMore() }} disabled={loadingMore}>
                  {loadingMore ? t('mail_loading_more') : t('mail_load_more')}
                </button>
              </div>
            )}
            </>
          )}
        </>
      )}

      {compose && (
        <div
          className="confirm-backdrop"
          onClick={() => { if (!sending) setCompose(null) }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="mail-compose-title"
        >
          <div className="card confirm-modal mail-compose" onClick={(e) => e.stopPropagation()}>
            <div className="item-title" id="mail-compose-title">{t('mail_compose_title')}</div>

            <label>{t('mail_from_box')}</label>
            <select
              value={compose.accountKey}
              onChange={(e) => setCompose((c) => (c ? { ...c, accountKey: e.target.value } : c))}
              disabled={sending}
            >
              {accounts.filter((a) => a.active).map((a) => (
                <option key={a.id} value={a.key}>
                  {a.display_name}{a.email ? ` · ${a.email}` : ''}
                </option>
              ))}
            </select>

            <label>{t('mail_to')}</label>
            <input
              type="email"
              value={compose.to}
              onChange={(e) => setCompose((c) => (c ? { ...c, to: e.target.value } : c))}
              disabled={sending}
            />

            <div className="message-body-label">
              <label>{t('mail_subject')}</label>
              <VoiceMic
                lang={lang}
                title={t('voice_input')}
                onResult={(text) => setCompose((c) => (c ? { ...c, subject: c.subject ? `${c.subject} ${text}` : text } : c))}
              />
            </div>
            <input
              type="text"
              value={compose.subject}
              onChange={(e) => setCompose((c) => (c ? { ...c, subject: e.target.value } : c))}
              disabled={sending}
            />

            <div className="message-body-label">
              <label>{t('mail_text')}</label>
              <VoiceMic
                lang={lang}
                title={t('voice_input')}
                onResult={(text) => setCompose((c) => (c ? { ...c, body: c.body ? `${c.body} ${text}` : text } : c))}
              />
            </div>
            <textarea
              value={compose.body}
              onChange={(e) => setCompose((c) => (c ? { ...c, body: e.target.value } : c))}
              rows={7}
              disabled={sending}
            />

            <div className="row" style={{ gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
              <button type="button" className="btn ghost small" onClick={() => setCompose(null)} disabled={sending}>
                {t('mail_cancel')}
              </button>
              <button type="button" className="btn" onClick={doSend} disabled={!canSend}>
                {sending ? t('mail_sending') : t('mail_send')}
              </button>
            </div>
          </div>
        </div>
      )}

      {allowlistOpen && isOwner && (
        <div
          className="confirm-backdrop"
          onClick={() => { if (!alSaving) setAllowlistOpen(false) }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="mail-allowlist-title"
        >
          <div className="card confirm-modal mail-allowlist" onClick={(e) => e.stopPropagation()}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="item-title" id="mail-allowlist-title">{t('mail_allowlist_title')}</div>
              <button type="button" className="btn ghost small" onClick={() => setAllowlistOpen(false)} disabled={alSaving}>
                {t('mail_close')}
              </button>
            </div>

            <div className="mail-allowlist-form">
              <input
                type="text"
                value={alEntry}
                placeholder={t('mail_allowlist_entry')}
                onChange={(e) => setAlEntry(e.target.value)}
                disabled={alSaving}
              />
              <input
                type="text"
                value={alNote}
                placeholder={t('mail_allowlist_note')}
                onChange={(e) => setAlNote(e.target.value)}
                disabled={alSaving}
              />
              <button
                type="button"
                className="btn small"
                onClick={() => { void submitAllowlist() }}
                disabled={alSaving || alEntry.trim().length === 0}
              >
                {alSaving ? t('mail_allowlist_adding') : t('mail_allowlist_add')}
              </button>
            </div>

            {allowlistLoading ? (
              <div className="spinner">{t('mail_allowlist_loading')}</div>
            ) : (
              <>
                {/* Секция белого списка (kind='allow'). */}
                {allowEntries.length === 0 ? (
                  <div className="card muted">{t('mail_allowlist_empty')}</div>
                ) : (
                  <ul className="mail-allowlist-list">
                    {allowEntries.map((a) => (
                      <li key={a.id} className="mail-allowlist-item">
                        <span className="mail-allowlist-entry">{a.entry}</span>
                        {a.note && <span className="mail-allowlist-note muted">{a.note}</span>}
                        <button
                          type="button"
                          className="btn ghost small mail-allowlist-del"
                          onClick={() => { void removeAllowlist(a.id) }}
                        >
                          {t('mail_allowlist_delete')}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                {/* MAIL-4-UI: секция «Скрытые» (kind='block'). Удаление block-записи → отправитель
                    снова виден в ленте (removeAllowlist рефетчит state, лента перерисуется). */}
                <div className="mail-hidden-section">
                  <div className="item-title mail-hidden-title">{t('mail_hidden_section')}</div>
                  {blockEntries.length === 0 ? (
                    <div className="card muted">{t('mail_hidden_empty')}</div>
                  ) : (
                    <ul className="mail-allowlist-list">
                      {blockEntries.map((a) => (
                        <li key={a.id} className="mail-allowlist-item">
                          <span className="mail-allowlist-entry">{a.entry}</span>
                          {a.note && <span className="mail-allowlist-note muted">{a.note}</span>}
                          <button
                            type="button"
                            className="btn ghost small mail-allowlist-del"
                            onClick={() => { void removeAllowlist(a.id) }}
                          >
                            {t('mail_allowlist_delete')}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}

            <div className="muted mail-allowlist-hint">{t('mail_allowlist_hint')}</div>
          </div>
        </div>
      )}

      {toast && (
        <div className="travel-toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </div>
  )
}
