import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { getEventsSince } from '../lib/api'
import { workedMs, fmtHours, fmtClock, todayStartISO, weekStartISO } from '../lib/time'
import type { TimeEvent } from '../lib/types'

export default function MyTime() {
  const { profile } = useAuth()
  const { t } = useI18n()
  const [range, setRange] = useState<'today' | 'week'>('today')
  const [events, setEvents] = useState<TimeEvent[]>([])

  useEffect(() => {
    if (!profile) return
    getEventsSince(range === 'today' ? todayStartISO() : weekStartISO(), profile.id).then(setEvents)
  }, [profile?.id, range])

  const total = useMemo(() => workedMs(events), [events])

  const label = (t2: string) =>
    t2 === 'check_in' ? '🟢' : t2 === 'check_out' ? '🔴' : t2 === 'break_start' ? '⏸️' : t2 === 'break_end' ? '▶️' : '✏️'

  return (
    <div className="screen">
      <h1>🕐 {t('my_time')}</h1>
      <div className="tabs">
        <button className={range === 'today' ? 'active' : ''} onClick={() => setRange('today')}>{t('today')}</button>
        <button className={range === 'week' ? 'active' : ''} onClick={() => setRange('week')}>{t('week')}</button>
      </div>
      <div className="card center">
        <div className="big">{fmtHours(total)} {t('h')}</div>
      </div>
      {events.slice().reverse().map((e) => (
        <div key={e.id} className="feed-item row">
          <div>{label(e.event_type)} {e.event_type}</div>
          <div className="when">
            {new Date(e.event_time).toLocaleDateString()} {fmtClock(e.event_time)}
            {e.gps_status && e.gps_status !== 'good' ? ' · GPS?' : ''}
          </div>
        </div>
      ))}
    </div>
  )
}
