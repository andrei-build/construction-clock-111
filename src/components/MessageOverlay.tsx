import { useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../lib/i18n'
import { armUrgentChimeUnlock, playUrgentChime } from '../lib/notification-sound'
import type { MessageRow, Profile } from '../lib/types'

interface Props {
  messages: MessageRow[]
  profile: Profile
  senderName: (id: string) => string
  // Acknowledge a message (reuse the same markMessageRead path Messages uses). Must throw on failure.
  onAcknowledge: (message: MessageRow) => Promise<void>
}

// Full-screen blocking overlay shown to field staff when they have an unacknowledged
// URGENT received message. Advances through the queue (most recent first) until none remain.
export default function MessageOverlay({ messages, profile, senderName, onAcknowledge }: Props) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
  const vibratedFor = useRef<string | null>(null)
  const seenUrgent = useRef<Set<string>>(new Set())
  const hydrated = useRef(false)

  // Same "new urgent for me" notion the overlay queue uses, so the chime and the overlay
  // always agree on what counts as urgent. Kept independent of `dismissed` (dismissal is an
  // ack-error escape hatch, not a reason to re-chime).
  const urgentIds = useMemo(
    () =>
      messages
        .filter((m) => m.priority === 'urgent' && m.sender_id !== profile.id && !m.read_at)
        .map((m) => m.id),
    [messages, profile.id],
  )

  // Arm autoplay unlock once — mobile browsers block audio until the first user gesture.
  useEffect(() => {
    armUrgentChimeUnlock()
  }, [])

  // Chime once per genuinely-new urgent message. The first populated load is treated as
  // hydration (seed as seen, no chime) so opening Messages with pre-existing urgents stays
  // silent; any urgent that appears on a later reload chimes exactly once. This matches
  // Check Time's "chime on arrival, not on initial hydration" behaviour.
  useEffect(() => {
    if (!hydrated.current) {
      if (messages.length === 0) return
      hydrated.current = true
      for (const id of urgentIds) seenUrgent.current.add(id)
      return
    }
    let fresh = false
    for (const id of urgentIds) {
      if (!seenUrgent.current.has(id)) {
        seenUrgent.current.add(id)
        fresh = true
      }
    }
    if (fresh) playUrgentChime()
  }, [messages.length, urgentIds])

  const queue = useMemo(
    () =>
      messages
        .filter(
          (m) => m.priority === 'urgent' && m.sender_id !== profile.id && !m.read_at && !dismissed.has(m.id),
        )
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [messages, profile.id, dismissed],
  )

  const current = queue[0] ?? null

  // One-shot vibrate + reset error each time a new urgent message surfaces.
  useEffect(() => {
    if (!current) return
    if (vibratedFor.current === current.id) return
    vibratedFor.current = current.id
    setError(false)
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate([200])
  }, [current])

  if (!current) return null

  const acknowledge = async () => {
    if (busy) return
    setBusy(true)
    setError(false)
    try {
      // Success: parent reloads messages, this one drops out of the queue and the next surfaces.
      await onAcknowledge(current)
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  // Only offered after an ack failure so the worker is never permanently trapped.
  const closeAfterError = () => {
    setDismissed((prev) => new Set(prev).add(current.id))
    setError(false)
  }

  return (
    <div
      className="confirm-backdrop message-overlay-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="message-overlay-title"
    >
      <div className="card confirm-modal message-overlay-modal">
        <div className="row">
          <span className="badge red">{t('priority_urgent')}</span>
          <span className="when">{new Date(current.created_at).toLocaleString()}</span>
        </div>
        <h2 id="message-overlay-title">{t('urgent_message_title')}</h2>
        <p className="message-overlay-from">{senderName(current.sender_id)}</p>
        <p className="message-overlay-body">{current.body}</p>
        {queue.length > 1 && (
          <p className="muted small">{t('urgent_more_remaining').replace('{count}', String(queue.length - 1))}</p>
        )}
        {error && <p className="error-msg">{t('load_error')}</p>}
        <div className="row">
          <button className="btn primary" disabled={busy} onClick={acknowledge}>
            {t('got_it')}
          </button>
          {error && (
            <button className="btn ghost" onClick={closeAfterError}>
              {t('close')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
