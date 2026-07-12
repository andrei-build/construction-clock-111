import { useEffect, useMemo, useState } from 'react'
import { getTimelineEvents } from '../lib/api'
import { useI18n } from '../lib/i18n'
import type { TimelineEventRow } from '../lib/types'

const PAGE_SIZE = 200

type TimelineFilter = 'all' | 'time' | 'task' | 'sales' | 'team'

const filters: Array<{ key: TimelineFilter; labelKey: string; prefix: string | null }> = [
  { key: 'all', labelKey: 'timeline_filter_all', prefix: null },
  { key: 'time', labelKey: 'timeline_filter_time', prefix: 'time.' },
  { key: 'task', labelKey: 'timeline_filter_tasks', prefix: 'task.' },
  { key: 'sales', labelKey: 'timeline_filter_sales', prefix: 'sales.' },
  { key: 'team', labelKey: 'timeline_filter_team', prefix: 'team.' },
]

const eventLabelKeys: Record<string, string> = {
  'time.check_in': 'timeline_event_time_check_in',
  'time.check_out': 'timeline_event_time_check_out',
  'task.completed': 'timeline_event_task_completed',
  'dispatch.plan_sent': 'timeline_event_dispatch_plan_sent',
  'sales.stage_changed': 'timeline_event_sales_stage_changed',
  'shift.review_approved': 'timeline_event_shift_review_approved',
  'team.profile_updated': 'timeline_event_team_profile_updated',
  'time.adjustment_created': 'timeline_event_time_adjustment_created',
}

const localeByLang = {
  ru: 'ru-RU',
  en: 'en-US',
  es: 'es-ES',
} as const

function localDateKey(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatTime(iso: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso))
}

export default function Timeline() {
  const { t, lang } = useI18n()
  const [filter, setFilter] = useState<TimelineFilter>('all')
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [events, setEvents] = useState<TimelineEventRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const activeFilter = filters.find((item) => item.key === filter) ?? filters[0]

  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      setError(false)
      try {
        const rows = await getTimelineEvents(limit, activeFilter.prefix)
        if (mounted) setEvents(rows)
      } catch {
        if (mounted) {
          setEvents([])
          setError(true)
        }
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [activeFilter.prefix, limit])

  const grouped = useMemo(() => {
    const today = new Date()
    const yesterday = new Date()
    yesterday.setDate(today.getDate() - 1)
    const todayKey = localDateKey(today)
    const yesterdayKey = localDateKey(yesterday)
    const groups: Array<{ key: string; label: string; rows: TimelineEventRow[] }> = []
    const byKey = new Map<string, { key: string; label: string; rows: TimelineEventRow[] }>()

    for (const event of events) {
      const date = new Date(event.created_at)
      const key = localDateKey(date)
      let group = byKey.get(key)
      if (!group) {
        const label = key === todayKey
          ? t('timeline_today')
          : key === yesterdayKey
            ? t('timeline_yesterday')
            : new Intl.DateTimeFormat(localeByLang[lang], { day: '2-digit', month: 'short', year: 'numeric' }).format(date)
        group = { key, label, rows: [] }
        byKey.set(key, group)
        groups.push(group)
      }
      group.rows.push(event)
    }

    return groups
  }, [events, lang, t])

  const eventLabel = (eventType: string) => {
    const key = eventLabelKeys[eventType]
    return key ? t(key) : eventType
  }

  const selectFilter = (next: TimelineFilter) => {
    setFilter(next)
    setLimit(PAGE_SIZE)
  }

  return (
    <div className="screen timeline-screen">
      <div className="timeline-head">
        <h1>{t('timeline')}</h1>
        <div className="muted">{t('timeline_latest')}</div>
      </div>

      <div className="timeline-filters" aria-label={t('timeline_filters')}>
        {filters.map((item) => (
          <button
            key={item.key}
            className={`timeline-chip ${filter === item.key ? 'active' : ''}`}
            type="button"
            onClick={() => selectFilter(item.key)}
          >
            {t(item.labelKey)}
          </button>
        ))}
      </div>

      {loading && <div className="card center muted">{t('loading')}</div>}
      {error && <p className="error-msg">{t('load_error')}</p>}
      {!loading && !error && events.length === 0 && <div className="card muted">{t('timeline_empty')}</div>}

      {!loading && !error && grouped.length > 0 && (
        <>
          <div className="timeline-list">
            {grouped.map((group) => (
              <section className="timeline-day" key={group.key}>
                <h2 className="timeline-day-title">{group.label}</h2>
                <div className="timeline-feed">
                  {group.rows.map((event) => (
                    <div className="timeline-row" key={event.id}>
                      <time className="timeline-time" dateTime={event.created_at}>{formatTime(event.created_at)}</time>
                      <div className="timeline-entry">
                        <span className="timeline-actor">{event.actor_name || t('timeline_unknown_actor')}</span>
                        <span className="timeline-separator"> · </span>
                        <span className="timeline-label">{eventLabel(event.event_type)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>

          {events.length === limit && (
            <button className="btn ghost timeline-more" type="button" onClick={() => setLimit((value) => value + PAGE_SIZE)}>
              {t('timeline_show_more')}
            </button>
          )}
        </>
      )}
    </div>
  )
}
