import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { getEventsSince } from '../lib/api'
import { workedMs, fmtHours, fmtClock, todayStartISO, weekStartISO, yesterdayStartISO, lastWeekStartISO } from '../lib/time'
import type { TimeEvent } from '../lib/types'

export default function MyTime() {
  const { profile } = useAuth()
  const { t } = useI18n()
  const [range, setRange] = useState<'today' | 'week'>('today')
  const [events, setEvents] = useState<TimeEvent[]>([])

  useEffect(() => {
    if (!profile) return
    // Грузим с начала прошлой недели — покрывает все четыре корзины (только чтение своих событий)
    getEventsSince(lastWeekStartISO(), profile.id).then(setEvents)
  }, [profile?.id])

  // Корзины часов: сегодня/вчера/эта неделя/прошлая неделя. Границы те же, что у todayStart/weekStart.
  const tiles = useMemo(() => {
    const now = Date.now()
    const todayMs = new Date(todayStartISO()).getTime()
    const yestMs = new Date(yesterdayStartISO()).getTime()
    const weekMs = new Date(weekStartISO()).getTime()
    const lastWeekMs = new Date(lastWeekStartISO()).getTime()
    const worked = (from: number, to: number) =>
      workedMs(events.filter((e) => {
        const ts = new Date(e.event_time).getTime()
        return ts >= from && ts < to
      }), to)
    return [
      { key: 'today', label: t('today'), value: worked(todayMs, now) },
      { key: 'yesterday', label: t('yesterday'), value: worked(yestMs, todayMs) },
      { key: 'current_week', label: t('current_week'), value: worked(weekMs, now) },
      { key: 'last_week', label: t('last_week'), value: worked(lastWeekMs, weekMs) },
    ]
  }, [events, t])

  // Лента событий переключается вкладкой (сегодня/неделя) поверх уже загруженных данных
  const feed = useMemo(() => {
    const fromMs = new Date(range === 'today' ? todayStartISO() : weekStartISO()).getTime()
    return events.filter((e) => new Date(e.event_time).getTime() >= fromMs)
  }, [events, range])

  const label = (t2: string) =>
    t2 === 'check_in' ? '🟢' : t2 === 'check_out' ? '🔴' : t2 === 'break_start' ? '⏸️' : t2 === 'break_end' ? '▶️' : '✏️'

  // M6: комментарий менеджера к корректировке. Показываем ТОЛЬКО когда show_to_worker=true И есть текст.
  // Поле show_to_worker приходит из getEventsSince (аддитивно в select); в общем типе TimeEvent его нет —
  // читаем через узкий каст, при false/отсутствии возвращаем null (поведение без M6 сохраняется).
  const managerNote = (e: TimeEvent): string | null => {
    const showToWorker = (e as TimeEvent & { show_to_worker?: boolean | null }).show_to_worker
    const reason = e.adjust_reason?.trim()
    return showToWorker && reason ? reason : null
  }

  return (
    <div className="screen">
      <h1>🕐 {t('my_time')}</h1>
      <div className="worker-hour-grid">
        {tiles.map((tile) => (
          <div key={tile.key} className="card metric-card blue">
            <div className="metric-value num-display">{fmtHours(tile.value)} {t('h')}</div>
            <div className="muted">{tile.label}</div>
          </div>
        ))}
      </div>
      <div className="tabs">
        <button className={range === 'today' ? 'active' : ''} onClick={() => setRange('today')}>{t('today')}</button>
        <button className={range === 'week' ? 'active' : ''} onClick={() => setRange('week')}>{t('week')}</button>
      </div>
      {feed.slice().reverse().map((e) => {
        const note = managerNote(e)
        return (
          <div key={e.id} className="feed-item">
            <div className="row">
              <div>{label(e.event_type)} {e.event_type}</div>
              <div className="when">
                {new Date(e.event_time).toLocaleDateString()} {fmtClock(e.event_time)}
                {e.gps_status && e.gps_status !== 'good' ? ' · GPS?' : ''}
              </div>
            </div>
            {note && (
              <div className="manager-note muted">💬 {t('manager_note')}: {note}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}
