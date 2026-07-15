import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import {
  getProjects, updateProjectDates,
  getTeamCalendarEvents, createCalendarEvent,
  getAllTasks, getTeam, markMaterialStatus,
  type MaterialStatusAction,
} from '../lib/api'
import { isManagerWrite, type Project, type Profile, type CalendarEvent, type Task } from '../lib/types'
import { getDeadlineInfo, type TrafficStatus } from './project-hub/status'

// CAL-1a: полноэкранный «Календарь команды». Сетка месяца (Пн–Вс) + авто-плашки для
// ВСЕХ активных проектов: старт (зелёный) из start_date и дедлайн (светофор) из end_date.
// Проекты тянем один раз (getProjects) и раскладываем плашки по дате на клиенте — без N+1.
// CAL-1b (this): плашки calendar_events (getTeamCalendarEvents), создатель события в день-панели
// (createCalendarEvent, гейт isManagerWrite), вкладка «Доставки и задачи» (задачи по due_date +
// статус материалов), и СПЛИТ ПО РОЛЯМ («у каждого свой календарь», закон Андрея):
//   manager/admin/owner → всё (проекты + события); worker → только СВОИ задачи и события
//   (assigned_to === profile.id); driver → доставки в первую очередь + свои события.

type CalTab = 'calendar' | 'deliveries'
type EventType = CalendarEvent['event_type']
type MarkerKind = 'start' | 'deadline'

// Единая модель «плашки» ячейки: проектная отметка, событие календаря или задача.
// Дискриминант kind — литерал у каждого варианта (у отметки вид в markerKind), иначе TS
// не сужает union при разборе.
type CellItem =
  | { kind: 'marker'; id: string; project: Project; markerKind: MarkerKind; status: TrafficStatus }
  | { kind: 'event'; id: string; event: CalendarEvent }
  | { kind: 'task'; id: string; task: Task }

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

function markerChipTone(kind: MarkerKind): 'green' | 'red' {
  return kind === 'start' ? 'green' : 'red'
}

function markerChipTime(kind: MarkerKind) {
  return kind === 'start' ? '8:00' : '17:00'
}

