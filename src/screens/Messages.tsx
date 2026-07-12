import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { getMessages, getTeam, markMessageRead } from '../lib/api'
import type { MessageRow, Profile } from '../lib/types'
import MessageComposer from '../components/MessageComposer'

type Priority = MessageRow['priority']

interface Thread {
  counterpartId: string
  name: string
  messages: MessageRow[]
  unread: number
  latest: string
}

export default function Messages() {
  const { profile } = useAuth()
  const { t } = useI18n()
  const [team, setTeam] = useState<Profile[]>([])
  const [messages, setMessages] = useState<MessageRow[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [recipient, setRecipient] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)

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

  const peopleById = useMemo(() => {
    const m = new Map<string, Profile>()
    for (const person of team) m.set(person.id, person)
    if (profile) m.set(profile.id, profile)
    return m
  }, [profile, team])

  const threads = useMemo<Thread[]>(() => {
    if (!profile) return []
    const map = new Map<string, MessageRow[]>()
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
        unread: sorted.filter((m) => m.recipient_id === profile.id && !m.read_at).length,
        latest: sorted[0]?.created_at ?? '',
      }
    }).sort((a, b) => b.latest.localeCompare(a.latest))
  }, [messages, peopleById, profile])

  useEffect(() => {
    if (!selected && threads[0]) setSelected(threads[0].counterpartId)
  }, [selected, threads])

  const activeThread = threads.find((thread) => thread.counterpartId === selected) ?? null
  const activeMessages = activeThread ? [...activeThread.messages].reverse() : []
  const priorityTone = (p: Priority) => p === 'urgent' ? 'red' : p === 'good' ? 'green' : p === 'task' ? 'amber' : 'blue'

  const read = async (message: MessageRow) => {
    if (!profile || busy) return
    setBusy(true)
    setError(false)
    try {
      await markMessageRead(profile, message.id)
      await load()
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="screen messages-screen">
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
            <h2>{activeThread?.name ?? t('threads')}</h2>
            {activeMessages.map((message) => {
              const mine = message.sender_id === profile?.id
              return (
                <div key={message.id} className={`message-bubble ${mine ? 'mine' : ''}`}>
                  <div className="row">
                    <span className={`badge ${priorityTone(message.priority)}`}>{t(`priority_${message.priority}`)}</span>
                    <span className="when">{new Date(message.created_at).toLocaleString()}</span>
                  </div>
                  <p>{message.body}</p>
                  {!mine && !message.read_at && (
                    <button className="btn ghost small" disabled={busy} onClick={() => read(message)}>{t('mark_read')}</button>
                  )}
                </div>
              )
            })}
          </section>
        </div>
      )}
    </div>
  )
}
