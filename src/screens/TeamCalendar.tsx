import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { getProjects, updateProjectDates } from '../lib/api'
import { isManagerWrite, type Project } from '../lib/types'
import { getDeadlineInfo, type TrafficStatus } from './project-hub/status'

// CAL-1a: полноэкранный «Календарь команды». Сетка месяца (Пн–Вс) + авто-плашки для
// ВСЕХ активных проектов: старт (зелёный) из start_date и дедлайн (светофор) из end_date.
// Проекты тянем один раз (getProjects) и раскладываем плашки по дате на клиенте — без N+1.
// DEFERRED CAL-1b: рендер calendar_events, «Добавить в этот день», сплит по ролям, вкладка
// «Доставки и задачи» (здесь — заглушка). Точки расширения оставлены чистыми.

type CalTab = 'calendar' | 'deliveries'
type MarkerKind = 'start' | 'deadline'
interface DayMarker {
  project: Project
  kind: MarkerKind
  status: TrafficStatus
}

const CELLS = 42 // 6 недель × 7 дней

// Локальный ключ дня YYYY-MM-DD (без UTC-сдвига, в отличие от toISOString).
function ymd(d: Date) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function firstOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

// Понедельник на/перед первым числом месяца — начало сетки.
function gridStart(monthCursor: Date) {
  const first = firstOfMonth(monthCursor)
  const offset = (first.getDay() + 6) % 7 // Пн = 0
  return new Date(first.getFullYear(), first.getMonth(), 1 - offset)
}

// Проекция светофора на классы плашки (badge grey/green/amber/red).
function toneClass(status: TrafficStatus) {
  return status === 'neutral' ? 'grey' : status
}

