import { useEffect, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { sendMessage } from '../lib/api'
import type { MessageRow, Profile } from '../lib/types'

type Priority = MessageRow['priority']

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
  const { t } = useI18n()
  const [recipient, setRecipient] = useState(initialRecipientId ?? recipients[0]?.id ?? '')
  const [priority, setPriority] = useState<Priority>('info')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)

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
    setBusy(true)
    setError(false)
    try {
      await sendMessage(profile, recipient, body.trim(), priority)
      setBody('')
      await onSent?.(recipient)
    } catch {
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
      <label>{t('message')}</label>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} />
      <button className="btn" disabled={busy || !recipient || !body.trim()}>{t('send')}</button>
      {error && <p className="error-msg">{t('load_error')}</p>}
    </form>
  )
}
