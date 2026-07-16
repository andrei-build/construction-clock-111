import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createCalendarEvent,
  createTask,
  emitMailUnreadChanged,
  getMailAccounts,
  getMailMessages,
  markMailSeen,
  triggerMailSync,
} from '../lib/api'
import type { MailAccount, MailMessage } from '../lib/api/mail'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'

// MAIL-1-UI: экран «Почта» (owner/admin). Читает развёрнутый mail-бэкенд через RLS. Чистый фронт:
// список писем по вкладкам двух ящиков, карточка письма (body_text ТЕКСТОМ, без
// dangerouslySetInnerHTML), два действия «в задачу / в событие» из письма (ДНК §13), ручной
// refresh через edge `mail-sync`. Пустой/ошибочный ящик — НЕ баг (секреты могут быть не введены):
// показываем аккуратные пустые/ошибочные состояния. Глобальный «← Назад» уже рендерит App.tsx —
// свой back-кнопки НЕ добавляем; в карточке письма — обычный «Закрыть» (это не навигация).

function senderLabel(m: MailMessage, unknown: string): string {
  return (m.from_name && m.from_name.trim()) || (m.from_addr && m.from_addr.trim()) || unknown
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
  const { t } = useI18n()
  const isAdminOrOwner = profile?.role === 'owner' || profile?.role === 'admin'

  const [accounts, setAccounts] = useState<MailAccount[]>([])
  const [messages, setMessages] = useState<MailMessage[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [openMsg, setOpenMsg] = useState<MailMessage | null>(null)
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

  const load = useCallback(async () => {
    if (!isAdminOrOwner) return
    setLoading(true)
    const [accs, msgs] = await Promise.all([getMailAccounts(), getMailMessages()])
    setAccounts(accs)
    setMessages(msgs)
    setActiveId((prev) => (prev && accs.some((a) => a.id === prev) ? prev : accs[0]?.id ?? null))
    setLoading(false)
  }, [isAdminOrOwner])

  useEffect(() => { void load() }, [load])

  const activeAccount = useMemo(
    () => accounts.find((a) => a.id === activeId) ?? null,
    [accounts, activeId],
  )
  const activeMessages = useMemo(
    () => (activeId ? messages.filter((m) => m.account_id === activeId) : []),
    [messages, activeId],
  )
  const unreadByAccount = useMemo(() => {
    const map = new Map<string, number>()
    for (const m of messages) if (!m.seen) map.set(m.account_id, (map.get(m.account_id) ?? 0) + 1)
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

  const syncLabel = (a: MailAccount): string => {
    if (!a.last_sync_at) return t('mail_never_synced')
    return t('mail_last_sync').replace('{time}', fmtTime(a.last_sync_at))
  }

  return (
    <div className="screen mail-screen">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>✉️ {t('mail')}</h1>
        <button type="button" className="btn ghost small" onClick={doSync} disabled={syncing}>
          {syncing ? t('mail_refreshing') : t('mail_refresh')}
        </button>
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
                <button type="button" className="btn small" onClick={() => makeTask(openMsg)}>
                  {t('mail_to_task')}
                </button>
                <button type="button" className="btn small" onClick={() => makeEvent(openMsg)}>
                  {t('mail_to_event')}
                </button>
              </div>
            </div>
          ) : activeMessages.length === 0 ? (
            <div className="card muted mail-empty">{t('mail_empty')}</div>
          ) : (
            <div className="mail-list">
              {activeMessages.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`mail-row${m.seen ? '' : ' unread'}`}
                  onClick={() => { void openMessage(m) }}
                >
                  <div className="mail-row-top">
                    <span className="mail-row-sender">{senderLabel(m, t('mail_unknown_sender'))}</span>
                    <span className="mail-row-date muted">{fmtRowDate(m.sent_at ?? m.created_at)}</span>
                  </div>
                  <div className="mail-row-subject">{m.subject?.trim() || t('mail_no_subject')}</div>
                  {m.snippet && <div className="mail-row-snippet muted">{m.snippet}</div>}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {toast && (
        <div className="travel-toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </div>
  )
}