function localTimeLabel(iso: string) {
  const d = new Date(iso)
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

function mdLabel(d: Date) {
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

// Тон/иконка плашки события по типу (согласовано с /calendar: inspection = amber).
function eventTone(type: EventType): 'blue' | 'amber' | 'green' {
  if (type === 'inspection') return 'amber'
  if (type === 'delivery') return 'green'
  return 'blue'
}
function eventIcon(type: EventType) {
  switch (type) {
    case 'inspection': return '🔎'
    case 'delivery': return '🚚'
    case 'measure': return '📐'
    case 'meeting': return '👥'
    default: return '📌'
  }
}
function taskIcon(type: Task['task_type']) {
  return type === 'delivery' ? '🚚' : type === 'material' ? '📦' : '✓'
}
function isDeliveryTask(tk: Task) {
  return tk.task_type === 'delivery' || tk.task_type === 'material'
}

export default function TeamCalendar() {
  const { profile } = useAuth()
  const { t } = useI18n()

  // Роль-сплит: manager/admin/owner видят всё (и пишут), worker/driver — своё.
  const canWrite = profile ? isManagerWrite(profile.role) : false
  const canSeeAll = canWrite
  const isDriver = profile?.role === 'driver'
  const myId = profile?.id ?? ''

  const [tab, setTab] = useState<CalTab>('calendar')
  const [projects, setProjects] = useState<Project[]>([])
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [team, setTeam] = useState<Profile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [monthCursor, setMonthCursor] = useState(() => firstOfMonth(new Date()))
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const [selectedDay, setSelectedDay] = useState<string | null>(null)

  // Редактор дат проекта (CAL-1a).
  const [projectId, setProjectId] = useState('')
  const [startInput, setStartInput] = useState('')
  const [endInput, setEndInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<'ok' | 'err' | null>(null)

  // Создатель события (CAL-1b).
  const [evtTitle, setEvtTitle] = useState('')
  const [evtType, setEvtType] = useState<EventType>('meeting')
  const [evtProject, setEvtProject] = useState('')
  const [evtPerson, setEvtPerson] = useState('')
  const [evtStartTime, setEvtStartTime] = useState('09:00')
  const [evtEndTime, setEvtEndTime] = useState('')
  const [evtNotes, setEvtNotes] = useState('')
  const [evtSaving, setEvtSaving] = useState(false)
  const [evtMsg, setEvtMsg] = useState<'ok' | 'err' | 'need' | null>(null)

  const [statusErr, setStatusErr] = useState(false)

  const load = async () => {
    setLoading(true)
    setError(false)
    try {
      // Задачи/команда — best-effort: их сбой (RLS/пусто) не должен ронять календарь → [].
      const [pj, tk, tm] = await Promise.all([
        getProjects(),
        getAllTasks().catch(() => [] as Task[]),
        getTeam().catch(() => [] as Profile[]),
      ])
      setProjects(pj)
      setTasks(tk)
      setTeam(tm)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [profile?.id])

  // Диапазон сетки месяца — для запроса событий (starts_at within grid).
  const gridRange = useMemo(() => {
    const start = gridStart(monthCursor)
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + CELLS)
    return { startISO: start.toISOString(), endISO: end.toISOString() }
  }, [monthCursor])

  // События подгружаем на видимый месяц; error → [] (мягкая деградация, см. api).
  useEffect(() => {
    let alive = true
    getTeamCalendarEvents(gridRange.startISO, gridRange.endISO)
      .then((ev) => { if (alive) setEvents(ev) })
      .catch(() => { if (alive) setEvents([]) })
    return () => { alive = false }
  }, [gridRange.startISO, gridRange.endISO, profile?.id])

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

  // Видимость по роли. Событие: всё для менеджера; иначе только назначенные мне; водителю ещё
  // и доставки. Задача: всё для менеджера; водителю доставки/материалы + свои; остальным — свои.
  const eventVisible = (e: CalendarEvent) => {
    if (canSeeAll) return true
    if (e.assigned_to && e.assigned_to === myId) return true
    if (isDriver && e.event_type === 'delivery') return true
    return false
  }
  const taskVisible = (tk: Task) => {
    if (canSeeAll) return true
    if (isDriver) return isDeliveryTask(tk) || tk.assigned_to === myId
    return tk.assigned_to === myId
  }

  // Плашки по дню: проектные отметки (только менеджеру), события (по роли) и — для НЕ-менеджеров —
  // их задачи по due_date (менеджер видит задачи во вкладке «Доставки и задачи»). Фильтр from/to.
  const itemsByDay = useMemo(() => {
    const map = new Map<string, CellItem[]>()
    const within = (key: string) => (!from || key >= from) && (!to || key <= to)
    const add = (key: string, item: CellItem) => {
      if (!within(key)) return
      const list = map.get(key)
      if (list) list.push(item)
      else map.set(key, [item])
    }
    if (canSeeAll) {
      for (const project of projects) {
        if (project.start_date) {
          add(project.start_date.slice(0, 10), { kind: 'marker', id: `s-${project.id}`, project, markerKind: 'start', status: 'green' })
        }
        if (project.end_date) {
          add(project.end_date.slice(0, 10), { kind: 'marker', id: `d-${project.id}`, project, markerKind: 'deadline', status: getDeadlineInfo(project).status })
        }
      }
    }
    for (const e of events) {
      if (!eventVisible(e)) continue
      add(e.starts_at.slice(0, 10), { kind: 'event', id: `e-${e.id}`, event: e })
    }
    if (!canSeeAll) {
      for (const tk of tasks) {
        if (!tk.due_date || !taskVisible(tk)) continue
        add(tk.due_date.slice(0, 10), { kind: 'task', id: `t-${tk.id}`, task: tk })
      }
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, events, tasks, from, to, canSeeAll, isDriver, myId])

  // Задачи для вкладки «Доставки и задачи», сгруппированные по due_date (без срока — в конце).
  const groupedTasks = useMemo(() => {
    const vis = tasks.filter(taskVisible)
    const groups = new Map<string, Task[]>()
    for (const tk of vis) {
      const key = tk.due_date ? tk.due_date.slice(0, 10) : ''
      const arr = groups.get(key)
      if (arr) arr.push(tk)
      else groups.set(key, [tk])
    }
    const keys = Array.from(groups.keys()).sort((a, b) => {
      if (a === '') return 1
      if (b === '') return -1
      return a < b ? -1 : 1
    })
    return keys.map((k) => ({
      key: k,
      items: groups.get(k)!.slice().sort((x, y) => {
        // Водителю — доставки/материалы первыми внутри дня.
        if (isDriver) return (isDeliveryTask(x) ? 0 : 1) - (isDeliveryTask(y) ? 0 : 1)
        return 0
      }),
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, canSeeAll, isDriver, myId])

  const monthLabel = useMemo(() => {
    const start = firstOfMonth(monthCursor)
    const end = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 0)
    return `${monthCursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })} · ${mdLabel(start)}→${mdLabel(end)}`
  }, [monthCursor])

  const moveMonth = (direction: -1 | 1) => {
    setMonthCursor((cur) => new Date(cur.getFullYear(), cur.getMonth() + direction, 1))
  }
  const goToday = () => setMonthCursor(firstOfMonth(new Date()))
  const resetDates = () => {
    setFrom('')
    setTo('')
  }

  const projectName = (id?: string | null) => (id ? projects.find((p) => p.id === id)?.name ?? '' : '')
  const personName = (id?: string | null) => (id ? team.find((m) => m.id === id)?.name ?? '' : '')

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
    setEvtMsg(null)
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

  // CAL-1b: создать событие календаря на выбранный день. Гейт isManagerWrite (RLS insert тоже).
  const submitEvent = async () => {
    if (!profile || !canWrite || evtSaving || !selectedDay) return
    if (!evtTitle.trim() || !evtStartTime) { setEvtMsg('need'); return }
    setEvtSaving(true)
    setEvtMsg(null)
    try {
      const startsAt = new Date(`${selectedDay}T${evtStartTime}:00`).toISOString()
      const endsAt = evtEndTime ? new Date(`${selectedDay}T${evtEndTime}:00`).toISOString() : null
      await createCalendarEvent(profile, {
        title: evtTitle.trim(),
        event_type: evtType,
        starts_at: startsAt,
        ends_at: endsAt,
        project_id: evtProject || null,
        assigned_to: evtPerson || null,
        permit_number: null,
        inspection_status: null,
        notes: evtNotes.trim() || null,
      })
      setEvtTitle('')
      setEvtNotes('')
      setEvtEndTime('')
      setEvtProject('')
      setEvtPerson('')
      setEvents(await getTeamCalendarEvents(gridRange.startISO, gridRange.endISO))
      setEvtMsg('ok')
    } catch {
      setEvtMsg('err')
    } finally {
      setEvtSaving(false)
    }
  }

  // Отметка статуса материала/доставки (переиспользуем markMaterialStatus, RPC гейтит права).
  const canAct = canWrite || isDriver
  const doStatus = async (task: Task, action: MaterialStatusAction) => {
    setStatusErr(false)
    try {
      await markMaterialStatus(task.id, action)
      setTasks(await getAllTasks().catch(() => tasks))
    } catch {
      setStatusErr(true)
    }
  }

  const renderPlashka = (item: CellItem) => {
    if (item.kind === 'marker') {
      const label = item.markerKind === 'start' ? t('cal_project_start_chip') : t('cal_project_deadline_chip')
      return (
        <span
          key={item.id}
          className={`badge ${markerChipTone(item.markerKind)} team-cal-plashka team-cal-marker-chip`}
          title={`${item.project.name} · ${item.markerKind === 'start' ? t('cal_start_marker') : t('cal_deadline_marker')}`}
        >
          {markerChipTime(item.markerKind)} · {label}
        </span>
      )
    }
    if (item.kind === 'event') {
      const e = item.event
      return (
        <span
          key={item.id}
          className={`badge ${eventTone(e.event_type)} team-cal-plashka`}
          title={`${e.title} · ${t(`event_${e.event_type}`)}`}
        >
          {localTimeLabel(e.starts_at)} · {e.title}
        </span>
      )
    }
    const tk = item.task
    return (
      <span
        key={item.id}
        className={`badge ${isDeliveryTask(tk) ? 'amber' : 'blue'} team-cal-plashka`}
        title={`${tk.title} · ${t(`task_type_${tk.task_type}`)}`}
      >
        {taskIcon(tk.task_type)} {tk.title}
      </span>
    )
  }

  const selItems = selectedDay ? itemsByDay.get(selectedDay) ?? [] : []
  const selMarkers = selItems.filter((i): i is Extract<CellItem, { kind: 'marker' }> => i.kind === 'marker')
  const selEvents = selItems.filter((i): i is Extract<CellItem, { kind: 'event' }> => i.kind === 'event')
  const selTasks = selItems.filter((i): i is Extract<CellItem, { kind: 'task' }> => i.kind === 'task')

  const roleNote = isDriver ? t('cal_role_driver_note') : !canSeeAll ? t('cal_role_worker_note') : null

  const dayLabel = (key: string) =>
    key
      ? new Date(`${key}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
      : t('cal_deliveries_no_due')

  const statusTone = (s: Task['status']) => (s === 'done' ? 'green' : s === 'cancelled' ? 'grey' : 'amber')

  return (
    <div className="screen team-calendar-screen">
      <h1>📆 {t('team_calendar')}</h1>

      <div className="tabs team-cal-tabs">
        <button className={tab === 'calendar' ? 'active' : ''} onClick={() => setTab('calendar')}>{t('cal_tab_calendar')}</button>
        <button className={tab === 'deliveries' ? 'active' : ''} onClick={() => setTab('deliveries')}>{t('cal_tab_deliveries')}</button>
      </div>

      {roleNote && <p className="muted team-cal-rolenote">{roleNote}</p>}

      {tab === 'deliveries' ? (
        // CAL-1b: задачи по due_date (+ материалы/доставки), сгруппированные по дню, по роли.
        <div className="team-cal-deliveries">
          {statusErr && <p className="error-msg">{t('cal_status_save_failed')}</p>}
          {loading && <div className="card center muted">{t('loading')}</div>}
          {!loading && groupedTasks.length === 0 && <div className="card muted">{t('cal_deliveries_empty')}</div>}
          {groupedTasks.map((group) => (
            <div key={group.key || 'no-due'} className="team-cal-delivery-group">
              <h3 className="team-cal-delivery-date">{dayLabel(group.key)}</h3>
              {group.items.map((tk) => (
                <div key={tk.id} className="card team-cal-delivery-row">
                  <div className="row team-cal-delivery-head">
                    <div className="team-cal-delivery-title">
                      <span className="item-title">{taskIcon(tk.task_type)} {tk.title}</span>
                      {tk.project_id && <div className="muted small">{projectName(tk.project_id)}</div>}
                    </div>
                    <div className="team-cal-delivery-badges">
                      <span className={`badge ${isDeliveryTask(tk) ? 'amber' : 'blue'}`}>{t(`task_type_${tk.task_type}`)}</span>
                      <span className={`badge ${statusTone(tk.status)}`}>{t(`task_status_${tk.status}`)}</span>
                    </div>
                  </div>
                  {canAct && isDeliveryTask(tk) && tk.status !== 'done' && tk.status !== 'cancelled' && (
                    <div className="row team-cal-delivery-actions">
                      <button className="btn ghost small" onClick={() => doStatus(tk, 'picked_up')}>{t('cal_mark_picked')}</button>
                      <button className="btn ghost small" onClick={() => doStatus(tk, 'delivered')}>{t('cal_mark_delivered')}</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="team-cal-toolbar">
            <div className="team-cal-monthnav">
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
              <button className="btn ghost small team-cal-reset" disabled={!from && !to} onClick={resetDates}>{t('cal_reset_dates')}</button>
            </div>
          </div>

          {error && <p className="error-msg">{t('load_error')}</p>}
          {loading && <div className="card center muted">{t('loading')}</div>}
          {!loading && projects.length === 0 && events.length === 0 && <div className="card muted">{t('cal_no_projects')}</div>}

          <div className="team-cal-layout">
            <div className="team-cal-main">
              <div className="team-cal-weekdays">
                {weekdays.map((w, i) => <div key={i} className="team-cal-weekday">{w}</div>)}
              </div>
              <div className="team-cal-grid">
                {days.map((day) => {
                  const key = ymd(day)
                  const items = itemsByDay.get(key) ?? []
                  const otherMonth = day.getMonth() !== monthCursor.getMonth()
                  const classes = ['team-cal-cell']
                  if (otherMonth) classes.push('other-month')
                  if (key === todayKey) classes.push('today')
                  if (key === selectedDay) classes.push('selected')
                  const visibleItems = items.slice(0, 3)
                  const countLabel = t('cal_event_count_badge').replace('{n}', String(items.length))
                  return (
                    <button type="button" key={key} className={classes.join(' ')} onClick={() => openDay(key)}>
                      <span className="team-cal-cell-head">
                        <span className="team-cal-daynum">{day.getDate()}</span>
                        {items.length > 0 && <span className="team-cal-count" title={countLabel} aria-label={countLabel}>{items.length}</span>}
                      </span>
                      {items.length > 0 ? (
                        <span className="team-cal-plashki">
                          {visibleItems.map((item) => renderPlashka(item))}
                        </span>
                      ) : (
                        <span className="team-cal-empty">{t('cal_empty_day_caption')}</span>
                      )}
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

                {selItems.length === 0 && <p className="muted">{t('cal_empty_day_caption')}</p>}

                {selMarkers.length > 0 && (
                  <div className="team-cal-panel-markers">
                    {selMarkers.map((m) => (
                      <div key={m.id} className="row team-cal-panel-marker">
                        <span className="item-title">{m.project.name}</span>
                        <span className={`badge ${toneClass(m.status)}`}>
                          {m.markerKind === 'start' ? t('cal_start_marker') : t('cal_deadline_marker')}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {(selEvents.length > 0 || selTasks.length > 0) && (
                  <div className="team-cal-panel-events">
                    {selEvents.map(({ event: e }) => (
                      <div key={e.id} className="team-cal-panel-event">
                        <div className="row">
                          <span className="item-title">{eventIcon(e.event_type)} {e.title}</span>
                          <span className={`badge ${eventTone(e.event_type)}`}>{t(`event_${e.event_type}`)}</span>
                        </div>
                        <div className="muted small">
                          {new Date(e.starts_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                          {e.project_id && ` · ${projectName(e.project_id)}`}
                          {e.assigned_to && ` · ${personName(e.assigned_to)}`}
                        </div>
                        {e.notes && <div className="muted small">{e.notes}</div>}
                      </div>
                    ))}
                    {selTasks.map(({ task: tk }) => (
                      <div key={tk.id} className="team-cal-panel-event">
                        <div className="row">
                          <span className="item-title">{taskIcon(tk.task_type)} {tk.title}</span>
                          <span className={`badge ${statusTone(tk.status)}`}>{t(`task_status_${tk.status}`)}</span>
                        </div>
                        {tk.project_id && <div className="muted small">{projectName(tk.project_id)}</div>}
                      </div>
                    ))}
                  </div>
                )}

                {/* CAL-1b: создатель события на этот день (только менеджер). */}
                <h3 className="team-cal-editor-title">{t('cal_add_event')}</h3>
                {!canWrite ? (
                  <p className="muted">{t('cal_events_readonly')}</p>
                ) : (
                  <div className="team-cal-editor">
                    <label>{t('cal_event_title')}</label>
                    <input value={evtTitle} onChange={(e) => setEvtTitle(e.target.value)} />

                    <label>{t('event_type')}</label>
                    <select value={evtType} onChange={(e) => setEvtType(e.target.value as EventType)}>
                      <option value="meeting">{t('event_meeting')}</option>
                      <option value="inspection">{t('event_inspection')}</option>
                      <option value="measure">{t('event_measure')}</option>
                      <option value="delivery">{t('event_delivery')}</option>
                      <option value="other">{t('event_other')}</option>
                    </select>

                    <label>{t('project')}</label>
                    <select value={evtProject} onChange={(e) => setEvtProject(e.target.value)}>
                      <option value="">{t('cal_event_no_project')}</option>
                      {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>

                    <label>{t('cal_event_person')}</label>
                    <select value={evtPerson} onChange={(e) => setEvtPerson(e.target.value)}>
                      <option value="">{t('cal_event_no_person')}</option>
                      {team.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>

                    <div className="row team-cal-editor-times">
                      <label>{t('cal_event_start')}
                        <input type="time" value={evtStartTime} onChange={(e) => setEvtStartTime(e.target.value)} />
                      </label>
                      <label>{t('cal_event_end')}
                        <input type="time" value={evtEndTime} onChange={(e) => setEvtEndTime(e.target.value)} />
                      </label>
                    </div>

                    <label>{t('cal_event_notes')}</label>
                    <textarea value={evtNotes} onChange={(e) => setEvtNotes(e.target.value)} rows={2} />

                    <button className="btn" disabled={evtSaving} onClick={submitEvent}>{t('cal_event_create')}</button>
                    {evtMsg === 'ok' && <p className="muted team-cal-save-ok">{t('cal_event_created')}</p>}
                    {evtMsg === 'need' && <p className="error-msg">{t('cal_event_need_title')}</p>}
                    {evtMsg === 'err' && <p className="error-msg">{t('cal_event_create_failed')}</p>}
                  </div>
                )}

                {/* CAL-1a: редактор дат проекта. */}
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
