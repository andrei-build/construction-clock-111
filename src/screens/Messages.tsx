import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { useNotifications } from '../lib/notifications'
import { getMessages, getTeam, markMessageRead, snoozeMessage, subscribeToMyMessages, unsnoozeMessage } from '../lib/api'
import type { SnoozableMessageRow } from '../lib/api'
import { isManagerRole, type MessageRow, type Profile } from '../lib/types'
import MessageComposer from '../components/MessageComposer'
import MessageOverlay from '../components/MessageOverlay'

type Priority = MessageRow['priority']

interface Thread {
  counterpartId: string
  name: string
  messages: SnoozableMessageRow[]
  unread: number
  latest: string
}

// M10: сообщение «отложено», если snoozed_until в будущем (проверка на клиенте при каждом
// load/refetch — прошедший снуз сам вернётся в активную ленту). Снуз ставит только получатель,
// поэтому isSnoozed истинно лишь для входящих (у своих snoozed_until = null).
function isSnoozed(m: SnoozableMessageRow): boolean {
  return !!m.snoozed_until && new Date(m.snoozed_until).getTime() > Date.now()
}

// M10: три пресета отложения. Считаем на клиенте в локальном времени пользователя.
function snoozePresets(): { key: string; until: Date }[] {
  const now = new Date()
  const inOneHour = new Date(now.getTime() + 60 * 60 * 1000)

  const evening = new Date(now)
  evening.setHours(18, 0, 0, 0)
  if (evening.getTime() <= now.getTime()) evening.setDate(evening.getDate() + 1)

  const morning = new Date(now)
  morning.setDate(morning.getDate() + 1)
  morning.setHours(8, 0, 0, 0)

  return [
    { key: 'snooze_1h', until: inOneHour },
    { key: 'snooze_evening', until: evening },
    { key: 'snooze_tomorrow', until: morning },
  ]
}

