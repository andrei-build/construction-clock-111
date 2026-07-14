import { useEffect, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { sendMessage } from '../lib/api'
import { enqueueFieldAction } from '../lib/offlineFieldActions'
import type { MessageRow, Profile } from '../lib/types'
import VoiceMic from './VoiceMic'

type Priority = MessageRow['priority']

function isOnline() {
  return typeof navigator === 'undefined' || navigator.onLine
}

function isNetworkError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /failed to fetch|networkerror|network|fetch|load failed/i.test(message)
}

interface MessageComposerProps {
  recipients: Profile[]
  initialRecipientId?: string
  lockRecipient?: boolean
  className?: string
  onRecipientChange?: (recipientId: string) => void
  onSent?: (recipientId: string) => void | Promise<void>
}

export default function MessageComposer({
  recipients,
  initialRecipientId,
  lockRecipient = false,
  className = '',
  onRecipientChange,
  onSent,
}: MessageComposerProps) {
  const { profile } = useAuth()
  const { t, lang } = useI18n()
  const [recipient, setRecipient] = useState(initialRecipientId ?? recipients[0]?.id ?? '')
  const [priority, setPriority] = useState<Priority>('info')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  // F64: message queued while offline (shown with a warn tone, not an error).
  const [queued, setQueued] = useState(false)

  useEffect(() => {
    const next = initialRecipientId ?? recipients[0]?.id ?? ''
    setRecipient(next)
  }, [initialRecipientId, recipients])

  const selectedRecipient = recipients.find((person) => person.id === recipient) ?? null

  const changeRecipient = (next: string) => {
    setRecipient(next)
    onRecipientChange?.(next)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!profile || !recipient || !body.trim() || busy) return
    const trimmed = body.trim()
    setBusy(true)
    setError(false)
    setQueued(false)
    // F64: offline / network drop — queue the send and replay it on reconnect. Each submit
    // gets a unique dedupeKey so distinct sends never merge (the busy guard stops doubles).
    const queueOffline = () => {
      enqueueFieldAction({
        kind: 'message_send',
        dedupeKey: `message_send:${recipient}:${crypto.randomUUID?.() ?? Date.now()}`,
        payload: { recipientId: recipient, body: trimmed, priority },
      })
      setBody('')
      setQueued(true)
    }
    try {
      if (!isOnline()) { queueOffline(); return }
      await sendMessage(profile, recipient, trimmed, priority)
      setBody('')
      await onSent?.(recipient)
    } catch (err) {
      if (!isOnline() || isNetworkError(err)) { queueOffline(); return }
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className={`card message-compose ${className}`.trim()} onSubmit={submit}>
      <label>{t('recipient')}</label>
      {lockRecipient ? (
        <div className="locked-field">{selectedRecipient?.name ?? t('unknown_user')}</div>
      ) : (
        <select value={recipient} onChange={(e) => changeRecipient(e.target.value)}>
          {recipients.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
        </select>
      )}
      <label>{t('priority')}</label>
      <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
        <option value="info">{t('priority_info')}</option>
        <option value="task">{t('priority_task')}</option>
        <option value="good">{t('priority_good')}</option>
        <option value="urgent">{t('priority_urgent')}</option>
      </select>
      <div className="message-body-label">
        <label>{t('message')}</label>
        <VoiceMic
          lang={lang}
          title={t('voice_input')}
          onResult={(text) => setBody((prev) => (prev ? `${prev} ${text}` : text))}
        />
      </div>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} />
      <button className="btn" disabled={busy || !recipient || !body.trim()}>{t('send')}</button>
      {error && <p className="error-msg">{t('load_error')}</p>}
      {queued && <p className="warn-msg">{t('offline_action_queued')}</p>}
    </form>
  )
}