export default function TeamCalendar() {
  const { profile } = useAuth()
  const { t } = useI18n()
  const canWrite = profile ? isManagerWrite(profile.role) : false

  const [tab, setTab] = useState<CalTab>('calendar')
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [monthCursor, setMonthCursor] = useState(() => firstOfMonth(new Date()))
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [projectId, setProjectId] = useState('')
  const [startInput, setStartInput] = useState('')
  const [endInput, setEndInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<'ok' | 'err' | null>(null)

  const load = async () => {
    setLoading(true)
    setError(false)
    try {
      setProjects(await getProjects())
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [profile?.id])

  const todayKey = ymd(new Date())

  // Заголовки дней недели Пн–Вс (локаль браузера, как в существующем Calendar).
  const weekdays = useMemo(() => {
    const monday = new Date(2024, 0, 1) // 1 янв 2024 — понедельник
    return Array.from({ length: 7 }, (_, i) =>
      new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i)
        .toLocaleDateString(undefined, { weekday: 'short' }),
    )
  }, [])

  const days = useMemo(() => {
    const start = gridStart(monthCursor)
    return Array.from({ length: CELLS }, (_, i) =>
      new Date(start.getFullYear(), start.getMonth(), start.getDate() + i),
    )
  }, [monthCursor])

  // Плашки по дню: старт (зелёный) и дедлайн (светофор из getDeadlineInfo). Фильтр from/to
  // ограничивает, какие отметки показываем (по ключу дня — строки YYYY-MM-DD сравнимы).
  const markersByDay = useMemo(() => {
    const map = new Map<string, DayMarker[]>()
    const add = (key: string, marker: DayMarker) => {
      if (from && key < from) return
      if (to && key > to) return
      const list = map.get(key)
      if (list) list.push(marker)
      else map.set(key, [marker])
    }
    for (const project of projects) {
      if (project.start_date) {
        add(project.start_date.slice(0, 10), { project, kind: 'start', status: 'green' })
      }
      if (project.end_date) {
        add(project.end_date.slice(0, 10), { project, kind: 'deadline', status: getDeadlineInfo(project).status })
      }
    }
    return map
  }, [projects, from, to])

  const monthLabel = monthCursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })

  const moveMonth = (direction: -1 | 1) => {
    setMonthCursor((cur) => new Date(cur.getFullYear(), cur.getMonth() + direction, 1))
  }
  const goToday = () => setMonthCursor(firstOfMonth(new Date()))

  const selectProject = (id: string) => {
    setProjectId(id)
    setSaveMsg(null)
    const proj = projects.find((p) => p.id === id)
    setStartInput(proj?.start_date?.slice(0, 10) ?? '')
    setEndInput(proj?.end_date?.slice(0, 10) ?? '')
  }

  const openDay = (key: string) => {
    setSelectedDay(key)
    setSaveMsg(null)
  }

  const saveDates = async () => {
    if (!profile || !projectId || saving) return
    setSaving(true)
    setSaveMsg(null)
    try {
      await updateProjectDates(profile, projectId, {
        start_date: startInput || null,
        end_date: endInput || null,
      })
      setProjects(await getProjects())
      setSaveMsg('ok')
    } catch {
      setSaveMsg('err')
    } finally {
      setSaving(false)
    }
  }

  const selectedMarkers = selectedDay ? markersByDay.get(selectedDay) ?? [] : []

  return (
    <div className="screen team-calendar-screen">
      <h1>📆 {t('team_calendar')}</h1>

      <div className="tabs team-cal-tabs">
        <button className={tab === 'calendar' ? 'active' : ''} onClick={() => setTab('calendar')}>{t('cal_tab_calendar')}</button>
        <button className={tab === 'deliveries' ? 'active' : ''} onClick={() => setTab('deliveries')}>{t('cal_tab_deliveries')}</button>
      </div>

      {tab === 'deliveries' ? (
        // DEFERRED CAL-1b: данные второй вкладки здесь не грузим — только заглушка.
        <div className="card muted center team-cal-stub">{t('cal_deliveries_stub')}</div>
      ) : (
        <>
          <div className="row team-cal-toolbar">
            <div className="row team-cal-monthnav">
              <button className="btn ghost small calendar-nav-btn" aria-label={t('cal_prev_month')} onClick={() => moveMonth(-1)}>←</button>
              <span className="team-cal-month">{monthLabel}</span>
              <button className="btn ghost small calendar-nav-btn" aria-label={t('cal_next_month')} onClick={() => moveMonth(1)}>→</button>
              <button className="btn ghost small" onClick={goToday}>{t('today')}</button>
            </div>
            <div className="team-cal-filter">
              <label>{t('cal_from')}
                <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label>{t('cal_to')}
                <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </label>
            </div>
          </div>

          {error && <p className="error-msg">{t('load_error')}</p>}
          {loading && <div className="card center muted">{t('loading')}</div>}
          {!loading && projects.length === 0 && <div className="card muted">{t('cal_no_projects')}</div>}

          <div className="team-cal-layout">
            <div className="team-cal-main">
              <div className="team-cal-weekdays">
                {weekdays.map((w, i) => <div key={i} className="team-cal-weekday">{w}</div>)}
              </div>
              <div className="team-cal-grid">
                {days.map((day) => {
                  const key = ymd(day)
                  const markers = markersByDay.get(key) ?? []
                  const otherMonth = day.getMonth() !== monthCursor.getMonth()
                  const classes = ['team-cal-cell']
                  if (otherMonth) classes.push('other-month')
                  if (key === todayKey) classes.push('today')
                  if (key === selectedDay) classes.push('selected')
                  return (
                    <button type="button" key={key} className={classes.join(' ')} onClick={() => openDay(key)}>
                      <span className="team-cal-daynum">{day.getDate()}</span>
                      <span className="team-cal-plashki">
                        {markers.map((m, i) => (
                          <span
                            key={i}
                            className={`badge ${toneClass(m.status)} team-cal-plashka`}
                            title={`${m.project.name} · ${m.kind === 'start' ? t('cal_start_marker') : t('cal_deadline_marker')}`}
                          >
                            {m.kind === 'start' ? '▸' : '◆'} {m.project.name}
                          </span>
                        ))}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>

            {selectedDay && (
              <aside className="card team-cal-panel">
                <div className="row team-cal-panel-head">
                  <h2>{new Date(`${selectedDay}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
                  <button className="btn ghost small" aria-label={t('back')} onClick={() => setSelectedDay(null)}>✕</button>
                </div>

                {selectedMarkers.length === 0 && <p className="muted">{t('cal_day_empty')}</p>}
                {selectedMarkers.length > 0 && (
                  <div className="team-cal-panel-markers">
                    {selectedMarkers.map((m, i) => (
                      <div key={i} className="row team-cal-panel-marker">
                        <span className="item-title">{m.project.name}</span>
                        <span className={`badge ${toneClass(m.status)}`}>
                          {m.kind === 'start' ? t('cal_start_marker') : t('cal_deadline_marker')}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                <h3 className="team-cal-editor-title">{t('cal_edit_dates')}</h3>
                {!canWrite ? (
                  <p className="muted">{t('cal_dates_readonly')}</p>
                ) : projects.length === 0 ? (
                  <p className="muted">{t('cal_no_projects')}</p>
                ) : (
                  <div className="team-cal-editor">
                    <label>{t('project')}</label>
                    <select value={projectId} onChange={(e) => selectProject(e.target.value)}>
                      <option value="">{t('cal_pick_project')}</option>
                      {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>

                    {projectId && (
                      <>
                        <div className="row team-cal-editor-quick">
                          <button className="btn ghost small" onClick={() => setStartInput(selectedDay)}>{t('cal_this_day_start')}</button>
                          <button className="btn ghost small" onClick={() => setEndInput(selectedDay)}>{t('cal_this_day_deadline')}</button>
                        </div>
                        <label>{t('cal_start_label')}</label>
                        <input type="date" value={startInput} onChange={(e) => setStartInput(e.target.value)} />
                        <label>{t('cal_end_label')}</label>
                        <input type="date" value={endInput} onChange={(e) => setEndInput(e.target.value)} />
                        <button className="btn" disabled={saving} onClick={saveDates}>{t('cal_save_dates')}</button>
                        {saveMsg === 'ok' && <p className="muted team-cal-save-ok">{t('cal_dates_saved')}</p>}
                        {saveMsg === 'err' && <p className="error-msg">{t('cal_dates_save_failed')}</p>}
                      </>
                    )}
                  </div>
                )}
              </aside>
            )}
          </div>
          {!selectedDay && !loading && <p className="muted team-cal-hint">{t('cal_pick_day_hint')}</p>}
        </>
      )}
    </div>
  )
}