export default function Messages() {
  const { profile } = useAuth()
  const { t } = useI18n()
  // MSG-1: сообщаем глобальному счётчику пересчитаться сразу после отметки «прочитано» — чтение
  // это UPDATE, а realtime-подписка ловит только INSERT, поэтому бейдж иначе очистится лишь по поллу.
  const { refreshUnread } = useNotifications()
  const [team, setTeam] = useState<Profile[]>([])
  const [messages, setMessages] = useState<SnoozableMessageRow[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [recipient, setRecipient] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  // M10: какое входящее сообщение раскрыло меню «Отложить», и раскрыта ли секция «Отложенные».
  const [snoozeOpenId, setSnoozeOpenId] = useState<string | null>(null)
  const [showSnoozed, setShowSnoozed] = useState(false)

  const load = async () => {
    if (!profile) return
    setLoading(true)
    setError(false)
    try {
      const [people, rows] = await Promise.all([getTeam(), getMessages(profile.id)])
      setTeam(people.filter((p) => p.id !== profile.id))
      setMessages(rows)
      if (!recipient) setRecipient(people.find((p) => p.id !== profile.id)?.id ?? '')
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [profile?.id])

  useEffect(() => {
    if (!profile?.id) return
    return subscribeToMyMessages(profile.id, () => { void load() }, `messages:screen:${profile.id}`)
  }, [profile?.id])

  const peopleById = useMemo(() => {
    const m = new Map<string, Profile>()
    for (const person of team) m.set(person.id, person)
    if (profile) m.set(profile.id, profile)
    return m
  }, [profile, team])

  const threads = useMemo<Thread[]>(() => {
    if (!profile) return []
    const map = new Map<string, SnoozableMessageRow[]>()
    for (const message of messages) {
      const counterpartId = message.sender_id === profile.id ? message.recipient_id : message.sender_id
      if (!map.has(counterpartId)) map.set(counterpartId, [])
      map.get(counterpartId)!.push(message)
    }
    return Array.from(map.entries()).map(([counterpartId, rows]) => {
      const sorted = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at))
      return {
        counterpartId,
        name: peopleById.get(counterpartId)?.name ?? t('unknown_user'),
        messages: sorted,
        unread: sorted.filter((m) => m.recipient_id === profile.id && !m.read_at && !isSnoozed(m)).length,
        latest: sorted[0]?.created_at ?? '',
      }
    }).sort((a, b) => b.latest.localeCompare(a.latest))
  }, [messages, peopleById, profile])

  useEffect(() => {
    if (!selected && threads[0]) setSelected(threads[0].counterpartId)
  }, [selected, threads])

  const activeThread = threads.find((thread) => thread.counterpartId === selected) ?? null
  const priorityTone = (p: Priority) => p === 'urgent' ? 'red' : p === 'good' ? 'green' : p === 'task' ? 'amber' : 'blue'
  const priorityRank = (p: Priority) => p === 'urgent' ? 0 : p === 'task' ? 1 : p === 'info' ? 2 : 3
  const isUnread = (m: MessageRow) => !!profile && m.sender_id !== profile.id && !m.read_at

  // M10: активная лента = сообщения треда без тех, что сейчас отложены в будущее. Прошедший снуз
  // (snoozed_until <= now) сюда попадает автоматически и сохраняет свой unread-стиль (снуз ортогонален seen).
  // Stable sort of the displayed list: unread first, then priority (urgent>task>info>good), then time desc.
  const activeMessages = useMemo(() => {
    if (!activeThread) return []
    return activeThread.messages.filter((m) => !isSnoozed(m)).sort((a, b) => {
      if (isUnread(a) !== isUnread(b)) return isUnread(a) ? -1 : 1
      if (a.priority !== b.priority) return priorityRank(a.priority) - priorityRank(b.priority)
      return b.created_at.localeCompare(a.created_at)
    })
  }, [activeThread, profile])

  // M10: отложенные сообщения текущего треда, по времени возврата (ближайшее сверху).
  const snoozedMessages = useMemo(() => {
    if (!activeThread) return []
    return activeThread.messages
      .filter((m) => isSnoozed(m))
      .sort((a, b) => (a.snoozed_until ?? '').localeCompare(b.snoozed_until ?? ''))
  }, [activeThread])

  const unreadIds = useMemo(() => activeMessages.filter(isUnread).map((m) => m.id), [activeMessages, profile])

  const read = async (message: MessageRow) => {
    if (!profile || busy) return
    setBusy(true)
    setError(false)
    try {
      await markMessageRead(profile, message.id)
      await load()
      refreshUnread()
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  // M10: отложить входящее до выбранного пресета. Пишем snoozed_until, закрываем меню, перечитываем.
  const snooze = async (message: SnoozableMessageRow, until: Date) => {
    if (!profile || busy) return
    setBusy(true)
    setError(false)
    try {
      await snoozeMessage(profile, message.id, until.toISOString())
      setSnoozeOpenId(null)
      await load()
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  // M10: вернуть отложенное в активную ленту (snoozed_until → null).
  const unsnooze = async (message: SnoozableMessageRow) => {
    if (!profile || busy) return
    setBusy(true)
    setError(false)
    try {
      await unsnoozeMessage(profile, message.id)
      await load()
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  // Acknowledge path for the urgent-message overlay: same markMessageRead as the list,
  // but rethrows so the overlay can surface an error state. Managers never see the overlay.
  const acknowledgeUrgent = async (message: MessageRow) => {
    if (!profile) return
    await markMessageRead(profile, message.id)
    await load()
    refreshUnread()
  }

  const markAllRead = async () => {
    if (!profile || busy || unreadIds.length === 0) return
    setBusy(true)
    setError(false)
    try {
      await Promise.all(unreadIds.map((id) => markMessageRead(profile, id)))
      await load()
      refreshUnread()
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="screen messages-screen">
      {profile && !isManagerRole(profile.role) && (
        <MessageOverlay
          messages={messages}
          profile={profile}
          senderName={(id) => peopleById.get(id)?.name ?? t('unknown_user')}
          onAcknowledge={acknowledgeUrgent}
        />
      )}
      <h1>💬 {t('messages')}</h1>
      {loading && <div className="card center muted">{t('loading')}</div>}
      {error && <p className="error-msg">{t('load_error')}</p>}

      <MessageComposer
        recipients={team}
        initialRecipientId={recipient}
        onRecipientChange={setRecipient}
        onSent={async (recipientId) => {
          setSelected(recipientId)
          await load()
        }}
      />

      {!loading && threads.length === 0 && <div className="card muted">{t('no_messages')}</div>}
      {threads.length > 0 && (
        <div className="messages-layout">
          <section className="message-threads">
            <h2>{t('threads')}</h2>
            {threads.map((thread) => (
              <button
                key={thread.counterpartId}
                className={`thread-button ${selected === thread.counterpartId ? 'active' : ''}`}
                onClick={() => setSelected(thread.counterpartId)}
              >
                <span>{thread.name}</span>
                {thread.unread > 0 && <span className="badge red">{thread.unread}</span>}
              </button>
            ))}
          </section>

          <section className="message-thread-card card">
            <div className="row thread-header">
              <h2>{activeThread?.name ?? t('threads')}</h2>
              {unreadIds.length > 0 && (
                <button className="btn ghost small" disabled={busy} onClick={markAllRead}>
                  {t('mark_all_read')} ({unreadIds.length})
                </button>
              )}
            </div>
            {activeMessages.map((message) => {
              const mine = message.sender_id === profile?.id
              return (
                <div key={message.id} className={`message-bubble ${mine ? 'mine' : ''}`}>
                  <div className="row">
                    <span className={`badge ${priorityTone(message.priority)}`}>{t(`priority_${message.priority}`)}</span>
                    <span className="when">{new Date(message.created_at).toLocaleString()}</span>
                  </div>
                  <p>{message.body}</p>
                  {!mine && (
                    <div className="row message-actions">
                      {!message.read_at && (
                        <button className="btn ghost small" disabled={busy} onClick={() => read(message)}>{t('mark_read')}</button>
                      )}
                      {snoozeOpenId === message.id ? (
                        <>
                          {snoozePresets().map((preset) => (
                            <button
                              key={preset.key}
                              className="btn ghost small"
                              disabled={busy}
                              onClick={() => snooze(message, preset.until)}
                            >
                              {t(preset.key)}
                            </button>
                          ))}
                          <button className="btn ghost small" disabled={busy} onClick={() => setSnoozeOpenId(null)}>
                            {t('cancel')}
                          </button>
                        </>
                      ) : (
                        <button className="btn ghost small" disabled={busy} onClick={() => setSnoozeOpenId(message.id)}>
                          💤 {t('snooze')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}

            {snoozedMessages.length > 0 && (
              <section className="snoozed-section">
                <button className="btn ghost small snoozed-toggle" onClick={() => setShowSnoozed((v) => !v)}>
                  {showSnoozed ? '▾' : '▸'} {t('snoozed_section')} ({snoozedMessages.length})
                </button>
                {showSnoozed && snoozedMessages.map((message) => (
                  <div key={message.id} className="message-bubble snoozed">
                    <div className="row">
                      <span className={`badge ${priorityTone(message.priority)}`}>{t(`priority_${message.priority}`)}</span>
                      <span className="when">{new Date(message.created_at).toLocaleString()}</span>
                    </div>
                    <p>{message.body}</p>
                    <div className="row message-actions">
                      <span className="muted small">
                        {t('snoozed_until')} {message.snoozed_until ? new Date(message.snoozed_until).toLocaleString() : ''}
                      </span>
                      <button className="btn ghost small" disabled={busy} onClick={() => unsnooze(message)}>
                        {t('unsnooze')}
                      </button>
                    </div>
                  </div>
                ))}
              </section>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
