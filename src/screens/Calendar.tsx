import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { createCalendarEvent, getCalendarEvents } from '../lib/api'
import type { CalendarEvent } from '../lib/types'

type EventType = CalendarEvent['event_type']

const DAY_MS = 24 * 60 * 60 * 1000

function startOfWeek(d: Date) {
  const x = new Date(d)
  const day = (x.getDay() + 6) % 7
  x.setDate(x.getDate() - day)
  x.setHours(0, 0, 0, 0)
  return x
}

export default function Calendar() {
  const { profile } = useAuth()
  const { t } = useI18n()
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [title, setTitle] = useState('')
  const [type, setType] = useState<EventType>('meeting')
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [time, setTime] = useState('09:00')
  const [permit, setPermit] = useState('')
  const [inspectionStatus, setInspectionStatus] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)

  const week = useMemo(() => {
    const start = startOfWeek(new Date())
    return { start, end: new Date(start.getTime() + 7 * DAY_MS) }
  }, [])

  const load = async () => {
    setLoading(true)
    setError(false)
    try {
      setEvents(await getCalendarEvents(week.start.toISOString(), week.end.toISOString()))
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [profile?.id])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!profile || !title.trim() || busy) return
    setBusy(true)
    setError(false)
    try {
      await createCalendarEvent(profile, {
        title: title.trim(),
        event_type: type,
        starts_at: new Date(`${date}T${time}:00`).toISOString(),
        permit_number: type === 'inspection' && permit.trim() ? permit.trim() : null,
        inspection_status: type === 'inspection' && inspectionStatus.trim() ? inspectionStatus.trim() : null,
      })
      setTitle('')
      setPermit('')
      setInspectionStatus('')
      await load()
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  const typeLabel = (value: EventType) => t(`event_${value}`)
  const statusTone = (status: string | null) => {
    const s = (status ?? '').toLowerCase()
    if (s.includes('pass') || s.includes('approved') || s.includes('ok')) return 'green'
    if (s.includes('fail') || s.includes('cancel') || s.includes('red')) return 'red'
    return 'amber'
  }

  return (
    <div className="screen calendar-screen">
      <h1>📅 {t('calendar')}</h1>
      <p className="muted calendar-week">{week.start.toLocaleDateString()} – {new Date(week.end.getTime() - DAY_MS).toLocaleDateString()}</p>

      {error && <p className="error-msg">{t('load_error')}</p>}

      <form className="card calendar-form" onSubmit={submit}>
        <label>{t('name')}</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
        <label>{t('event_type')}</label>
        <select value={type} onChange={(e) => setType(e.target.value as EventType)}>
          <option value="meeting">{t('event_meeting')}</option>
          <option value="inspection">{t('event_inspection')}</option>
          <option value="measure">{t('event_measure')}</option>
          <option value="delivery">{t('event_delivery')}</option>
          <option value="other">{t('event_other')}</option>
        </select>
        <div className="grid2">
          <div>
            <label>{t('date')}</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label>{t('time')}</label>
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </div>
        </div>
        {type === 'inspection' && (
          <div className="grid2">
            <div>
              <label>{t('permit_number')}</label>
              <input value={permit} onChange={(e) => setPermit(e.target.value)} />
            </div>
            <div>
              <label>{t('inspection_status')}</label>
              <input value={inspectionStatus} onChange={(e) => setInspectionStatus(e.target.value)} />
            </div>
          </div>
        )}
        <button className="btn" disabled={busy || !title.trim()}>{t('create')}</button>
      </form>

      <h2>{t('week')}</h2>
      {loading && <div className="card center muted">{t('loading')}</div>}
      {!loading && events.length === 0 && <div className="card muted">{t('no_calendar_events')}</div>}
      <div className="calendar-list">
        {events.map((event) => (
          <div key={event.id} className={`card calendar-event ${event.event_type === 'inspection' ? 'inspection' : ''}`}>
            <div className="row">
              <div>
                <div className="item-title">{event.title}</div>
                <div className="muted">{new Date(event.starts_at).toLocaleString()}</div>
              </div>
              <span className={`badge ${event.event_type === 'inspection' ? 'amber' : 'blue'}`}>{typeLabel(event.event_type)}</span>
            </div>
            {event.event_type === 'inspection' && (
              <div className="inspection-row">
                {event.permit_number && <span className="badge blue">{event.permit_number}</span>}
                {event.inspection_status && <span className={`badge ${statusTone(event.inspection_status)}`}>{event.inspection_status}</span>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
