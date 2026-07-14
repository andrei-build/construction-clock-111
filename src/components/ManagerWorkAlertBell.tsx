import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getMessages, getOpenTasks, subscribeToTaskChanges } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { armUrgentChimeUnlock, playUrgentChime } from '../lib/notification-sound'
import { isManagerRole } from '../lib/types'
import type { MessageRow, Task } from '../lib/types'

// F69 (П11 parity with Check Time's ManagerWorkAlertBell), POLL-ONLY variant.
// A manager-only bell in the desktop sidebar that badges the number of items needing
// manager attention — unread messages addressed to this manager plus open/in-progress
// tasks — and opens a priority-first dropdown listing them. A mute toggle (persisted in
// localStorage) silences the optional arrival chime.
//
// Keeps the existing ~30s read fallback, and also refreshes immediately on task changes
// through the same org-scoped tasks realtime subscription used by task lists.

const MUTE_KEY = 'cclock_manager_alert_muted'
const POLL_MS = 30_000
type Tone = 'red' | 'amber' | 'green' | 'blue' | 'grey'

interface AlertItem {
  id: string
  kind: 'message' | 'task'
  title: string
  tone: Tone
  // Lower sorts first. Urgent items of either kind float to the top.
  rank: number
  to: string
}

// Unread messages sent TO this manager, most urgent first. Mirrors the "unread to me"
// notion used on the Messages screen (recipient is me, not yet read).
function messageItems(messages: MessageRow[], profileId: string): AlertItem[] {
  const rankOf = (p: MessageRow['priority']) => (p === 'urgent' ? 0 : p === 'task' ? 3 : 4)
  const toneOf = (p: MessageRow['priority']): Tone =>
    p === 'urgent' ? 'red' : p === 'good' ? 'green' : p === 'task' ? 'amber' : 'blue'
  return messages
    .filter((m) => m.recipient_id === profileId && !m.read_at)
    .map((m) => ({
      id: `msg:${m.id}`,
      kind: 'message' as const,
      title: m.body,
      tone: toneOf(m.priority),
      rank: rankOf(m.priority),
      to: '/messages',
    }))
}

// Open / in-progress tasks (already org-scoped server-side), most urgent first.
function taskItems(tasks: Task[]): AlertItem[] {
  const rankOf = (p: Task['priority']) => (p === 'urgent' ? 0 : p === 'high' ? 1 : p === 'medium' ? 2 : 3)
  const toneOf = (p: Task['priority']): Tone =>
    p === 'urgent' ? 'red' : p === 'high' ? 'amber' : p === 'medium' ? 'blue' : 'grey'
  return tasks.map((tk) => ({
    id: `task:${tk.id}`,
    kind: 'task' as const,
    title: tk.title,
    tone: toneOf(tk.priority),
    rank: rankOf(tk.priority),
    to: '/dispatch',
  }))
}

function buildItems(messages: MessageRow[], tasks: Task[], profileId: string): AlertItem[] {
  return [...messageItems(messages, profileId), ...taskItems(tasks)].sort((a, b) => a.rank - b.rank)
}

export default function ManagerWorkAlertBell() {
  const { profile } = useAuth()
  const { t } = useI18n()
  const navigate = useNavigate()
  const [items, setItems] = useState<AlertItem[]>([])
  const [open, setOpen] = useState(false)
  const [muted, setMuted] = useState(() => localStorage.getItem(MUTE_KEY) === '1')
  const rootRef = useRef<HTMLDivElement>(null)
  const seen = useRef<Set<string>>(new Set())
  const hydrated = useRef(false)

  const manager = !!profile && isManagerRole(profile.role)

  const load = useCallback(async () => {
    if (!profile) return
    try {
      const [messages, tasks] = await Promise.all([getMessages(profile.id), getOpenTasks()])
      setItems(buildItems(messages, tasks, profile.id))
    } catch {
      // Poll-only best-effort: keep the last known counts on a transient read failure.
    }
  }, [profile])

  // Arm autoplay unlock once — mobile browsers keep audio suspended until the first gesture.
  useEffect(() => {
    armUrgentChimeUnlock()
  }, [])

  // Initial fetch + ~30s poll. Cleared on unmount.
  useEffect(() => {
    if (!manager) return
    void load()
    const id = window.setInterval(() => void load(), POLL_MS)
    return () => window.clearInterval(id)
  }, [manager, load])

  useEffect(() => {
    if (!manager || !profile?.org_id) return
    return subscribeToTaskChanges(profile.org_id, () => { void load() }, `tasks:manager-alert:${profile.id}`)
  }, [manager, profile?.org_id, profile?.id, load])

  // Chime once per genuinely-new alert. The first populated load is treated as hydration
  // (seed as seen, no chime) so mounting with pre-existing work stays silent; anything that
  // appears on a later poll chimes exactly once. Guarded by the mute flag and tab visibility.
  useEffect(() => {
    const ids = items.map((i) => i.id)
    if (!hydrated.current) {
      if (items.length === 0) return
      hydrated.current = true
      for (const id of ids) seen.current.add(id)
      return
    }
    let fresh = false
    for (const id of ids) {
      if (!seen.current.has(id)) {
        seen.current.add(id)
        fresh = true
      }
    }
    // Prune resolved items so a later re-appearance is treated as fresh and memory stays bounded.
    seen.current = new Set(ids)
    if (fresh && !muted && (typeof document === 'undefined' || !document.hidden)) {
      playUrgentChime()
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate([120])
    }
  }, [items, muted])

  // Close the dropdown on an outside click.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const count = items.length
  const badge = useMemo(() => (count > 99 ? '99+' : String(count)), [count])

  if (!manager) return null

  const toggleMute = () => {
    setMuted((m) => {
      const next = !m
      localStorage.setItem(MUTE_KEY, next ? '1' : '0')
      return next
    })
  }

  const go = (to: string) => {
    setOpen(false)
    navigate(to)
  }

  return (
    <div className="manager-alert-bell" ref={rootRef}>
      <button
        type="button"
        className="manager-alert-btn"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={t('manager_alerts_label')}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="manager-alert-ico" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.7 21a2 2 0 0 1-3.4 0" />
          </svg>
        </span>
        <span className="manager-alert-text">{t('manager_alerts_label')}</span>
        {count > 0 && <span className="badge red manager-alert-count">{badge}</span>}
      </button>

      {open && (
        <div className="manager-alert-dropdown" role="menu">
          <div className="manager-alert-head">
            <span>{t('manager_alerts_title')}</span>
            <button type="button" className="manager-alert-mute" onClick={toggleMute}>
              {muted ? t('manager_alerts_unmute') : t('manager_alerts_mute')}
            </button>
          </div>
          {count === 0 ? (
            <div className="manager-alert-empty">{t('manager_alerts_empty')}</div>
          ) : (
            <ul className="manager-alert-list">
              {items.slice(0, 20).map((it) => (
                <li key={it.id}>
                  <button type="button" className="manager-alert-item" role="menuitem" onClick={() => go(it.to)}>
                    <span className={`badge ${it.tone} manager-alert-kind`}>
                      {it.kind === 'message' ? t('manager_alerts_kind_message') : t('manager_alerts_kind_task')}
                    </span>
                    <span className="manager-alert-item-title">{it.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
