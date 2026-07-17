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
  getMailMessages,
  markMailSeen,
  sendMail,
  triggerMailSync,
} from '../lib/api'
import type { MailAccount, MailAllowlistEntry, MailMessage } from '../lib/api/mail'
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

// Цитата оригинала для тела ответа: каждая строка с префиксом «> ».
function quoteBody(m: MailMessage): string {
  const orig = (m.body_text ?? m.snippet ?? '').trim()
  if (!orig) return ''
  return `\n\n${orig.split('\n').map((l) => `> ${l}`).join('\n')}`
}

// MAIL-1-UI: экран «Почта» (owner/admin). Читает развёрнутый mail-бэкенд через RLS. Чистый фронт:
// список писем по вкладкам двух ящиков, карточка письма (body_text ТЕКСТОМ, без
// dangerouslySetInnerHTML), два действия «в задачу / в событие» из письма (ДНК §13), ручной
// refresh через edge `mail-sync`. Пустой/ошибочный ящик — НЕ баг (секреты могут быть не введены):
// показываем аккуратные пустые/ошибочные состояния. Глобальный «← Назад» уже рендерит App.tsx —
// свой back-кнопки НЕ добавляем; в карточке письма — обычный «Закрыть» (это не навигация).

function senderLabel(m: MailMessage, unknown: string): string {
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

export default function Mail() {
  const { profile } = useAuth()
  const { t, lang } = useI18n()
  const isAdminOrOwner = profile?.role === 'owner' || profile?.role === 'admin'
  // MAIL-3-UI: белый список / «в белый список» — строго owner-only (RLS mail_allowlist owner-only).
  const isOwner = profile?.role === 'owner'

  const [accounts, setAccounts] = useState<MailAccount[]>([])
  const [messages, setMessages] = useState<MailMessage[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [openMsg, setOpenMsg] = useState<MailMessage | null>(null)
  const [compose, setCompose] = useState<ComposeState | null>(null)
  const [sending, setSending] = useState(false)
  // MAIL-3-UI: модал «Белый список» + его список/форма (owner-only).
  const [allowlistOpen, setAllowlistOpen] = useState(false)
  const [allowlist, setAllowlist] = useState<MailAllowlistEntry[]>([])
  const [allowlistLoading, setAllowlistLoading] = useState(false)
  const [alEntry, setAlEntry] = useState('')
  const [alNote, setAlNote] = useState('')
  const [alSaving, setAlSaving] = useState(false)
  // MAIL-4-UI: мини-меню «Скрыть навсегда» на открытом письме (owner-only).
  const [hideMenuOpen, setHideMenuOpen] = useState(false)
  const [loading, setLoading] = useState(true)
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
    // MAIL-4-UI: block-список тянем сразу (owner-only) — он нужен клиентскому фильтру ленты, а не
    // только модалу. Не-владельцу RLS отдаст [] (мягко); ему фильтр скрытых и не адресован.
    const [accs, msgs, al] = await Promise.all([
      getMailAccounts(),
      getMailMessages(),
      isOwner ? getMailAllowlist() : Promise.resolve([] as MailAllowlistEntry[]),
    ])
    setAccounts(accs)
    setMessages(msgs)
    setAllowlist(al)
    setActiveId((prev) => (prev && accs.some((a) => a.id === prev) ? prev : accs[0]?.id ?? null))
    if (!silent) setLoading(false)
  }, [isAdminOrOwner, isOwner])

  useEffect(() => { void load() }, [load])

  // LIVE-REFRESH-1: дашборд «Почта» — мягкий 60с-поллинг (только пока вкладка видима) + рефетч на
  // возврат/фокус. Почта приходит по mail-sync без realtime-канала, поэтому поллинг здесь основной.
  useLiveRefresh(() => { void load(true).catch(() => {}) }, 60000)
  // MAIL-4-UI: закрываем мини-меню «Скрыть навсегда» при смене/закрытии открытого письма.
  useEffect(() => { setHideMenuOpen(false) }, [openMsg])

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

  const openMessage = async (m: MailMessage) => {
    setOpenMsg(m)
    if (!m.seen) {
      // Оптимистично помечаем прочитанным локально + пересчитываем бейдж навигации.
      setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, seen: true } : x)))
      try {
        await markMailSeen(m.id)
        emitMailUnreadChanged()
      } catch {
        // best-effort: если update не прошёл (например, RLS), возвращаем как было
        setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, seen: false } : x)))
      }
    }
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

  const makeTask = async (m: MailMessage) => {
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

  const makeEvent = async (m: MailMessage) => {
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

  const openReply = (m: MailMessage) => {
    // Отправитель ответа = ящик самого письма; собеседник = from_addr; тема «Re: …»; цитата в теле.
    const acct = accounts.find((a) => a.id === m.account_id)
    setCompose({
      accountKey: (acct?.active ? acct.key : '') || defaultComposeKey(),
      to: (m.from_addr ?? '').trim(),
      subject: replySubject(m.subject),
      body: quoteBody(m),
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
  const addSenderToAllowlist = async (m: MailMessage) => {
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
  const hideSender = async (m: MailMessage, scope: 'sender' | 'domain') => {
    const orgId = ownerOrgId()
    const from = (m.from_addr ?? '').trim()
    if (!orgId || !from) return
    const domain = domainOf(from)
    const entry = scope === 'domain' ? (domain ? `@${domain}` : '') : from
    if (!entry) return
    setHideMenuOpen(false)
    try {
      await addMailAllowlist({ org_id: orgId, entry, kind: 'block', note: (m.from_name ?? '').trim() || null })
      flashToast(scope === 'domain' ? t('mail_domain_hidden') : t('mail_sender_hidden'))
      await loadAllowlist() // рефетч block-списка → лента перерисуется без этих писем
      setOpenMsg(null)
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
                  onClick={() => { setActiveId(a.id); setOpenMsg(null) }}
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

          {openMsg ? (
            <div className="card mail-detail">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div>
                  <div className="mail-detail-subject">{openMsg.subject?.trim() || t('mail_no_subject')}</div>
                  <div className="muted mail-detail-from">
                    {senderLabel(openMsg, t('mail_unknown_sender'))}
                    {openMsg.from_addr ? ` · ${openMsg.from_addr}` : ''}
                  </div>
                  <div className="muted mail-detail-date">{fmtFullDate(openMsg.sent_at ?? openMsg.created_at)}</div>
                </div>
                <button type="button" className="btn ghost small" onClick={() => setOpenMsg(null)}>
                  {t('mail_close')}
                </button>
              </div>

              {/* body_text как ПЛОСКИЙ ТЕКСТ — только текстовый узел, без dangerouslySetInnerHTML.
                  white-space:pre-wrap сохраняет переводы строк письма. */}
              <div className="mail-body" style={{ whiteSpace: 'pre-wrap' }}>
                {openMsg.body_text ?? openMsg.snippet ?? ''}
              </div>

              <div className="mail-actions row" style={{ gap: 8, marginTop: 12 }}>
                <button type="button" className="btn small" onClick={() => openReply(openMsg)}>
                  {t('mail_reply')}
                </button>
                <button type="button" className="btn small" onClick={() => makeTask(openMsg)}>
                  {t('mail_to_task')}
                </button>
                <button type="button" className="btn small" onClick={() => makeEvent(openMsg)}>
                  {t('mail_to_event')}
                </button>
                {isOwner && (
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => { void addSenderToAllowlist(openMsg) }}
                    disabled={!(openMsg.from_addr && openMsg.from_addr.trim())}
                  >
                    {t('mail_add_to_allowlist')}
                  </button>
                )}
                {isOwner && (
                  <div className="mail-hide-wrap">
                    <button
                      type="button"
                      className="btn small"
                      onClick={() => setHideMenuOpen((v) => !v)}
                      disabled={!(openMsg.from_addr && openMsg.from_addr.trim())}
                      aria-expanded={hideMenuOpen}
                    >
                      {t('mail_hide_forever')}
                    </button>
                    {hideMenuOpen && (
                      <div className="mail-hide-menu" role="menu">
                        <button
                          type="button"
                          className="btn ghost small"
                          role="menuitem"
                          onClick={() => { void hideSender(openMsg, 'sender') }}
                        >
                          {t('mail_hide_sender')}
                        </button>
                        <button
                          type="button"
                          className="btn ghost small"
                          role="menuitem"
                          onClick={() => { void hideSender(openMsg, 'domain') }}
                          disabled={!domainOf((openMsg.from_addr ?? '').trim())}
                        >
                          {t('mail_hide_domain')}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ) : activeMessages.length === 0 ? (
            <div className="card muted mail-empty">{t('mail_empty')}</div>
          ) : (
            <div className="mail-list">
              {activeMessages.map((m) => {
                // MAIL-2-UI: исходящие (direction='out') — собеседник это to_addr, не bold (не «непрочитано»),
                // с меткой «↑ Исходящее». Порядок сортировки не трогаем (по sent_at, затем created_at из API).
                const isOut = m.direction === 'out'
                const counterparty = isOut
                  ? ((m.to_addr && m.to_addr.trim()) || t('mail_unknown_recipient'))
                  : senderLabel(m, t('mail_unknown_sender'))
                return (
                  <button
                    key={m.id}
                    type="button"
                    className={`mail-row${!isOut && !m.seen ? ' unread' : ''}${isOut ? ' outgoing' : ''}`}
                    onClick={() => { void openMessage(m) }}
                  >
                    <div className="mail-row-top">
                      <span className="mail-row-sender">
                        {isOut && <span className="mail-out-tag">↑ {t('mail_outgoing')}</span>}
                        {counterparty}
                      </span>
                      <span className="mail-row-date muted">{fmtRowDate(m.sent_at ?? m.created_at)}</span>
                    </div>
                    <div className="mail-row-subject">{m.subject?.trim() || t('mail_no_subject')}</div>
                    {m.snippet && <div className="mail-row-snippet muted">{m.snippet}</div>}
                  </button>
                )
              })}
            </div>
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
